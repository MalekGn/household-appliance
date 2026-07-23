# Architecture

## Overview

paymentSchedule is a **Tauri 2** desktop app: a Rust **core process** owns all state
and persistence, and a **Vue 3 WebView** renders the UI. The two communicate
only through typed Tauri **commands** (request/response IPC). The frontend has no
direct database or filesystem access.

```
┌───────────────────────────────────────────────┐
│                WebView (Vue 3)                 │
│  Views ── Pinia stores ── composables          │
│                 │                              │
│         src/api/index.ts (gateway)             │
│         ├─ Tauri: invoke("command", args)      │
│         └─ Browser: src/api/mock.ts (in-mem)   │
└───────────────────│───────────────────────────┘
                    │  IPC (invoke)
┌───────────────────▼───────────────────────────┐
│               Core process (Rust)              │
│  lib.rs ─ commands.rs ─ db.rs ─ seed.rs        │
│               license.rs (gate)                │
│                 │                              │
│    rusqlite  →  payment_schedule.db (SQLite)   │
│    app-data dir  →  logo.<ext>, license.psl    │
└────────────────────────────────────────────────┘
```

At startup the core verifies the license (`license.rs`) and **only manages the
`Db` state when it is valid** — so without a valid certification every data
command fails and the WebView is mounted straight onto the activation lock
(`src/views/LicenseView.vue`) instead of the app shell.

## Frontend (`src/`)

- **`main.ts`** — bootstraps Pinia, vue-i18n, vue-router; loads settings and the
  license status, applies locale/direction, then mounts either the app shell
  (`App.vue`) or, when the license is invalid, only the activation lock
  (`LicenseView.vue`) — so no data screen is reachable behind the gate.
- **`App.vue` + `components/layout/`** — the shell: `AppSidebar`, `AppHeader`,
  content area, and toasts.
- **`views/`** — one component per route (Dashboard, Achats, PurchaseDetail,
  Clients, ClientDetail, Paiements, Echeances, Impayes, Settings, Alertes,
  Rapports, NotFound — the router's catch-all).
- **`components/`** — reusable UI (`ui/`: buttons via CSS, `BaseModal`,
  `StatusBadge`, `KpiCard`, `EmptyState`, `ConfirmDialog`, `AppIcon`,
  `SortHeader`) and feature components (`dashboard/*`, `PaymentModal`,
  `NewPurchaseModal`, `ClientForm`).
- **`stores/`** — Pinia: `settings` (language/currency/date/logo, OS-locale
  detection), `stats` (sidebar badge counters), `ui` (toasts, sidebar toggle,
  header-title override).
- **`composables/`** — `useFormat` (locale-aware money/date/number formatting,
  reactive to the settings store), `useSort` (client-side, direction-toggling
  table sorting driven by `SortHeader`), `useBack` (returns to the real
  previous page, falling back to a list route on a deep link), and
  `useClickOutside` (dismiss popovers/menus — used by the header language menu,
  `DatePicker`, and `DateRangeFilter`). UI filter pieces live in `ui/`:
  `DatePicker` (calendar), `DateRangeFilter` (date popover), `ListFilterBar`
  (reference/client/amount/date bar).
- **`lib/finance.ts`** — pure, unit-tested installment/payment math (the TS
  mirror of `db.rs`), reused by the browser mock.
- **`lib/alerts.ts`** / **`lib/reports.ts`** — pure, unit-tested aggregation
  over the loaded data: `alerts.ts` classifies the schedule for the Alertes
  page; `reports.ts` builds the period-scoped Rapports synthesis (sales,
  collections, outstanding/overdue snapshot, month and client breakdowns).
- **`i18n/`** + **`locales/{ar,fr,en}.json`** — all UI strings; RTL applied via
  `dir="rtl"` on `<html>` for Arabic.
- **`api/`** — `index.ts` is the single typed gateway. It calls Tauri `invoke`
  in the desktop app, or `mock.ts` (a faithful in-memory reimplementation) in a
  plain browser, so previews and tests run without the Rust runtime.

## Backend (`src-tauri/src/`)

- **`lib.rs`** — Tauri builder: registers plugins (os, dialog, fs), opens/seeds
  the DB into managed state, and registers every command.
- **`commands.rs`** — the full API surface (`#[tauri::command]`): clients,
  purchases, installments, payments, impayés, schedule, dashboard, settings,
  logo. Most lock the shared connection and return serde models. `save_text_file`
  is the exception — it takes no DB state and writes UTF-8 to a caller-supplied
  path (the Rapports CSV export), keeping filesystem writes on the backend so
  the JS layer needs no broad `fs` write scope.
- **`db.rs`** — connection wrapper (`Mutex<Connection>`), schema migration,
  and shared date/status/split helpers.
- **`license.rs`** — the certification gate: an embedded Ed25519 public key, the
  machine fingerprint (`sha256` of the OS machine-uid), and `verify_license`
  (signature → machine binding → clock-rollback → validity window). `lib.rs`
  calls it in `setup()`; `commands.rs` exposes `get_license_status`,
  `get_machine_fingerprint`, and `import_license`. See "Licensing" below.
- **`models.rs`** — serde structs (camelCase payloads) shared with the frontend.
- **`seed.rs`** — first-run Tunisian demo data.

## Data model (SQLite)

```
client (1) ──< purchase (1) ──< installment (1) ──< payment
setting (key/value)
```

- FK cascades: deleting a client cascades to its purchases → installments →
  payments. Indices on `purchase.client_id`, `installment.purchase_id`,
  `installment.due_date`, `payment.installment_id`.
- **Money** is stored as whole currency units (`INTEGER`) so the installment
  split is exact. **Dates** are ISO `YYYY-MM-DD` text.
- **Installment status** is derived on read (`paid`/`partial`/`late`/`pending`)
  from `paid_amount`, `amount`, and `due_date` vs today — no scheduled job needed
  to flip installments to "late".

## Key decisions

- **`rusqlite` behind commands** (not `tauri-plugin-sql`) so the requirement
  "all persistence through Rust commands, never direct frontend access" holds.
- **Browser mock backend** keeps the app fully functional without Tauri, which
  enables headless UI verification (Playwright screenshots) and unit tests.
- **Design tokens** (`src/style.css` CSS variables) extracted from the reference
  mockup drive every screen — including the mirrored Arabic RTL layout — for
  visual consistency.

## Licensing (certification gate)

The app is licensed per machine with a due date. Trust is anchored in an
**Ed25519 signature**, not in where the file is stored (the app-data dir is
user-writable and cannot be trusted on its own):

- The **private key never ships**. Licenses are minted offline by the
  `tools/licensegen` CLI (a standalone crate, deliberately outside the app's
  Cargo build). The matching **public key is a compile-time constant** in
  `license.rs` (`LICENSE_PUBLIC_KEY`) — replace the placeholder before shipping.
- A **license file** (`license.psl`, JSON) holds a payload
  (`license_id`, `licensee`, `machine_id_hash`, `issued_at`, `expires_at`) plus a
  base64 signature over the payload's canonical JSON (`serde_json::to_vec`, declared
  field order — the tool and app share the struct definition byte-for-byte).
- **Machine binding**: the license is bound to `sha256(domain || machine-uid)`;
  the raw OS id is never exposed, only the hash (shown on the lock screen).
- **Enforcement is a hard gate**: `lib.rs` opens the DB (to read/advance the
  anti-rollback watermark in `setting.license_last_seen`) but only
  `app.manage(Db)` when the status is `Valid`. Otherwise the DB is unmanaged, so
  every data command errors, and the frontend mounts the lock screen.
- **Anti-clock-rollback**: startup records the newest date seen; a system clock
  earlier than that watermark reports `ClockTampered`.
- **Activation flow**: lock screen shows the machine fingerprint → operator runs
  `licensegen issue --machine-id <hash> --expires <date>` → customer imports the
  `.psl` via the native dialog (`import_license` verifies + stores it) → the app
  reloads so `setup()` re-runs and, now valid, manages the DB.

The frontend gate is UX; the real protection is the Rust signature check.

# QA Report — paymentSchedule

This file is the durable QA record for the project. Each QA pass appends a new
dated section (most recent first). Format per entry: **Summary → Test cases →
Issues found → Recommendations**. See `CLAUDE.md` (Phase 3: QA) for the workflow.

---

## 2026-07-22 — Feature QA: Licensing / certification gate

### Summary

QA pass for the new **machine-bound, time-limited licensing gate**. The app now
refuses to run without a valid, Ed25519-signed certification file (`license.psl`)
bound to the machine fingerprint and a due date. Enforcement is a **hard gate** in
the Rust core (`src-tauri/src/license.rs`): `lib.rs` verifies the license in
`setup()` and only `manage(Db)` when it is `Valid`, so without one every data
command fails and the WebView mounts only the activation lock
(`src/views/LicenseView.vue`) instead of the app shell. Licenses are minted
offline by the standalone `tools/licensegen` CLI (the private key never ships).

The browser mock simulates the gate from `?mockLicense=<status>` + a localStorage
unlock flag, so the lock → import → unlock flow is drivable in the mock-backed
suites; the authoritative crypto is covered by Rust unit tests. All suites
**executed** this pass — all green.

### Test cases — RUN

Rust unit — `src-tauri` `cargo test` (13 new license cases): **16/16 passed**.
- Signature: a valid license passes; a foreign-key signature, a tampered payload, and the shipped placeholder key all report `BadSignature` (fails closed).
- Validity window is inclusive on both bounds; past the due date → `Expired`; before issue → `NotYetValid`.
- Machine binding: a different `machine_id_hash` → `WrongMachine`.
- Anti-rollback: a clock earlier than the recorded watermark → `ClockTampered`; at/after it → valid.
- Malformed JSON → `Malformed`; the status DTO carries licensee/dates for authentic files.

Frontend unit — `src/stores/license.test.ts` (5 cases, `npm test`): **50/50 passed** overall.
- `isValid` tracks the backend `valid` flag; an expired status stays locked and exposes its dates; a successful import flips the store to valid; a rejected import (wrong machine) does not unlock.

Integration — `tests/integration/license-gate.integration.test.ts` (5 cases, `npm run test:integration`): **35/35 passed** overall.
- A `missing` license reports invalid via the `api` facade and keeps the store locked; the machine fingerprint is always available.
- Import flips the api status to valid and the unlock persists across a simulated reload; the store transitions locked → valid.
- An `expired` license stays invalid and surfaces its expiry date rather than unlocking.

E2E — `tests/e2e/run.mjs` (3 new license cases, `npm run test:e2e`): **28/28 passed**, no browser console errors.
- An invalid certification shows the activation lock with the machine ID and **no** app shell / sidebar behind it.
- Clicking **Import license file** activates the mock and reloads into the full app shell (9 sidebar items); the lock screen is dismissed.
- An expired certification stays locked with an expiry message.

### Issues found

None. `vue-tsc --noEmit` clean; `cargo build` warning-free.

### Recommendations

- **Before shipping**, replace the placeholder `LICENSE_PUBLIC_KEY` in
  `src-tauri/src/license.rs` with a real key from `licensegen keygen` (the
  placeholder verifies nothing, so every license is rejected — the app fails
  closed until the key is embedded). This is the one manual release step.
- The true desktop crypto path (real `license.psl` on disk, machine-uid binding)
  is exercised by the Rust unit tests; a WebDriver/tauri-driver E2E against a
  real bundle would be the next increment but needs a platform-specific driver
  and a build signed with a test key — out of scope for this pass.

---

## 2026-07-22 — Feature QA: Rapports (reports) page

### Summary

QA pass for the newly implemented **Rapports** page (`src/views/RapportsView.vue`),
which replaced the styled placeholder. The page loads three backend read models
— `api.listPurchases()`, `api.listAllPayments()`, `api.listSchedule()` — and
folds them through the pure `buildReport` aggregator (`src/lib/reports.ts`). It
renders a period bar (quick presets *this month / this year / all* + two
`DatePicker`s), a four-KPI row (period sales & collections, plus a current
outstanding & overdue *snapshot*), and two sortable breakdown cards (month-by-
month and per-client). A CSV export dumps the summary + both breakdowns.

Added integration and E2E coverage and **executed all suites** (unit,
integration, E2E) — the user requested execution. All green.

### Test cases — RUN

Unit — `src/lib/reports.test.ts` (9 cases, `npm test`): **45/45 passed** overall.
- Period scoping is inclusive on both bounds; empty bounds mean unbounded.
- Outstanding/overdue read the whole schedule (snapshot), independent of the period; overdue counts only past-due, still-owed tranches.
- Month breakdown is continuous and zero-fills quiet months; clients rank by collections then sales; empty dataset yields no month/client rows.

Integration — `tests/integration/reports.integration.test.ts` (11 cases, `npm run test:integration`): **30/30 passed** overall.
- All-time report reconciles with the dashboard on sales count/total, collected total, outstanding, and overdue count; overdue money matches the impayés grand total.
- Internal consistency: month rows and client rows each sum back to the headline sales/collected totals; the client set equals the clients that have purchases; each client's collected total matches its `listPaymentsForClient` ledger.
- Period window: a pre-history window zeroes sales/collections but leaves the outstanding/overdue snapshot intact; narrowing the window is monotonic and matches a hand-rolled filter.
- Mutations propagate: a full payment on an overdue tranche raises collected and lowers outstanding + overdue by the amount (count −1); creating a purchase adds one sale to the totals, its month bucket, and its client row.

E2E — `tests/e2e/run.mjs` (5 new Rapports cases, `npm run test:e2e`): **25/25 passed**, no browser console errors.
- Four KPI cards render; default preset is *Tout*; all-time sales total = 14 700 (the 8 seeded purchases) and the sub mentions 8 purchases.
- The *Ce mois-ci* preset narrows sales to the single today-dated seed purchase (900).
- Monthly and per-client breakdown tables render (6 client rows — every seeded client has a purchase).
- CSV export button present while data exists.
- Sorting the client table by *Encaissé* reorders ascending then descending.

### Issues found

None. One defect was found and fixed **in the test code** during the pass (the
mutation test dereferenced the report helper's wrapper object directly instead
of its `.report` field); no product defect. `vue-tsc --noEmit` is clean.

### Recommendations

- Sales/collections are period-bound while outstanding/overdue are a live
  snapshot — the KPI subtitles label this ("Owed to date"), but it is worth
  keeping in mind when reading a historical window: those two tiles always
  reflect *now*, not the selected period.
- The month span is derived from the data's own activity, so a wide preset over
  a sparse dataset can show many zero-filled months. Acceptable today; if data
  grows, consider clamping the breakdown to the selected window.
- Export is CSV only; a per-purchase or PDF export was out of scope for this
  pass and remains a possible follow-up.

---

## 2026-07-22 — Feature QA: Alertes (alerts center) page

### Summary

QA pass for the newly implemented **Alertes** page (`src/views/AlertesView.vue`),
which replaced the styled placeholder. The page consolidates every *actionable*
installment — overdue, due today, or due within 7 days — derived from
`api.listSchedule()` through the pure `buildAlerts` classifier
(`src/lib/alerts.ts`). It renders three summary tiles (count + total per kind,
clickable to filter), status tabs, the shared `ListFilterBar`, and a sortable
table with a days-late / due-in "timing" column; rows link to the purchase.

Added integration and E2E coverage and **executed all suites** (unit,
integration, E2E) — the user requested execution. All green.

### Test cases — RUN

Unit — `src/lib/alerts.test.ts` (9 cases, `npm test`): **36/36 passed** overall.
- `classifyAlert` boundaries against a fixed `today`: overdue (positive days late), due-today (0 days), due-soon (days remaining).
- Horizon edge: last day inside the window is `dueSoon`, the day after is dropped; custom horizon respected.
- Fully-paid past-due rows are ignored; partially-paid overdue rows still alert with the correct `remaining`.
- `buildAlerts` keeps only actionable rows in input order and returns `[]` when nothing qualifies.

Integration — `tests/integration/alerts.integration.test.ts` (4 cases, `npm run test:integration`): **17/17 passed** overall.
- Derived alerts are all unpaid, in-window, and their `days`/`kind` match `dayDiff(dueDate, today)`.
- Overdue-alert count equals `dashboard.stats.overdueCount`.
- Overdue alerts match `listImpayes` exactly — same installment-id set and same summed remaining total.
- Settling an overdue tranche in full removes it from the model and shrinks the overdue set by one.

E2E — `tests/e2e/run.mjs`, 4 new Alertes scenarios (`npm run test:e2e`): **20/20 passed, 0 console errors**.
- Three summary tiles render; on the default "all" tab the table row count equals the summed tile counts.
- The overdue tile value equals the sidebar warning badge (both = overdue installment count).
- Clicking the Overdue tile activates the "En retard" tab, narrows rows to the overdue count, and every visible row shows an overdue timing + late-row highlight.
- Clicking a row navigates to the matching purchase-detail page (header title = purchase reference).

### Issues found

None. No product defects surfaced; type-check (`vue-tsc --noEmit`) is clean.

### Recommendations

- The 7-day "due soon" horizon is currently a constant (`DEFAULT_SOON_DAYS`). If shop owners want a configurable window, promote it to a setting later — not needed now.
- The E2E table-total invariant (`rows === overdue + dueToday + dueSoon`) is only meaningful while the seed reliably produces overdue rows; the due-today / due-soon buckets may be empty depending on the seed's relative dates, which is expected and not asserted as non-zero.
- `alerts.integration.test.ts` cross-checks the derived model against the dashboard and impayés; if the Rust backend's overdue definition ever diverges from the TS `dayDiff` logic, this suite will catch it.

---

## 2026-07-22 — Bug: overdue (Impayés) page empty under `tauri dev`

### Summary

Investigated a report that the overdue page renders correctly under `npm run dev`
but shows nothing under `npm run tauri dev`. Root cause found and fixed: a
parameter-binding bug in the Rust `build_impayes` command that made the SQL
query fail at runtime whenever **no filter** was applied — which is the default
state on page load. The browser build was immune because it uses the in-memory
mock (`src/api/mock.ts`) instead of the SQLite-backed Tauri command.

### Test cases run

- **Root-cause reproduction** (temporary diagnostic test against the live DB at
  `~/.local/share/tn.paymentschedule/payment_schedule.db`): `build_impayes` with
  the default filter returned `Err("Wrong number of parameters passed to query.
  Got 2, needed 1")` — confirming the command rejected the query and the view
  swallowed it into a blank page. After the fix the same call returned 6 client
  groups / 20 overdue installments, fully serialized.
- **Rust unit suite** (`cargo test`): 3/3 passed, including the new regression
  `commands::tests::build_impayes_binds_params_for_every_filter_combo`, which
  exercises all five filter combinations (none / date_from / date_to / client_id
  / all three) and asserts none error, plus that a seeded DB reports overdue rows.
- **Frontend unit suite** (`npm test`): 27/27 passed (unchanged).

### Issues found

1. **`build_impayes` bound a fixed 4 parameters regardless of the query built** (product bug, fixed).
   - **File:** `src-tauri/src/commands.rs` (`build_impayes`).
   - **Root cause:** the `?2`/`?3`/`?4` placeholders were appended only when the
     matching optional filter was present, but the params vector was always
     built with four entries (`today`, `date_from`, `date_to`, `client_id`), so
     the bound-parameter count didn't match the query's declared placeholders.
     With no filter the query declares only `?1`, so SQLite rejected it.
   - **Symptom:** `list_impayes` (and by extension the dashboard's overdue panel)
     returned an error; `ImpayesView.onMounted` awaits `api.listImpayes()` with no
     `try/catch`, so on rejection `loading` stays `true` and the page renders the
     empty card list with no data and no error — a silent blank.
   - **Fix:** build the params vector in lockstep with the placeholders, pushing a
     value only when its clause is added and numbering `?n` sequentially.
   - **Reproduce (before fix):** `npm run tauri dev` → open **Impayés** → blank
     page despite overdue installments existing in the DB. `npm run dev` shows
     them correctly (mock path).

### Recommendations

- **Surface command errors in the UI.** `ImpayesView` (and any view calling the
  API in `onMounted` without a `catch`) should trap rejections and show an error
  state / toast instead of hanging on `loading = true`. This bug was invisible
  precisely because the error was swallowed. Other views should be audited for
  the same pattern.
- **Add integration coverage against the real command path.** Existing
  `src/views/impayes-overdue.test.ts` and the integration suite exercise the mock
  (`src/api/mock.ts`), so they could not catch a Rust-side SQL defect. Consider a
  Rust-level integration test (like the regression added here) for each command
  that assembles SQL dynamically — `list_impayes`, `list_clients`, and any other
  builder that conditionally appends clauses/params.
- **Prefer named parameters** (`:from`, `:to`, `:client`) over positional `?n`
  for dynamically-assembled queries so a missing clause can't desynchronize the
  binding count.

---

## 2026-07-21 — Full test-suite execution (unit + integration + E2E)

### Summary

Executed all three test layers. Unit and integration suites were green on the
first run. The E2E suite surfaced **one pre-existing test defect** (not a product
bug), which was fixed; the suite is now fully green.

### Test cases run

- **Unit** (`npm test`): 27/27 passed (2 files).
- **Integration** (`npm run test:integration`): 13/13 passed (2 files) — purchase lifecycle + overdue/dashboard/cascade flows.
- **E2E** (`npm run test:e2e`): 16/16 passed after the fix below (initially 15/16).

### Issues found

1. **E2E locator ambiguity — `new purchase: auto-split installments and sum-mismatch validation`** (test defect, fixed).
   - **Symptom:** Playwright strict-mode violation — `getByRole('button', { name: 'Nouvel achat' })` resolved to 2 elements.
   - **Root cause:** the `/achats` page shows two legitimate "Nouvel achat" buttons — a permanent one in the sidebar (`AppSidebar.vue`) and one in the Achats view. The app is correct; the test's locator was under-scoped. Pre-existing (its failure screenshot was already present at session start), not a regression from relocating `e2e/` → `docs/e2e/`.
   - **Fix:** scoped the click to the main region — `page.getByRole("main").getByRole("button", { name: "Nouvel achat" })` in `tests/e2e/run.mjs`.
   - **Reproduce (before fix):** `npm run test:e2e` → the named test fails on the button click.

No product defects found.

### Recommendations

- Wire `npm test`, `npm run test:integration`, and `npm run test:e2e` into CI (in that order) so the E2E stage runs headless on each PR.
- Consider a shared helper for "open the new-purchase modal" so future callers can't re-introduce the ambiguous-locator class of bug.

---

## 2026-07-21 — Integration test suite for the api/backend flows

### Summary

Added an opt-in **integration** test layer that sits between the fast unit tests
(`src/**`) and the browser E2E suite (`tests/e2e/run.mjs`). The new suites drive
the real `api` facade (`src/api/index.ts`) against the in-memory backend
(`src/api/mock.ts`) across multi-command flows, verifying that the api → mockDb →
finance layers stay consistent with one another. The E2E directory was also
relocated from `e2e/` to `docs/e2e/`, and the delivery workflow now mandates
maintaining this report.

Each integration test re-seeds a fresh backend (via `vi.resetModules()`), so the
6-client / 8-purchase seed is identical and isolated per case.

### Test cases — written, NOT run (awaiting confirmation)

Per the QA workflow, integration tests are not executed automatically. Run them
with `npm run test:integration`.

`tests/integration/purchase-lifecycle.integration.test.ts`
- Auto-split of a total across installments matches `splitAmounts` (1000/3 → 333/333/334) and starts fully `pending`.
- Caller-supplied uneven split is honoured when the amounts sum to the total.
- Explicit split whose amounts don't sum to the total is rejected (`SUM_MISMATCH`).
- Installment status transitions pending → partial → paid; purchase moves pending → in_progress.
- Purchase flips to `paid` once every installment is settled; payment ledger totals reconcile.
- Non-positive payment amount is rejected (`INVALID_AMOUNT`).
- Creating a purchase and paying it bumps the dashboard's purchase/sales/collected/outstanding aggregates correctly.

`tests/integration/overdue-dashboard.integration.test.ts`
- Dashboard aggregates reconcile with `listImpayes`, `listClients`, `listPurchases`, `listAllPayments` on the seed.
- `ImpayeFilter` by `clientId` narrows to one client and preserves that client's installments.
- Impossible date window yields an empty overdue list.
- Paying an overdue installment in full removes it from impayés and decrements the dashboard overdue count.
- Unforced delete of a client with purchases is refused (`CLIENT_HAS_PURCHASES:n`) and mutates nothing.
- Forced delete cascades: client, its purchases, and its overdue rows disappear; dashboard purchase count updates.

### Issues found

None — this pass added coverage; no product defects were surfaced (tests not yet executed).

### Recommendations

- Execute `npm run test:integration` to confirm the suites pass, then wire both `npm test` and `npm run test:integration` into CI ahead of the Playwright E2E stage.
- Consider a component-level integration layer (mounting filterable list views with Pinia + i18n) if UI-wiring regressions become a concern; current integration coverage stops at the api facade.

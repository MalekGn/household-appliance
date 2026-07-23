// Integration suite — the licensing (certification) gate, browser side.
//
// The desktop app enforces licensing in Rust (verifying a signed license file
// against an embedded public key). In a plain browser the mock backend
// (src/api/mock.ts) simulates that gate from a `?mockLicense=<status>` query
// param plus a localStorage unlock flag, so the whole lock → import → unlock
// flow can be driven through the *real* `@/api` facade (outside Tauri
// `isTauri()` is false, so every call resolves against the mock). These tests
// pin that simulation and the license store's verdict — the same verdict
// `main.ts` uses to decide whether to mount the app or the activation lock.
//
// Run with:  npm run test:integration   (NOT part of the default `npm test`).

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

let api: typeof import("@/api").api;
let useLicenseStore: typeof import("@/stores/license").useLicenseStore;

/** Set (or clear) the `?mockLicense=…` query the mock reads, same-origin. */
function setLicenseQuery(query: string) {
  window.history.replaceState(null, "", query ? `?mockLicense=${query}` : window.location.pathname);
}

beforeEach(async () => {
  localStorage.clear();
  setLicenseQuery("");
  vi.resetModules();
  setActivePinia(createPinia());
  ({ api } = await import("@/api"));
  ({ useLicenseStore } = await import("@/stores/license"));
});

describe("a fresh install with no certification is locked", () => {
  it("reports a missing, invalid license via the api facade", async () => {
    setLicenseQuery("missing");
    const status = await api.getLicenseStatus();
    expect(status.status).toBe("missing");
    expect(status.valid).toBe(false);
    // The machine fingerprint is always available so the operator can request one.
    expect(status.machineId.length).toBeGreaterThan(0);
    expect(await api.getMachineFingerprint()).toBe(status.machineId);
  });

  it("keeps the license store invalid, which gates the app mount", async () => {
    setLicenseQuery("missing");
    const store = useLicenseStore();
    await store.load();
    expect(store.loaded).toBe(true);
    expect(store.isValid).toBe(false);
  });
});

describe("importing a valid certification unlocks the app", () => {
  it("flips the api status to valid and persists across the reload", async () => {
    setLicenseQuery("missing");
    expect((await api.getLicenseStatus()).valid).toBe(false);

    const imported = await api.importLicense("mock://license.psl");
    expect(imported.valid).toBe(true);
    expect(imported.status).toBe("valid");

    // Simulate the reload the activation screen triggers: even with the same
    // `?mockLicense=missing` URL still present, the persisted unlock keeps the
    // app licensed (mirrors setup() re-running and finding a valid license).
    const afterReload = await api.getLicenseStatus();
    expect(afterReload.valid).toBe(true);
  });

  it("drives the license store from locked to valid", async () => {
    setLicenseQuery("missing");
    const store = useLicenseStore();
    await store.load();
    expect(store.isValid).toBe(false);

    await store.importFromPath("mock://license.psl");
    expect(store.isValid).toBe(true);
    expect(store.status?.status).toBe("valid");
  });
});

describe("an expired certification stays locked", () => {
  it("is invalid and surfaces the expiry date rather than unlocking", async () => {
    setLicenseQuery("expired");
    const status = await api.getLicenseStatus();
    expect(status.valid).toBe(false);
    expect(status.status).toBe("expired");
    expect(status.expiresAt).toBeTruthy();
  });
});

// Unit tests for the license store — the frontend half of the certification
// gate. The store just reflects the backend's verdict, so these tests pin down
// that `isValid` tracks the `valid` flag and that import updates the state.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import type { LicenseStatusDto } from "@/types/models";

// Mock the api gateway so we can drive arbitrary statuses (the real mockDb
// always reports "valid").
const getLicenseStatus = vi.fn<() => Promise<LicenseStatusDto>>();
const importLicense = vi.fn<(p: string) => Promise<LicenseStatusDto>>();
vi.mock("@/api", () => ({
  api: {
    getLicenseStatus: () => getLicenseStatus(),
    importLicense: (p: string) => importLicense(p),
  },
}));

import { useLicenseStore } from "./license";

function dto(over: Partial<LicenseStatusDto>): LicenseStatusDto {
  return {
    status: "missing",
    valid: false,
    licensee: null,
    issuedAt: null,
    expiresAt: null,
    machineId: "abc123",
    ...over,
  };
}

describe("useLicenseStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    getLicenseStatus.mockReset();
    importLicense.mockReset();
  });

  it("starts unloaded with no status", () => {
    const store = useLicenseStore();
    expect(store.loaded).toBe(false);
    expect(store.status).toBeNull();
    expect(store.isValid).toBe(false);
  });

  it("is valid only when the backend reports valid", async () => {
    getLicenseStatus.mockResolvedValue(dto({ status: "valid", valid: true }));
    const store = useLicenseStore();
    await store.load();
    expect(store.loaded).toBe(true);
    expect(store.isValid).toBe(true);
    expect(store.status?.machineId).toBe("abc123");
  });

  it("stays locked for an expired license and exposes its dates", async () => {
    getLicenseStatus.mockResolvedValue(
      dto({ status: "expired", valid: false, licensee: "Shop", expiresAt: "2025-01-01" }),
    );
    const store = useLicenseStore();
    await store.load();
    expect(store.isValid).toBe(false);
    expect(store.status?.status).toBe("expired");
    expect(store.status?.expiresAt).toBe("2025-01-01");
  });

  it("updates state after a successful import", async () => {
    getLicenseStatus.mockResolvedValue(dto({ status: "missing" }));
    importLicense.mockResolvedValue(dto({ status: "valid", valid: true }));
    const store = useLicenseStore();
    await store.load();
    expect(store.isValid).toBe(false);

    const result = await store.importFromPath("/tmp/license.psl");
    expect(importLicense).toHaveBeenCalledWith("/tmp/license.psl");
    expect(result.valid).toBe(true);
    expect(store.isValid).toBe(true);
  });

  it("reflects a rejected import without unlocking", async () => {
    getLicenseStatus.mockResolvedValue(dto({ status: "missing" }));
    importLicense.mockResolvedValue(dto({ status: "wrong_machine", valid: false }));
    const store = useLicenseStore();
    await store.load();
    await store.importFromPath("/tmp/other.psl");
    expect(store.isValid).toBe(false);
    expect(store.status?.status).toBe("wrong_machine");
  });
});

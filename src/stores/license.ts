import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { api } from "@/api";
import type { LicenseStatusDto } from "@/types/models";

/**
 * Certification/license gate state. Loaded once at startup (see `main.ts`),
 * which decides whether to mount the full app or the activation lock screen.
 * The authoritative check lives in the Rust backend; this store only reflects
 * its verdict and drives the lock UI.
 */
export const useLicenseStore = defineStore("license", () => {
  const status = ref<LicenseStatusDto | null>(null);
  const loaded = ref(false);

  const isValid = computed(() => status.value?.valid === true);

  async function load() {
    status.value = await api.getLicenseStatus();
    loaded.value = true;
    return status.value;
  }

  /** Import a picked license file; returns the resulting status. */
  async function importFromPath(sourcePath: string) {
    status.value = await api.importLicense(sourcePath);
    return status.value;
  }

  return { status, loaded, isValid, load, importFromPath };
});

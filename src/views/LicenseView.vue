<script setup lang="ts">
// Full-screen activation / certification lock. Mounted as the app root (instead
// of the shell) whenever the license is not valid — so no data screen or command
// is reachable behind it. On a successful activation the app reloads so the Rust
// backend re-runs its startup gate and opens the database.
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { isTauri } from "@/api";
import { useLicenseStore } from "@/stores/license";
import type { LicenseStatusCode } from "@/types/models";

const { t } = useI18n();
const license = useLicenseStore();

const busy = ref(false);
const activated = ref(false);
const errorMsg = ref<string | null>(null);
const copied = ref(false);

const machineId = computed(() => license.status?.machineId ?? "");
const statusCode = computed<LicenseStatusCode>(() => license.status?.status ?? "missing");
const expiresAt = computed(() => license.status?.expiresAt ?? null);
const licensee = computed(() => license.status?.licensee ?? null);

// A localized explanation for the current status. Unknown codes fall back to
// the generic "missing" copy.
const statusMessage = computed(() => t(`license.status.${statusCode.value}`));

// Whether the current status is a hard rejection (vs. simply "no file yet").
const isRejection = computed(() =>
  ["malformed", "bad_signature", "wrong_machine", "not_yet_valid", "expired", "clock_tampered"].includes(
    statusCode.value,
  ),
);

onMounted(async () => {
  // Ensure we have a fingerprint even if the initial load only had a status.
  if (!machineId.value) {
    try {
      await license.load();
    } catch {
      /* leave the screen usable; import can still be attempted */
    }
  }
});

async function copyMachineId() {
  try {
    await navigator.clipboard.writeText(machineId.value);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    /* clipboard may be unavailable; the id is shown on screen anyway */
  }
}

async function pickAndImport() {
  errorMsg.value = null;

  // Pick the license file. On the desktop app this is the native dialog; in a
  // plain browser (preview / e2e) there is no dialog, so the mock backend
  // simulates the activation from a sentinel path.
  let selected: string | null = null;
  if (isTauri()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      multiple: false,
      filters: [{ name: "License", extensions: ["psl", "json"] }],
    });
    selected = typeof picked === "string" ? picked : null;
  } else {
    selected = "mock://license.psl";
  }
  if (!selected) return;

  busy.value = true;
  try {
    const result = await license.importFromPath(selected);
    if (result.valid) {
      activated.value = true;
      // Reload so the Rust setup() re-evaluates and manages the DB.
      setTimeout(() => window.location.reload(), 1200);
    }
    // Non-valid statuses (e.g. expired, wrong machine) surface via statusMessage.
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="lock" data-testid="license-lock">
    <div class="lock-card">
      <div class="lock-badge" :class="{ ok: activated }" aria-hidden="true">
        {{ activated ? "✓" : "🔒" }}
      </div>

      <h1 class="lock-title">{{ t("license.title") }}</h1>

      <template v-if="activated">
        <p class="lock-lead ok">{{ t("license.activated") }}</p>
      </template>

      <template v-else>
        <p class="lock-lead" :class="{ warn: isRejection }">{{ statusMessage }}</p>

        <div v-if="licensee || expiresAt" class="lock-details">
          <div v-if="licensee">
            <span class="lbl">{{ t("license.licensee") }}</span>
            <span>{{ licensee }}</span>
          </div>
          <div v-if="expiresAt">
            <span class="lbl">{{ t("license.expiresAt") }}</span>
            <span>{{ expiresAt }}</span>
          </div>
        </div>

        <div class="lock-machine">
          <span class="lbl">{{ t("license.machineId") }}</span>
          <code class="mono" data-testid="license-machine-id">{{ machineId }}</code>
          <button class="btn-ghost" type="button" @click="copyMachineId">
            {{ copied ? t("license.copied") : t("license.copy") }}
          </button>
        </div>
        <p class="lock-hint">{{ t("license.hint") }}</p>

        <button
          class="btn-primary"
          type="button"
          data-testid="license-import"
          :disabled="busy"
          @click="pickAndImport"
        >
          {{ busy ? t("license.importing") : t("license.import") }}
        </button>

        <p v-if="errorMsg" class="lock-error">{{ errorMsg }}</p>
      </template>
    </div>
  </div>
</template>

<style scoped>
.lock {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--bg);
}
.lock-card {
  width: 100%;
  max-width: 460px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-pop);
  padding: 32px 28px;
  text-align: center;
}
.lock-badge {
  width: 64px;
  height: 64px;
  margin: 0 auto 16px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 28px;
  background: var(--neutral-bg);
}
.lock-badge.ok {
  background: var(--success-bg);
}
.lock-title {
  font-size: 20px;
  font-weight: 700;
  margin: 0 0 8px;
  color: var(--text);
}
.lock-lead {
  margin: 0 0 20px;
  color: var(--text-secondary);
  line-height: 1.5;
}
.lock-lead.warn {
  color: var(--danger-strong);
}
.lock-lead.ok {
  color: var(--success);
  font-weight: 600;
}
.lock-details {
  display: grid;
  gap: 6px;
  margin: 0 0 16px;
  font-size: 13px;
  color: var(--text-secondary);
}
.lock-details .lbl,
.lock-machine .lbl {
  color: var(--text-muted);
  margin-inline-end: 8px;
}
.lock-machine {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 12px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius);
  margin-bottom: 8px;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  word-break: break-all;
  color: var(--text);
  max-width: 100%;
}
.lock-hint {
  font-size: 12px;
  color: var(--text-muted);
  margin: 0 0 20px;
  line-height: 1.5;
}
.btn-primary {
  width: 100%;
  padding: 11px 16px;
  border: none;
  border-radius: var(--radius);
  background: var(--primary);
  color: #fff;
  font-weight: 600;
  font-size: 14px;
  cursor: pointer;
}
.btn-primary:hover:not(:disabled) {
  background: var(--primary-hover);
}
.btn-primary:disabled {
  opacity: 0.6;
  cursor: default;
}
.btn-ghost {
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
}
.btn-ghost:hover {
  background: var(--neutral-bg);
}
.lock-error {
  margin: 12px 0 0;
  color: var(--danger-strong);
  font-size: 13px;
}
</style>

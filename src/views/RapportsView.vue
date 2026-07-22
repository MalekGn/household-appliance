<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import AppIcon from "@/components/ui/AppIcon.vue";
import KpiCard from "@/components/ui/KpiCard.vue";
import EmptyState from "@/components/ui/EmptyState.vue";
import SortHeader from "@/components/ui/SortHeader.vue";
import DatePicker from "@/components/ui/DatePicker.vue";
import { useFormat } from "@/composables/useFormat";
import { useSort } from "@/composables/useSort";
import { api, isTauri } from "@/api";
import { useUiStore } from "@/stores/ui";
import { buildReport, type ClientRow, type MonthRow } from "@/lib/reports";
import { todayIso } from "@/lib/finance";
import type { Payment, PurchaseSummary, ScheduleRow } from "@/types/models";

const { t } = useI18n();
const fmt = useFormat();
const ui = useUiStore();

const purchases = ref<PurchaseSummary[]>([]);
const payments = ref<Payment[]>([]);
const schedule = ref<ScheduleRow[]>([]);
const loading = ref(true);

const today = todayIso();
const dateFrom = ref("");
const dateTo = ref("");

// Quick period presets. "all" clears both bounds (unbounded); the others map to
// the current month / year derived from today's date.
type Preset = "all" | "month" | "year";
const PRESETS: { key: Preset; label: string }[] = [
  { key: "month", label: "rapports.period.month" },
  { key: "year", label: "rapports.period.year" },
  { key: "all", label: "rapports.period.all" },
];

const endOfMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

function applyPreset(preset: Preset) {
  const [y, m] = today.split("-").map(Number);
  if (preset === "all") {
    dateFrom.value = "";
    dateTo.value = "";
  } else if (preset === "month") {
    const mm = String(m).padStart(2, "0");
    dateFrom.value = `${y}-${mm}-01`;
    dateTo.value = `${y}-${mm}-${String(endOfMonth(y, m)).padStart(2, "0")}`;
  } else {
    dateFrom.value = `${y}-01-01`;
    dateTo.value = `${y}-12-31`;
  }
}

// Highlight the preset whose bounds match the current pickers (or none, once the
// user hand-edits a date).
const activePreset = computed<Preset | null>(() => {
  const [y, m] = today.split("-").map(Number);
  const mm = String(m).padStart(2, "0");
  if (!dateFrom.value && !dateTo.value) return "all";
  if (dateFrom.value === `${y}-${mm}-01` && dateTo.value === `${y}-${mm}-${String(endOfMonth(y, m)).padStart(2, "0")}`)
    return "month";
  if (dateFrom.value === `${y}-01-01` && dateTo.value === `${y}-12-31`) return "year";
  return null;
});

const report = computed(() =>
  buildReport(purchases.value, payments.value, schedule.value, dateFrom.value, dateTo.value, today),
);

const hasData = computed(
  () => report.value.sales.count > 0 || report.value.collected.count > 0 || schedule.value.length > 0,
);

const { sort: monthSort, sorted: sortedMonths } = useSort<MonthRow>(
  () => report.value.months,
  {
    month: (m) => m.month,
    sales: (m) => m.salesTotal,
    collected: (m) => m.collectedTotal,
  },
);

const { sort: clientSort, sorted: sortedClients } = useSort<ClientRow>(
  () => report.value.clients,
  {
    client: (c) => c.clientName,
    sales: (c) => c.salesTotal,
    collected: (c) => c.collectedTotal,
  },
);

/** "2026-03" -> localized "March 2026" via the active i18n locale. */
function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

const periodLabel = computed(() => {
  if (!dateFrom.value && !dateTo.value) return t("rapports.period.allLabel");
  const from = dateFrom.value ? fmt.date(dateFrom.value) : "…";
  const to = dateTo.value ? fmt.date(dateTo.value) : "…";
  return `${from} — ${to}`;
});

onMounted(async () => {
  [purchases.value, payments.value, schedule.value] = await Promise.all([
    api.listPurchases(),
    api.listAllPayments(),
    api.listSchedule(),
  ]);
  loading.value = false;
});

// Serialize the currently-displayed report (respecting the active period) to a
// CSV string: a period line, a summary block, then the month and client
// breakdowns. Leads with a BOM so Excel reads the UTF-8 accents/Arabic text.
function buildCsv(): string {
  const r = report.value;
  const lines: string[] = [];
  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;

  lines.push(esc(t("rapports.csv.period")) + "," + esc(periodLabel.value));
  lines.push("");
  // Summary block.
  lines.push(esc(t("rapports.csv.metric")) + "," + esc(t("rapports.csv.count")) + "," + esc(t("rapports.csv.amount")));
  lines.push([esc(t("rapports.kpi.sales")), r.sales.count, r.sales.total].join(","));
  lines.push([esc(t("rapports.kpi.collected")), r.collected.count, r.collected.total].join(","));
  lines.push([esc(t("rapports.kpi.outstanding")), "", r.outstanding].join(","));
  lines.push([esc(t("rapports.kpi.overdue")), r.overdue.count, r.overdue.total].join(","));
  lines.push("");
  // Monthly breakdown.
  lines.push(
    [esc(t("rapports.columns.month")), esc(t("rapports.columns.sales")), esc(t("rapports.columns.collected"))].join(","),
  );
  for (const m of r.months) lines.push([esc(m.month), m.salesTotal, m.collectedTotal].join(","));
  lines.push("");
  // Per-client breakdown.
  lines.push(
    [esc(t("rapports.columns.client")), esc(t("rapports.columns.sales")), esc(t("rapports.columns.collected"))].join(","),
  );
  for (const c of r.clients) lines.push([esc(c.clientName), c.salesTotal, c.collectedTotal].join(","));

  return "﻿" + lines.join("\n");
}

async function exportCsv() {
  const csv = buildCsv();
  const filename = "rapport.csv";

  // Desktop: prompt with the OS-native Save As dialog and let Rust write the
  // file to the chosen path (keeping filesystem access on the backend). In a
  // plain browser (dev preview / tests) fall back to a Blob download.
  if (isTauri()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({
      defaultPath: filename,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (!path) return; // user cancelled the dialog
    await api.saveTextFile(path, csv);
    ui.notify(t("rapports.exported"));
    return;
  }

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
</script>

<template>
  <div class="page">
    <div class="card head-card">
      <div class="card-header">
        <div>
          <h2>{{ t("rapports.title") }}</h2>
          <p class="subtitle">{{ t("rapports.subtitle") }}</p>
        </div>
        <button v-if="hasData" class="btn btn--ghost" type="button" @click="exportCsv">
          <AppIcon name="download" :size="16" /> {{ t("rapports.export") }}
        </button>
      </div>

      <div class="period">
        <div class="tabs">
          <button
            v-for="p in PRESETS"
            :key="p.key"
            class="tab"
            :class="{ 'tab--active': activePreset === p.key }"
            type="button"
            @click="applyPreset(p.key)"
          >
            {{ t(p.label) }}
          </button>
        </div>
        <div class="range">
          <span class="range-label">{{ t("filters.from") }}</span>
          <DatePicker v-model="dateFrom" :max="dateTo || undefined" :placeholder="t('filters.from')" />
          <span class="range-label">{{ t("filters.to") }}</span>
          <DatePicker v-model="dateTo" :min="dateFrom || undefined" :placeholder="t('filters.to')" />
        </div>
      </div>
    </div>

    <div v-if="!loading && !hasData" class="card">
      <EmptyState icon="report" :title="t('rapports.empty')" :hint="t('rapports.emptyHint')" />
    </div>

    <template v-else>
      <div class="kpis">
        <KpiCard
          icon="cart"
          tone="blue"
          :label="t('rapports.kpi.sales')"
          :value="fmt.money(report.sales.total)"
          :sub="t('rapports.kpi.salesSub', report.sales.count)"
        />
        <KpiCard
          icon="banknote"
          tone="green"
          :label="t('rapports.kpi.collected')"
          :value="fmt.money(report.collected.total)"
          :sub="t('rapports.kpi.collectedSub', report.collected.count)"
        />
        <KpiCard
          icon="card"
          tone="purple"
          :label="t('rapports.kpi.outstanding')"
          :value="fmt.money(report.outstanding)"
          :sub="t('rapports.kpi.outstandingSub')"
        />
        <KpiCard
          icon="alert"
          tone="red"
          :label="t('rapports.kpi.overdue')"
          :value="fmt.money(report.overdue.total)"
          :sub="t('rapports.kpi.overdueSub', report.overdue.count)"
        />
      </div>

      <div class="grid">
        <div class="card">
          <div class="card-header">
            <h3>{{ t("rapports.monthly") }}</h3>
          </div>
          <EmptyState
            v-if="report.months.length === 0"
            icon="calendar"
            :title="t('rapports.noActivity')"
          />
          <table v-else class="table">
            <thead>
              <tr>
                <SortHeader :sort="monthSort" field="month" :label="t('rapports.columns.month')" />
                <SortHeader :sort="monthSort" field="sales" :label="t('rapports.columns.sales')" />
                <SortHeader :sort="monthSort" field="collected" :label="t('rapports.columns.collected')" />
              </tr>
            </thead>
            <tbody>
              <tr v-for="m in sortedMonths" :key="m.month">
                <td class="capitalize">{{ monthLabel(m.month) }}</td>
                <td class="tabular">{{ fmt.money(m.salesTotal) }}</td>
                <td class="tabular strong">{{ fmt.money(m.collectedTotal) }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="card">
          <div class="card-header">
            <h3>{{ t("rapports.byClient") }}</h3>
          </div>
          <EmptyState
            v-if="report.clients.length === 0"
            icon="users"
            :title="t('rapports.noActivity')"
          />
          <table v-else class="table">
            <thead>
              <tr>
                <SortHeader :sort="clientSort" field="client" :label="t('rapports.columns.client')" />
                <SortHeader :sort="clientSort" field="sales" :label="t('rapports.columns.sales')" />
                <SortHeader :sort="clientSort" field="collected" :label="t('rapports.columns.collected')" />
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in sortedClients" :key="c.clientId">
                <td>{{ c.clientName }}</td>
                <td class="tabular">{{ fmt.money(c.salesTotal) }}</td>
                <td class="tabular strong">{{ fmt.money(c.collectedTotal) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.subtitle {
  font-size: 13px;
  color: var(--text-muted);
  margin-top: 2px;
  font-weight: 400;
}
.period {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  padding: 0 4px 4px;
}
.tabs {
  display: flex;
  gap: 4px;
  background: var(--bg);
  padding: 4px;
  border-radius: 10px;
}
.tab {
  padding: 7px 14px;
  border: none;
  background: transparent;
  border-radius: 7px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
}
.tab--active {
  background: var(--surface);
  color: var(--primary);
  box-shadow: var(--shadow-card);
}
.range {
  display: flex;
  align-items: center;
  gap: 8px;
}
.range-label {
  font-size: 13px;
  color: var(--text-muted);
  font-weight: 600;
}
.kpis {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 18px;
  align-items: start;
}
.card-header h3 {
  font-size: 15px;
  font-weight: 700;
}
.capitalize {
  text-transform: capitalize;
}
@media (max-width: 1200px) {
  .kpis {
    grid-template-columns: repeat(2, 1fr);
  }
  .grid {
    grid-template-columns: 1fr;
  }
}
</style>

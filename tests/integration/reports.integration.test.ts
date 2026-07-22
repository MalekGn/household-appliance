// Integration suite — the Rapports read model over the real `api` facade.
//
// The Rapports page (src/views/RapportsView.vue) loads three backend read
// models — `api.listPurchases()`, `api.listAllPayments()` and
// `api.listSchedule()` — and folds them through the pure `buildReport`
// aggregator. These tests cross-check that the derived report stays consistent
// with the *other* aggregates the app already trusts (the dashboard counters,
// the impayés list, the per-client payment ledger), that its own internal
// breakdowns reconcile with its headline metrics, and that mutations
// (recording a payment, creating a purchase) propagate into it the way the UI
// expects. Each test runs against a freshly re-seeded in-memory backend reached
// through the real `api` facade.
//
// Run with:  npm run test:integration   (NOT part of the default `npm test`).

import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildReport } from "@/lib/reports";
import { todayIso } from "@/lib/finance";
import type { PurchaseInput } from "@/types/models";

let api: typeof import("@/api").api;

beforeEach(async () => {
  vi.resetModules();
  ({ api } = await import("@/api"));
});

/** Load the three sources and build an all-time report (unbounded period). */
async function allTimeReport() {
  const today = todayIso();
  const [purchases, payments, schedule] = await Promise.all([
    api.listPurchases(),
    api.listAllPayments(),
    api.listSchedule(),
  ]);
  return { report: buildReport(purchases, payments, schedule, "", "", today), purchases, payments, schedule, today };
}

describe("the all-time report reconciles with the dashboard aggregates", () => {
  it("matches sales count/total, collected total and outstanding", async () => {
    const { report } = await allTimeReport();
    const dash = await api.getDashboard();

    expect(report.sales.count).toBe(dash.stats.totalPurchases);
    expect(report.sales.total).toBe(dash.stats.totalSales);
    expect(report.collected.total).toBe(dash.stats.totalCollected);
    expect(report.outstanding).toBe(dash.stats.totalOutstanding);
  });

  it("matches the dashboard on the overdue installment count", async () => {
    const { report } = await allTimeReport();
    const dash = await api.getDashboard();
    expect(report.overdue.count).toBe(dash.stats.overdueCount);
  });

  it("agrees with impayés on the overdue money owed", async () => {
    const { report } = await allTimeReport();
    const impayes = await api.listImpayes();
    const impayeTotal = impayes.reduce((s, c) => s + c.totalOverdue, 0);
    expect(report.overdue.total).toBe(impayeTotal);
  });
});

describe("the report's own breakdowns reconcile with its headline metrics", () => {
  it("month rows sum back to the sales and collected totals", async () => {
    const { report } = await allTimeReport();
    const monthSales = report.months.reduce((s, m) => s + m.salesTotal, 0);
    const monthCollected = report.months.reduce((s, m) => s + m.collectedTotal, 0);
    expect(monthSales).toBe(report.sales.total);
    expect(monthCollected).toBe(report.collected.total);
  });

  it("client rows sum back to the sales and collected totals", async () => {
    const { report } = await allTimeReport();
    const clientSales = report.clients.reduce((s, c) => s + c.salesTotal, 0);
    const clientCollected = report.clients.reduce((s, c) => s + c.collectedTotal, 0);
    expect(clientSales).toBe(report.sales.total);
    expect(clientCollected).toBe(report.collected.total);
  });

  it("lists exactly the clients that have purchases, ranked by collections", async () => {
    const { report, purchases } = await allTimeReport();
    const withPurchases = new Set(purchases.map((p) => p.clientId));
    expect(new Set(report.clients.map((c) => c.clientId))).toEqual(withPurchases);
    // Collected totals are in non-increasing order (the page's default ranking).
    const collected = report.clients.map((c) => c.collectedTotal);
    expect(collected).toEqual([...collected].sort((a, b) => b - a));
  });

  it("matches the per-client payment ledger on each client's collected total", async () => {
    const { report } = await allTimeReport();
    for (const c of report.clients) {
      const ledger = await api.listPaymentsForClient(c.clientId);
      const ledgerTotal = ledger.reduce((s, p) => s + p.amount, 0);
      expect(c.collectedTotal).toBe(ledgerTotal);
    }
  });
});

describe("the period window scopes sales and collections but not the snapshot", () => {
  it("a window before any activity zeroes sales/collected yet keeps the outstanding snapshot", async () => {
    const today = todayIso();
    const [purchases, payments, schedule] = await Promise.all([
      api.listPurchases(),
      api.listAllPayments(),
      api.listSchedule(),
    ]);
    // Every seeded purchase is dated within the last 6 months, so a window that
    // ends in the distant past captures no sales and no payments…
    const report = buildReport(purchases, payments, schedule, "2000-01-01", "2000-12-31", today);
    expect(report.sales).toEqual({ count: 0, total: 0 });
    expect(report.collected).toEqual({ count: 0, total: 0 });
    expect(report.months).toEqual([]);
    expect(report.clients).toEqual([]);
    // …but outstanding/overdue are point-in-time and stay at the full snapshot.
    const dash = await api.getDashboard();
    expect(report.outstanding).toBe(dash.stats.totalOutstanding);
    expect(report.overdue.count).toBe(dash.stats.overdueCount);
  });

  it("narrowing the window never grows the sales set (monotonic)", async () => {
    const today = todayIso();
    const [purchases, payments, schedule] = await Promise.all([
      api.listPurchases(),
      api.listAllPayments(),
      api.listSchedule(),
    ]);
    const all = buildReport(purchases, payments, schedule, "", "", today);
    // A window that only reaches back three months is a strict subset in time.
    const from = threeMonthsAgo(today);
    const recent = buildReport(purchases, payments, schedule, from, today, today);

    expect(recent.sales.count).toBeLessThanOrEqual(all.sales.count);
    expect(recent.sales.total).toBeLessThanOrEqual(all.sales.total);
    // The window matches a hand-rolled filter over the same source.
    const expected = purchases.filter((p) => p.purchaseDate >= from && p.purchaseDate <= today);
    expect(recent.sales.count).toBe(expected.length);
    expect(recent.sales.total).toBe(expected.reduce((s, p) => s + p.totalPrice, 0));
  });
});

describe("mutations propagate into the report", () => {
  it("recording a full payment on an overdue tranche moves collected up and overdue/outstanding down", async () => {
    const before = await allTimeReport();

    // Grab an overdue, still-owed installment straight from the schedule.
    const target = before.schedule.find((s) => s.remaining > 0 && s.dueDate < before.today);
    expect(target).toBeDefined();
    const amount = target!.remaining;

    await api.recordPayment({
      installmentId: target!.installmentId,
      amount,
      paymentDate: before.today,
      note: null,
    });

    const after = await allTimeReport();
    expect(after.report.collected.total).toBe(before.report.collected.total + amount);
    expect(after.report.outstanding).toBe(before.report.outstanding - amount);
    // The tranche is now fully settled, so it leaves the overdue set entirely.
    expect(after.report.overdue.total).toBe(before.report.overdue.total - amount);
    expect(after.report.overdue.count).toBe(before.report.overdue.count - 1);
  });

  it("creating a purchase adds one sale, its price, and one row to its client and month", async () => {
    const before = await allTimeReport();
    const input: PurchaseInput = {
      clientId: 1,
      productLabel: "Aspirateur Dyson",
      totalPrice: 1000,
      installmentCount: 3,
      intervalKind: "monthly",
      intervalDays: null,
      purchaseDate: before.today,
      installments: null,
    };
    await api.createPurchase(input);

    const after = await allTimeReport();
    expect(after.report.sales.count).toBe(before.report.sales.count + 1);
    expect(after.report.sales.total).toBe(before.report.sales.total + 1000);

    // The new sale lands in the current month bucket…
    const monthKey = before.today.slice(0, 7);
    const beforeMonth = before.report.months.find((m) => m.month === monthKey)?.salesTotal ?? 0;
    const afterMonth = after.report.months.find((m) => m.month === monthKey)!.salesTotal;
    expect(afterMonth).toBe(beforeMonth + 1000);

    // …and bumps client 1's sales total by the full price.
    const beforeClient = before.report.clients.find((c) => c.clientId === 1)?.salesTotal ?? 0;
    const afterClient = after.report.clients.find((c) => c.clientId === 1)!.salesTotal;
    expect(afterClient).toBe(beforeClient + 1000);
  });
});

/** ISO date three calendar months before `today` (UTC-stable). */
function threeMonthsAgo(today: string): string {
  const [y, m, d] = today.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1 - 3, d));
  return dt.toISOString().slice(0, 10);
}

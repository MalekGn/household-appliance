import { describe, it, expect } from "vitest";
import { buildReport, monthKey } from "./reports";
import type { Payment, PurchaseSummary, ScheduleRow } from "@/types/models";

const purchase = (over: Partial<PurchaseSummary>): PurchaseSummary => ({
  id: 1,
  reference: "A-1",
  clientId: 1,
  clientName: "Client",
  productLabel: "TV",
  totalPrice: 1000,
  paidAmount: 0,
  remaining: 1000,
  installmentCount: 4,
  purchaseDate: "2026-03-10",
  status: "in_progress",
  overdueCount: 0,
  ...over,
});

const payment = (over: Partial<Payment>): Payment => ({
  id: 1,
  installmentId: 1,
  installmentIndex: 1,
  purchaseId: 1,
  purchaseReference: "A-1",
  clientId: 1,
  clientName: "Client",
  amount: 250,
  paymentDate: "2026-03-15",
  note: null,
  createdAt: "2026-03-15",
  ...over,
});

const sched = (over: Partial<ScheduleRow>): ScheduleRow => ({
  installmentId: 1,
  purchaseId: 1,
  reference: "A-1",
  clientId: 1,
  clientName: "Client",
  index: 1,
  installmentCount: 4,
  dueDate: "2026-03-10",
  amount: 250,
  paidAmount: 0,
  remaining: 250,
  status: "pending",
  ...over,
});

const TODAY = "2026-07-22";

describe("monthKey", () => {
  it("keeps the YYYY-MM prefix", () => {
    expect(monthKey("2026-03-15")).toBe("2026-03");
  });
});

describe("buildReport period scoping", () => {
  it("counts only sales and payments inside [from, to]", () => {
    const purchases = [
      purchase({ id: 1, purchaseDate: "2026-03-10", totalPrice: 1000 }),
      purchase({ id: 2, purchaseDate: "2026-06-01", totalPrice: 2000 }),
      purchase({ id: 3, purchaseDate: "2026-01-01", totalPrice: 500 }), // before window
    ];
    const payments = [
      payment({ id: 1, paymentDate: "2026-03-15", amount: 250 }),
      payment({ id: 2, paymentDate: "2026-06-05", amount: 400 }),
      payment({ id: 3, paymentDate: "2026-12-31", amount: 999 }), // after window
    ];
    const r = buildReport(purchases, payments, [], "2026-02-01", "2026-06-30", TODAY);
    expect(r.sales).toEqual({ count: 2, total: 3000 });
    expect(r.collected).toEqual({ count: 2, total: 650 });
  });

  it("treats empty bounds as unbounded", () => {
    const purchases = [
      purchase({ id: 1, purchaseDate: "2020-01-01", totalPrice: 100 }),
      purchase({ id: 2, purchaseDate: "2030-01-01", totalPrice: 200 }),
    ];
    const r = buildReport(purchases, [], [], "", "", TODAY);
    expect(r.sales).toEqual({ count: 2, total: 300 });
  });

  it("bounds are inclusive", () => {
    const purchases = [purchase({ purchaseDate: "2026-06-30", totalPrice: 700 })];
    const r = buildReport(purchases, [], [], "2026-06-01", "2026-06-30", TODAY);
    expect(r.sales.count).toBe(1);
  });
});

describe("buildReport snapshots", () => {
  it("sums outstanding across the whole schedule regardless of period", () => {
    const schedule = [
      sched({ installmentId: 1, remaining: 250, dueDate: "2026-08-01" }),
      sched({ installmentId: 2, remaining: 300, dueDate: "2026-09-01" }),
    ];
    const r = buildReport([], [], schedule, "2020-01-01", "2020-12-31", TODAY);
    expect(r.outstanding).toBe(550);
  });

  it("counts overdue only when past due and still owed", () => {
    const schedule = [
      sched({ installmentId: 1, remaining: 250, dueDate: "2026-05-01" }), // overdue
      sched({ installmentId: 2, remaining: 0, dueDate: "2026-05-01" }), // paid off
      sched({ installmentId: 3, remaining: 300, dueDate: "2026-08-01" }), // future
    ];
    const r = buildReport([], [], schedule, "", "", TODAY);
    expect(r.overdue).toEqual({ count: 1, total: 250 });
    expect(r.outstanding).toBe(550);
  });
});

describe("buildReport breakdowns", () => {
  it("builds a continuous, zero-filled month span", () => {
    const purchases = [
      purchase({ id: 1, purchaseDate: "2026-01-10", totalPrice: 1000 }),
      purchase({ id: 2, purchaseDate: "2026-03-10", totalPrice: 2000 }),
    ];
    const payments = [payment({ paymentDate: "2026-02-05", amount: 500 })];
    const r = buildReport(purchases, payments, [], "", "", TODAY);
    expect(r.months.map((m) => m.month)).toEqual(["2026-01", "2026-02", "2026-03"]);
    const feb = r.months.find((m) => m.month === "2026-02")!;
    expect(feb.salesTotal).toBe(0);
    expect(feb.collectedTotal).toBe(500);
    const mar = r.months.find((m) => m.month === "2026-03")!;
    expect(mar.salesTotal).toBe(2000);
  });

  it("ranks clients by amount collected, then sales", () => {
    const purchases = [
      purchase({ id: 1, clientId: 1, clientName: "Amine", totalPrice: 1000 }),
      purchase({ id: 2, clientId: 2, clientName: "Bilel", totalPrice: 3000 }),
    ];
    const payments = [
      payment({ id: 1, clientId: 1, clientName: "Amine", amount: 900 }),
      payment({ id: 2, clientId: 2, clientName: "Bilel", amount: 400 }),
    ];
    const r = buildReport(purchases, payments, [], "", "", TODAY);
    expect(r.clients.map((c) => c.clientName)).toEqual(["Amine", "Bilel"]);
    expect(r.clients[0]).toMatchObject({ salesTotal: 1000, collectedTotal: 900 });
  });

  it("returns no months when there is no activity", () => {
    const r = buildReport([], [], [], "", "", TODAY);
    expect(r.months).toEqual([]);
    expect(r.clients).toEqual([]);
  });
});

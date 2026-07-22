// Pure reporting aggregation — framework-free so it can be unit-tested and
// reused wherever a synthesis of the portfolio is needed. Given the same raw
// data the app already loads (purchases, payments, live schedule), it produces
// a period-scoped report: sales made and amounts collected inside [from, to],
// plus a current outstanding/overdue snapshot and per-month / per-client
// breakdowns. Dates are ISO YYYY-MM-DD; money values are whole units.

import type { Payment, PurchaseSummary, ScheduleRow } from "@/types/models";

export interface Metric {
  count: number;
  total: number;
}

export interface MonthRow {
  /** YYYY-MM */
  month: string;
  salesCount: number;
  salesTotal: number;
  collectedCount: number;
  collectedTotal: number;
}

export interface ClientRow {
  clientId: number;
  clientName: string;
  salesTotal: number;
  collectedTotal: number;
}

export interface Report {
  /** Purchases whose purchaseDate falls inside the period. */
  sales: Metric;
  /** Payments whose paymentDate falls inside the period. */
  collected: Metric;
  /** Remaining balance across the whole live schedule (current snapshot). */
  outstanding: number;
  /** Past-due, still-owed installments as of `today` (current snapshot). */
  overdue: Metric;
  /** Continuous month-by-month sales/collections over the spanned period. */
  months: MonthRow[];
  /** Clients active in the period, ranked by amount collected (desc). */
  clients: ClientRow[];
}

/** Inclusive range test; an empty bound means "unbounded on that side". */
function inRange(iso: string, from: string, to: string): boolean {
  if (from && iso < from) return false;
  if (to && iso > to) return false;
  return true;
}

export function monthKey(iso: string): string {
  return iso.slice(0, 7);
}

/** Next YYYY-MM after `key`, rolling the year over at December. */
function nextMonth(key: string): string {
  let [y, m] = key.split("-").map(Number);
  m += 1;
  if (m > 12) {
    m = 1;
    y += 1;
  }
  return `${y}-${String(m).padStart(2, "0")}`;
}

export function buildReport(
  purchases: PurchaseSummary[],
  payments: Payment[],
  schedule: ScheduleRow[],
  from: string,
  to: string,
  today: string,
): Report {
  const sales: Metric = { count: 0, total: 0 };
  const collected: Metric = { count: 0, total: 0 };
  const overdue: Metric = { count: 0, total: 0 };
  let outstanding = 0;

  const months = new Map<string, MonthRow>();
  const clients = new Map<number, ClientRow>();

  const monthOf = (key: string): MonthRow => {
    let row = months.get(key);
    if (!row) {
      row = { month: key, salesCount: 0, salesTotal: 0, collectedCount: 0, collectedTotal: 0 };
      months.set(key, row);
    }
    return row;
  };
  const clientOf = (id: number, name: string): ClientRow => {
    let row = clients.get(id);
    if (!row) {
      row = { clientId: id, clientName: name, salesTotal: 0, collectedTotal: 0 };
      clients.set(id, row);
    }
    return row;
  };

  for (const p of purchases) {
    if (!inRange(p.purchaseDate, from, to)) continue;
    sales.count += 1;
    sales.total += p.totalPrice;
    const mr = monthOf(monthKey(p.purchaseDate));
    mr.salesCount += 1;
    mr.salesTotal += p.totalPrice;
    clientOf(p.clientId, p.clientName).salesTotal += p.totalPrice;
  }

  for (const pay of payments) {
    if (!inRange(pay.paymentDate, from, to)) continue;
    collected.count += 1;
    collected.total += pay.amount;
    const mr = monthOf(monthKey(pay.paymentDate));
    mr.collectedCount += 1;
    mr.collectedTotal += pay.amount;
    clientOf(pay.clientId, pay.clientName).collectedTotal += pay.amount;
  }

  // Outstanding + overdue are point-in-time, so they read the whole live
  // schedule rather than the period — they answer "what is still owed now".
  for (const s of schedule) {
    outstanding += s.remaining;
    if (s.remaining > 0 && s.dueDate < today) {
      overdue.count += 1;
      overdue.total += s.remaining;
    }
  }

  // Emit a continuous month range (zero-filling gaps) so a breakdown chart or
  // table never skips a quiet month. The 600-iteration guard caps the span at
  // 50 years, well beyond any real dataset, in case of bad input.
  const keys = [...months.keys()].sort();
  const monthRows: MonthRow[] = [];
  if (keys.length) {
    const last = keys[keys.length - 1];
    let cur = keys[0];
    for (let i = 0; i < 600 && cur <= last; i++) {
      monthRows.push(monthOf(cur));
      cur = nextMonth(cur);
    }
  }

  const clientRows = [...clients.values()].sort(
    (a, b) => b.collectedTotal - a.collectedTotal || b.salesTotal - a.salesTotal,
  );

  return { sales, collected, outstanding, overdue, months: monthRows, clients: clientRows };
}

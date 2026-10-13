// How a Stock Statement period is put together from the months the daily snapshot holds. Pure functions: no Zoho,
// no Redis, no browser, so the page, the API and the self-test all use the same code.
//
// Zoho's Stock Summary is read once a day, month by month (see stock-snapshot.ts). A period made of whole months
// (a month, a quarter, the year to date, any "1st to last day" range) is then added up from those months:
//   Opening Stock  = the first month's opening
//   Quantity In    = the months' Quantity In added up
//   Quantity Out   = the months' Quantity Out added up
//   Closing Stock and Closing Stock Amount = the last month's closing
// This is exact because every month's closing is the next month's opening (checked SKU by SKU on the real July and
// August reports: 0 breaks in 2,699 SKUs), so nothing is estimated and no figure is changed.

import type { StockRow } from './stock-calculator';
import { STOCK_FIRST_DATE, fyStartYearOf } from './stock-period';

export interface MonthSpan {
  /** "2026-09" */
  ym: string;
  from: string;
  /** the last day of the month, or the day of the refresh for the running month */
  to: string;
}

export interface ListEntry {
  display: string;
  /** the first month-end (or today) at which the product's Closing Stock Amount was above Rs 5,00,000 */
  first: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
const r3 = (x: number) => Math.round(x * 1000) / 1000 + 0; // + 0 turns -0 into 0

/** Every month from April 2026 up to the one that holds `today`; the running month stops at `today`. */
export function monthSpans(today: string): MonthSpan[] {
  const out: MonthSpan[] = [];
  let [y, m] = STOCK_FIRST_DATE.split('-').map(Number);
  for (let i = 0; i < 600; i++) {
    const from = `${y}-${pad(m)}-01`;
    if (from > today) break;
    const end = `${y}-${pad(m)}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
    out.push({ ym: from.slice(0, 7), from, to: end > today ? today : end });
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

export function sameSpans(a: MonthSpan[], b: MonthSpan[]): boolean {
  return a.length === b.length && a.every((x, i) => x.ym === b[i].ym && x.from === b[i].from && x.to === b[i].to);
}

/**
 * The months that make up exactly From..To, or null when these dates are not whole months of the snapshot
 * (then the page reads Zoho for them directly). `to` after the snapshot's day is taken as the snapshot's day.
 */
export function monthsFor(spans: MonthSpan[], from: string, to: string, asOf: string): { months: MonthSpan[]; to: string } | null {
  const effTo = to > asOf ? asOf : to;
  const i = spans.findIndex((m) => m.from === from);
  const j = spans.findIndex((m) => m.to === effTo);
  if (i < 0 || j < 0 || j < i) return null;
  return { months: spans.slice(i, j + 1), to: effTo };
}

/** One list of rows for the whole period, from the rows of each of its months (in order). */
export function composeRows(parts: StockRow[][]): StockRow[] {
  if (parts.length === 1) return parts[0];
  const acc = new Map<string, StockRow>();
  const lastSeen = new Map<string, number>();
  parts.forEach((rows, idx) => {
    for (const r of rows) {
      const cur = acc.get(r.itemId);
      if (!cur) {
        // an item that first shows up after the first month had nothing at the start of the period
        acc.set(r.itemId, { itemId: r.itemId, name: r.name, opening: idx === 0 ? r.opening : 0, qtyIn: r.qtyIn, qtyOut: r.qtyOut, closing: r.closing, closingValue: r.closingValue });
      } else {
        cur.name = r.name;
        cur.qtyIn += r.qtyIn;
        cur.qtyOut += r.qtyOut;
        cur.closing = r.closing;
        cur.closingValue = r.closingValue;
      }
      lastSeen.set(r.itemId, idx);
    }
  });
  const last = parts.length - 1;
  const out: StockRow[] = [];
  for (const row of acc.values()) {
    if (lastSeen.get(row.itemId) !== last) {
      // not in the last month's report: nothing in stock at the end
      row.closing = 0;
      row.closingValue = 0;
    }
    row.opening = r3(row.opening);
    row.qtyIn = r3(row.qtyIn);
    row.qtyOut = r3(row.qtyOut);
    row.closing = r3(row.closing);
    out.push(row);
  }
  return out;
}

/**
 * The year's list of products shown on their own line: every product whose Closing Stock Amount was above
 * Rs 5,00,000 at any month-end of the financial year (or on the day of the refresh, for the running month).
 * Worked out afresh from the month data every day, so a month Zoho has restated is picked up. financial year
 * (named by the calendar year it starts in) -> product key -> its name and the first such month-end.
 */
export function listsFromMonths(months: { from: string; to: string; qualifying: { key: string; name: string }[] }[]): Record<string, Record<string, ListEntry>> {
  const lists: Record<string, Record<string, ListEntry>> = {};
  for (const m of months) {
    const fy = String(fyStartYearOf(m.from));
    const list = (lists[fy] ??= {});
    for (const q of m.qualifying) {
      if (!list[q.key]) list[q.key] = { display: q.name, first: m.to };
    }
  }
  return lists;
}

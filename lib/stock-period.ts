// Dates for the Stock Statement tab. Shared by the page (client) and the API routes (server): nothing in here
// may import server-only code.
//
// On THIS tab a period means exactly its own dates: "September 2026" is 1 Sep to 30 Sep, "Q1 FY27" is 1 Apr to
// 30 Jun, "FY27" is 1 Apr 2026 to 31 Mar 2027 (or to today while the year is still running), and a custom range
// is the From and the To that were picked. (The Debtors and Creditors tabs read a period differently: only its
// end date counts, and everything since the start of the books comes with it.)
//
// The tab starts at FY27. Zoho's opening stock on 1 Apr 2026 is the FY26 closing, which is taken as correct, so
// nothing earlier is offered anywhere.

import { isISODate } from './period';

/** First day the Stock Statement tab can show: the start of FY27. */
export const STOCK_FIRST_DATE = '2026-04-01';

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (y: number, m0: number, d: number) => `${y}-${pad(m0 + 1)}-${pad(d)}`;
/** Last day of a month (m0 = 0 for January). */
const lastDay = (y: number, m0: number) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();

/** The year (April-March) a date falls in, named by the calendar year it starts in: 15 Aug 2026 -> 2026 (FY27). */
export function fyStartYearOf(date: string): number {
  const [y, m] = date.split('-').map(Number);
  return m >= 4 ? y : y - 1;
}
export const fyLabel = (startYear: number) => `FY${String(startYear + 1).slice(-2)}`;
export const fyStartISO = (startYear: number) => `${startYear}-04-01`;
export const fyEndISO = (startYear: number) => `${startYear + 1}-03-31`;

export interface StockPeriod {
  label: string;
  from: string;
  to: string;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Every month from April 2026 up to the current one, newest first. The running month stops at today. */
export function stockMonthOptions(today: string): StockPeriod[] {
  const [ty, tm] = today.split('-').map(Number);
  const out: StockPeriod[] = [];
  let y = ty;
  let m0 = tm - 1;
  for (let i = 0; i < 240; i++) {
    const from = iso(y, m0, 1);
    if (from < STOCK_FIRST_DATE) break;
    const end = iso(y, m0, lastDay(y, m0));
    const running = end > today;
    out.push({ label: `${MONTHS[m0]} ${y}${running ? ' (to date)' : ''}`, from, to: running ? today : end });
    m0 -= 1;
    if (m0 < 0) {
      m0 = 11;
      y -= 1;
    }
  }
  return out;
}

/** Every financial-year quarter that has started, newest first. */
export function stockQuarterOptions(today: string): StockPeriod[] {
  const out: StockPeriod[] = [];
  const currentFy = fyStartYearOf(today);
  for (let fy = currentFy; fy >= fyStartYearOf(STOCK_FIRST_DATE); fy--) {
    for (let q = 3; q >= 0; q--) {
      const m0 = 3 + q * 3; // April, July, October, January
      const startY = m0 >= 12 ? fy + 1 : fy;
      const startM0 = m0 % 12;
      const from = iso(startY, startM0, 1);
      if (from > today || from < STOCK_FIRST_DATE) continue;
      const endM0 = (startM0 + 2) % 12;
      const endY = startM0 + 2 >= 12 ? startY + 1 : startY;
      const end = iso(endY, endM0, lastDay(endY, endM0));
      const running = end > today;
      out.push({ label: `Q${q + 1} ${fyLabel(fy)}${running ? ' (to date)' : ''}`, from, to: running ? today : end });
    }
  }
  return out;
}

/** Every financial year from FY27 on, newest first. The running year stops at today. */
export function stockYearOptions(today: string): StockPeriod[] {
  const out: StockPeriod[] = [];
  for (let fy = fyStartYearOf(today); fy >= fyStartYearOf(STOCK_FIRST_DATE); fy--) {
    const from = fyStartISO(fy);
    const end = fyEndISO(fy);
    const running = end > today;
    out.push({ label: `${fyLabel(fy)}${running ? ' (to date)' : ''}`, from, to: running ? today : end });
  }
  return out;
}

/** What the tab opens on: the running financial year, from 1 April to today. */
export function defaultStockRange(today: string): { from: string; to: string } {
  const y = stockYearOptions(today)[0];
  return { from: y.from, to: y.to };
}

/**
 * Makes a requested range safe: both dates real, inside [1 Apr 2026, today], From never after To.
 * `changed` says whether anything had to be moved (so the page can tell the person).
 */
export function clampStockRange(from: unknown, to: unknown, today: string): { from: string; to: string; changed: boolean } {
  const def = defaultStockRange(today);
  let f = isISODate(from) ? from : def.from;
  let t = isISODate(to) ? to : def.to;
  const before = `${f}|${t}`;
  if (t > today) t = today;
  if (t < STOCK_FIRST_DATE) t = STOCK_FIRST_DATE;
  if (f < STOCK_FIRST_DATE) f = STOCK_FIRST_DATE;
  if (f > t) f = t;
  return { from: f, to: t, changed: before !== `${f}|${t}` || !isISODate(from) || !isISODate(to) };
}

/** "1 Apr 2026" */
export function prettyStockDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  return `${d} ${MONTHS[m - 1].slice(0, 3)} ${y}`;
}

import { Redis } from '@upstash/redis';
import { zohoTry } from './zoho-client';

// EXACT AGE BUCKETS FOR A PAST DATE.
//
// Zoho's AR Aging Summary, run "as of" a past date, lists for every customer
// the invoices that were open ON THAT DAY, split by days past due date
// (not yet due, 1-30, 31-60, ... 151-180, above 180) -- point-in-time figures
// that cannot be rebuilt from today's balances. It is the report the bank
// statement has always been built from, with one known flaw: JN-Clean's
// "payments" make the invoices they were spent on look smaller. So:
//
//   buckets for date D  =  Zoho's aging for D
//                        + JN-Clean spend (applications dated on/before D) added back
//                          to the invoice it was spent on, by that invoice's due date
//                        + non-invoice items: journal debits by journal date,
//                          and any opening balance (old, so ">180")
//
// and the customer's TOTAL is always Zoho's own ledger balance for D. What the
// buckets leave unexplained against that total is shown as a flagged gap
// (too little) or as unapplied credits (too much), never hidden.

export interface AgingRow {
  /** not yet due */
  current: number;
  /** keyed like "days_1-30", "days_151-180", "days_above-180" */
  intervals: Record<string, number>;
  total: number;
}

export interface AgingRecord {
  asOf: string;
  rows: Map<string, AgingRow>;
  /** does the report already include opening-balance invoices? (decided from the data at sync time) */
  includesOpening: boolean;
}

export function splitRow(r: AgingRow): { less: number; more: number } {
  let less = r.current;
  let more = 0;
  for (const [k, v] of Object.entries(r.intervals)) {
    if (/above-180/.test(k)) more += v;
    else less += v;
  }
  return { less, more };
}

/** Finds the per-customer entries (they carry an id and a list of intervals) anywhere in the response. */
export function parseAgingRows(body: unknown): Map<string, AgingRow> {
  const out = new Map<string, AgingRow>();
  const walk = (v: unknown, depth: number) => {
    if (depth > 8 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    const o = v as Record<string, unknown>;
    if (typeof o.id === 'string' && Array.isArray(o.intervals) && 'total' in o) {
      const intervals: Record<string, number> = {};
      for (const it of o.intervals as Record<string, unknown>[]) {
        if (typeof it.interval === 'string') intervals[it.interval] = Number(it.amount) || 0;
      }
      const prev = out.get(o.id);
      const cur = Number(o.sent) || 0; // "sent" = not yet due (the report's Current column)
      if (prev) {
        prev.current += cur;
        prev.total += Number(o.total) || 0;
        for (const [k, a] of Object.entries(intervals)) prev.intervals[k] = (prev.intervals[k] ?? 0) + a;
      } else {
        out.set(o.id, { current: cur, intervals, total: Number(o.total) || 0 });
      }
      return;
    }
    for (const x of Object.values(o)) walk(x, depth + 1);
  };
  walk(body, 0);
  return out;
}

const CANDIDATES = [process.env.ZOHO_REPORT_PATH_ARAGING, 'aragingsummary', 'ar_aging_summary', 'invoiceagingsummary'];

export type AgingFetch =
  | { ok: true; path: string; rows: Map<string, AgingRow> }
  | { ok: false; tried: { path: string; status: number; error: string }[] };

export async function fetchArAging(asOf: string): Promise<AgingFetch> {
  const tried: { path: string; status: number; error: string }[] = [];
  for (const name of CANDIDATES.filter((n): n is string => Boolean(n))) {
    const path = `/reports/${name}`;
    const rows = new Map<string, AgingRow>();
    let failure: string | null = null;
    let status = 200;
    for (let page = 1; page <= 30; page++) {
      const res = await zohoTry(path, {
        aging_by: 'invoiceduedate',
        interval_range: 30,
        interval_type: 'days',
        number_of_columns: 7,
        report_date: asOf,
        to_date: asOf,
        per_page: 500,
        page,
        response_option: 1,
        usestate: 'false',
      });
      if (!res.ok) {
        status = res.status;
        failure = res.error;
        break;
      }
      const got = parseAgingRows(res.body);
      if (got.size === 0 && page === 1) {
        failure = `Responded, but no customer rows found. Body starts: ${JSON.stringify(res.body).slice(0, 300)}`;
        break;
      }
      for (const [id, r] of got) {
        const prev = rows.get(id);
        if (prev) {
          prev.current += r.current;
          prev.total += r.total;
          for (const [k, a] of Object.entries(r.intervals)) prev.intervals[k] = (prev.intervals[k] ?? 0) + a;
        } else rows.set(id, r);
      }
      const pc = (res.body as { page_context?: { has_more_page?: boolean } }).page_context;
      if (!pc?.has_more_page) break;
    }
    if (!failure) return { ok: true, path, rows };
    tried.push({ path, status, error: failure });
  }
  return { ok: false, tried };
}

// ---------------------------------------------------------------- storage

function getClient(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}
const key = (asOf: string) => `rpel-apar:aging:${asOf}`;

interface Stored {
  asOf: string;
  includesOpening: boolean;
  rows: Record<string, AgingRow>;
}

export async function saveAging(rec: AgingRecord): Promise<void> {
  const redis = getClient();
  if (!redis) throw new Error('Redis is not configured, so aging snapshots cannot be stored.');
  const s: Stored = { asOf: rec.asOf, includesOpening: rec.includesOpening, rows: Object.fromEntries(rec.rows) };
  await redis.set(key(rec.asOf), JSON.stringify(s));
}

export async function loadAging(asOf: string): Promise<AgingRecord | null> {
  const redis = getClient();
  if (!redis) return null;
  const s = await redis.get<Stored>(key(asOf));
  if (!s) return null;
  return { asOf, includesOpening: s.includesOpening, rows: new Map(Object.entries(s.rows)) };
}

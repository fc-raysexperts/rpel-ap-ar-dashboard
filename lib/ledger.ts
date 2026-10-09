import { Redis } from '@upstash/redis';
import { zohoTry } from './zoho-client';
import type { RawZohoData } from './zoho-raw-fetch';
import { isExcludedStatus } from './status-filter';

// THE NUMBER OF RECORD. A contact's Statement balance is the ledger: sum of
// Amount minus sum of Payments, which is exactly what Zoho keeps on every
// contact record (outstanding minus unused credits) and what its Customer /
// Vendor Balance reports return as "closing balance". Verified against the
// ledger report for 25 customers (24 to the rupee; the 25th, JSW, differed by
// exactly two invoices created after our cache was read) and against three
// official Statements.
//
// Why not rebuild it from invoices and bills? Because their `balance` fields
// already contain things the Statement nets out (JN-Clean "payments"), and
// the rebuild can only ever be as complete as the document types we think to
// fetch. The ledger has no such blind spots, so totals come from here and the
// document-level data is used for the age buckets and as a cross-check.

export interface LedgerBalances {
  asOf: string;
  /** where the balances came from: contact records (vendors: from the vendor balance report where one was read), or a stored report snapshot for a past date */
  source: 'contact-record' | 'contact-record + vendor-report' | 'report-snapshot';
  /** contact_id -> balance, receivable positive */
  customers: Map<string, number>;
  /** contact_id -> balance, payable positive */
  vendors: Map<string, number>;
}

/** Date (yyyy-mm-dd, India time) on which the cached snapshot was read. */
export function cacheDay(fetchedAt: string): string {
  const ist = new Date(new Date(fetchedAt).getTime() + 5.5 * 3_600_000);
  return ist.toISOString().slice(0, 10);
}

/**
 * The date a request is answered for. The data is read from Zoho once a day, so a date later than the day
 * of the snapshot (the viewer's clock has moved on, but 7 AM has not come round yet) is answered as of the
 * snapshot's own day. Figures and age buckets then stay identical for the whole 24 hours instead of the
 * buckets creeping on at midnight while the balances stand still. Earlier dates are left alone.
 */
export function effectiveAsOf(requested: string, raw: Pick<RawZohoData, 'fetchedAt'>): string {
  const day = cacheDay(raw.fetchedAt);
  return requested > day ? day : requested;
}

/** Per vendor: TDS still withheld on the unused part of their advance payments (rupees). */
export function tdsByVendor(raw: RawZohoData): Map<string, number> {
  const m = new Map<string, number>();
  if (!raw.vendorPaymentTds) return m;
  for (const p of raw.vendorPayments) {
    const t = raw.vendorPaymentTds[p.payment_id];
    if (!t || !(p.unused_amount ?? 0) || isExcludedStatus(p.status)) continue;
    m.set(p.vendor_id, (m.get(p.vendor_id) ?? 0) + t);
  }
  return m;
}

/**
 * Today's ledger per contact.
 *
 * Customers: the contact record (outstanding minus unused credits).
 * Vendors: Zoho's vendor balance report when one was read, else the contact record -- and in both
 * cases the contact record is corrected for TDS on advance payments, which the Statement and the
 * report count but the contact record does not.
 *
 * `contactRecordsOnly` ignores the vendor report entirely, so a report can be checked against a
 * second, independent source (the contact records plus the TDS from each payment's own record)
 * instead of against itself.
 */
export function ledgerFromContacts(raw: RawZohoData, opts: { contactRecordsOnly?: boolean } = {}): LedgerBalances {
  const customers = new Map<string, number>();
  for (const c of raw.activeCustomers) {
    if (c.outstanding_receivable_amount === undefined) continue; // field not in this snapshot
    customers.set(c.contact_id, c.outstanding_receivable_amount - (c.unused_credits_receivable_amount ?? 0));
  }
  const vendors = new Map<string, number>();
  const report = !opts.contactRecordsOnly && raw.vendorLedgerToday && Object.keys(raw.vendorLedgerToday).length > 0 ? raw.vendorLedgerToday : undefined;
  const tds = tdsByVendor(raw);
  let fromReportCount = 0;
  for (const v of raw.activeVendors) {
    if (v.outstanding_payable_amount === undefined) continue;
    const fromReport = report ? report[v.contact_id] : undefined;
    if (fromReport !== undefined) fromReportCount += 1;
    vendors.set(v.contact_id, fromReport ?? v.outstanding_payable_amount - (v.unused_credits_payable_amount ?? 0) - (tds.get(v.contact_id) ?? 0));
  }
  return { asOf: cacheDay(raw.fetchedAt), source: fromReportCount > 0 ? 'contact-record + vendor-report' : 'contact-record', customers, vendors };
}

// ---------------------------------------------------------------- snapshots

function getClient(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

const snapKey = (asOf: string) => `rpel-apar:ledger:${asOf}`;

interface StoredSnapshot {
  asOf: string;
  fetchedAt: string;
  customers: Record<string, number>;
  vendors: Record<string, number>;
  report: { customerPath: string; vendorPath: string; vendorSign: 1 | -1 };
}

export async function saveLedgerSnapshot(
  asOf: string,
  customers: Map<string, number>,
  vendors: Map<string, number>,
  report: StoredSnapshot['report']
): Promise<void> {
  const redis = getClient();
  if (!redis) throw new Error('Redis is not configured, so ledger snapshots cannot be stored.');
  const snap: StoredSnapshot = {
    asOf,
    fetchedAt: new Date().toISOString(),
    customers: Object.fromEntries(customers),
    vendors: Object.fromEntries(vendors),
    report,
  };
  await redis.set(snapKey(asOf), JSON.stringify(snap));
}

export async function loadLedgerSnapshot(asOf: string): Promise<LedgerBalances | null> {
  const redis = getClient();
  if (!redis) return null;
  const snap = await redis.get<StoredSnapshot>(snapKey(asOf));
  if (!snap) return null;
  return {
    asOf,
    source: 'report-snapshot',
    customers: new Map(Object.entries(snap.customers)),
    vendors: new Map(Object.entries(snap.vendors)),
  };
}

export type LedgerBasis = 'current' | 'snapshot' | 'unavailable';

/**
 * Picks the ledger for the requested date: today's contact records when the
 * date is on/after the day the cache was read, a stored report snapshot for
 * an earlier date, or nothing (the caller then says so rather than guessing).
 */
export async function getLedgerFor(
  asOf: string,
  raw: RawZohoData
): Promise<{ ledger: LedgerBalances | null; basis: LedgerBasis }> {
  if (asOf >= cacheDay(raw.fetchedAt)) {
    const l = ledgerFromContacts(raw);
    return l.customers.size + l.vendors.size > 0 ? { ledger: l, basis: 'current' } : { ledger: null, basis: 'unavailable' };
  }
  const snap = await loadLedgerSnapshot(asOf);
  return snap ? { ledger: snap, basis: 'snapshot' } : { ledger: null, basis: 'unavailable' };
}

// ---------------------------------------------------------------- report fetch

const CANDIDATES = {
  customer: [process.env.ZOHO_REPORT_PATH_CUSTOMER, 'customerbalancesummary', 'customerbalances', 'customer_balance_summary'],
  vendor: [process.env.ZOHO_REPORT_PATH_VENDOR, 'vendorbalancesummary', 'vendorbalances', 'vendor_balance_summary'],
} as const;

function fyStart(asOf: string): string {
  const y = Number(asOf.slice(0, 4));
  const m = Number(asOf.slice(5, 7));
  return `${m >= 4 ? y : y - 1}-04-01`;
}

/** Finds the report rows (objects carrying `closing_balance`) anywhere in a response, nested or not. */
export function parseReportRows(
  body: Record<string, unknown>
): { rows: Record<string, unknown>[]; key: string } | null {
  const walk = (v: unknown, path: string, depth: number): { rows: Record<string, unknown>[]; key: string } | null => {
    if (depth > 3 || v === null || typeof v !== 'object') return null;
    if (Array.isArray(v)) {
      if (v.length > 0 && typeof v[0] === 'object' && v[0] !== null && 'closing_balance' in (v[0] as object)) {
        return { rows: v as Record<string, unknown>[], key: path };
      }
      for (let i = 0; i < v.length; i++) {
        const r = walk(v[i], `${path}[${i}]`, depth + 1);
        if (r) return r;
      }
      return null;
    }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const r = walk(x, path ? `${path}.${k}` : k, depth + 1);
      if (r) return r;
    }
    return null;
  };
  return walk(body, '', 0);
}

function rowId(row: Record<string, unknown>): string {
  return String(row.customer_id ?? row.vendor_id ?? row.contact_id ?? '');
}

const normName = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** name -> contact id, for the contacts whose name is unique (used only if a report returns names without ids). */
export function nameIndex(contacts: { contact_id: string; contact_name: string }[]): Map<string, string> {
  const seen = new Map<string, string | null>();
  for (const c of contacts) {
    const k = normName(c.contact_name);
    seen.set(k, seen.has(k) ? null : c.contact_id);
  }
  const out = new Map<string, string>();
  for (const [k, id] of seen) if (id) out.set(k, id);
  return out;
}

export interface ReportFetch {
  ok: true;
  path: string;
  variant: string;
  balances: Map<string, number>;
  rowCount: number;
  matchedByName: number;
}
export interface ReportFail {
  ok: false;
  tried: { path: string; variant: string; status: number; error: string }[];
}

// A report row only carries a contact id if that column is asked for: the vendor
// report's default columns are name, billed, paid and closing balance, with NO id.
const VENDOR_COLUMNS = JSON.stringify([
  { field: 'vendor_name', group: 'report' },
  { field: 'vendor_id', group: 'vendor' },
  { field: 'closing_balance', group: 'report' },
]);

const VARIANTS = {
  customer: [{ label: 'default columns', extra: {} as Record<string, string> }],
  vendor: [
    { label: 'with the vendor id column', extra: { select_columns: VENDOR_COLUMNS } as Record<string, string> },
    { label: 'default columns (matched by name)', extra: {} as Record<string, string> },
  ],
} as const;

/**
 * Fetches one balance report (all pages) for one date: tries each candidate address,
 * and for vendors first asks for the id column, then falls back to matching by name.
 * On failure the reasons (including what Zoho actually said) are returned, never swallowed.
 */
export async function fetchBalanceReport(
  kind: 'customer' | 'vendor',
  asOf: string,
  nameToId?: Map<string, string>
): Promise<ReportFetch | ReportFail> {
  const tried: ReportFail['tried'] = [];
  const names = CANDIDATES[kind].filter((n): n is string => Boolean(n));
  for (const name of names) {
    const path = `/reports/${name}`;
    for (const variant of VARIANTS[kind]) {
      const balances = new Map<string, number>();
      let rowCount = 0;
      let matchedByName = 0;
      let failure: string | null = null;
      let status = 200;
      for (let page = 1; page <= 50; page++) {
        const res = await zohoTry(path, {
          filter_by: 'TransactionDate.CustomDate',
          from_date: fyStart(asOf),
          to_date: asOf,
          per_page: 500,
          page,
          response_option: 1,
          usestate: 'false',
          ...variant.extra,
        });
        if (!res.ok) {
          status = res.status;
          failure = res.error;
          break;
        }
        const parsed = parseReportRows(res.body);
        if (!parsed) {
          const said = typeof res.body.message === 'string' ? ` Zoho said (code ${String(res.body.code)}): ${res.body.message}.` : '';
          failure = `Responded, but no rows with closing_balance.${said} Keys: ${Object.keys(res.body).join(', ')}. Body starts: ${JSON.stringify(res.body).slice(0, 300)}`;
          break;
        }
        for (const row of parsed.rows) {
          let id = rowId(row);
          if (!id && nameToId) {
            id = nameToId.get(normName(String(row.vendor_name ?? row.customer_name ?? row.contact_name ?? row.name ?? ''))) ?? '';
            if (id) matchedByName += 1;
          }
          const v = Number(row.closing_balance);
          if (id && Number.isFinite(v)) balances.set(id, v);
        }
        rowCount += parsed.rows.length;
        const pc = res.body.page_context as { has_more_page?: boolean } | undefined;
        if (!pc?.has_more_page) break;
      }
      if (!failure && rowCount > 0 && balances.size === 0) {
        failure = `Read ${rowCount} rows but none could be tied to a contact (no id column, and no names matched).`;
      }
      if (!failure) return { ok: true, path, variant: variant.label, balances, rowCount, matchedByName };
      tried.push({ path, variant: variant.label, status, error: failure });
    }
  }
  return { ok: false, tried };
}

/** The contacts where a report and the contact record disagree, biggest first (after applying the report's sign). */
export function topMismatches(
  report: Map<string, number>,
  contacts: Map<string, number>,
  sign: 1 | -1 = 1,
  limit = 8
): { id: string; report: number; contact: number; diff: number }[] {
  const out: { id: string; report: number; contact: number; diff: number }[] = [];
  for (const [id, c] of contacts) {
    const r = (report.get(id) ?? 0) * sign;
    if (Math.abs(r - c) > 1.5) out.push({ id, report: r, contact: c, diff: r - c });
  }
  return out.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)).slice(0, limit);
}

/** Compares a report against the contact-record ledger to detect sign convention and agreement. */
export function calibrate(report: Map<string, number>, contacts: Map<string, number>) {
  let plus = 0;
  let minus = 0;
  let total = 0;
  for (const [id, c] of contacts) {
    const r = report.get(id) ?? 0;
    if (Math.abs(c) <= 1 && Math.abs(r) <= 1) continue;
    total += 1;
    if (Math.abs(r - c) <= 1.5) plus += 1;
    if (Math.abs(-r - c) <= 1.5) minus += 1;
  }
  const sign: 1 | -1 = minus > plus ? -1 : 1;
  return { total, plus, minus, sign, agreement: total ? Math.max(plus, minus) / total : 0 };
}

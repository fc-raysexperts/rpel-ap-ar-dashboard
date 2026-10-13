// THE DAILY STOCK SNAPSHOT. Server only.
//
// Same idea as the Debtors / Creditors snapshot: Zoho is read once a day (07:45 India time, vercel.json) and every
// visitor is shown that saved copy for the rest of the day, so a page load never waits on Zoho.
//
// What is read: Zoho's Stock Summary for EVERY month from April 2026 to today (the running month up to today), one
// report per month, all of them again each day, because Zoho lets earlier months change and a frozen month would
// drift from what Zoho itself shows. Each month's rows are kept in Redis (compressed). A period made of whole
// months is added up from them (stock-compose.ts); the year's list of products shown on their own line is worked
// out from the same data.
//
// Safety, as with the other snapshot:
//  - a new snapshot is written under a new id and only becomes THE snapshot when every month has been read; if a run
//    fails or runs out of time, the previous snapshot stays exactly as it was, and the run carries on next call;
//  - only one refresh runs at a time (a lock that expires by itself);
//  - a snapshot already read today is not read again unless force is asked for.

import { gunzipSync, gzipSync } from 'zlib';
import { qualifyingProducts, type StockRow } from './stock-calculator';
import { acquireLock, kvDel, kvGet, kvSetStrict, pullStockReport, releaseLock } from './stock-zoho';
import { listsFromMonths, monthSpans, sameSpans, type ListEntry, type MonthSpan } from './stock-compose';

/** Bump when the shape of what is stored changes: an older snapshot is then ignored and read again. */
export const SNAP_RULES = 1;

const K_META = 'rpel-apar:stock:snap:meta';
const K_BUILD = 'rpel-apar:stock:snap:build';
const K_LOCK = 'rpel-apar:stock:snap:lock';
const blobKey = (buildId: string, ym: string) => `rpel-apar:stock:snap:${buildId}:${ym}`;

export interface SnapMonth extends MonthSpan {
  readAt: string;
}

/** Quantities must chain from month to month (one month's closing is the next month's opening). */
export interface ChainCheck {
  pairs: number;
  breaks: number;
  examples: string[];
}

export interface SnapMeta {
  rules: number;
  buildId: string;
  /** the India date of the refresh: the running month is read up to this day */
  asOf: string;
  startedAt: string;
  /** when the last month was read, i.e. when this snapshot became the current one */
  builtAt: string;
  months: SnapMonth[];
  /** financial year (the calendar year it starts in) -> products shown on their own line */
  lists: Record<string, Record<string, ListEntry>>;
  chain: ChainCheck;
}

interface BuildState {
  buildId: string;
  asOf: string;
  startedAt: string;
  /** a manual force-run: carry on with it until it finishes, do not restart it on every call */
  forced: boolean;
  done: (SnapMonth & { qualifying: { key: string; name: string }[] })[];
  chain: ChainCheck;
}

export interface SnapProgress {
  complete: boolean;
  done: number;
  total: number;
  /** another request is already refreshing */
  busy: boolean;
  /** months read by THIS call */
  builtNow: number;
  meta: SnapMeta | null;
  skipped?: boolean;
}

// ------------------------------------------------------------------------------------------------ rows <-> storage

type Packed = [string, string, number, number, number, number, number];

function packRows(rows: StockRow[]): string {
  const arr: Packed[] = rows.map((r) => [r.itemId, r.name, r.opening, r.qtyIn, r.qtyOut, r.closing, r.closingValue]);
  return gzipSync(Buffer.from(JSON.stringify(arr), 'utf8')).toString('base64');
}
function unpackRows(z: string): StockRow[] {
  const arr = JSON.parse(gunzipSync(Buffer.from(z, 'base64')).toString('utf8')) as Packed[];
  return arr.map(([itemId, name, opening, qtyIn, qtyOut, closing, closingValue]) => ({ itemId, name, opening, qtyIn, qtyOut, closing, closingValue }));
}

interface Blob {
  v: 1;
  ym: string;
  from: string;
  to: string;
  readAt: string;
  z: string;
}

// ------------------------------------------------------------------------------------------------ reading (page loads)

/** The current snapshot's small header (one tiny read), or null if there is none (or it is from an older version of the code). */
export async function readSnapshot(): Promise<SnapMeta | null> {
  const meta = await kvGet<SnapMeta>(K_META);
  if (!meta || meta.rules !== SNAP_RULES || !Array.isArray(meta.months)) return null;
  return meta;
}

// The rows of the months already opened on this server, so the next page load costs nothing. A snapshot never
// changes once written (a new day is a new buildId), so there is nothing to invalidate.
let memo: { buildId: string; months: Map<string, StockRow[]> } | null = null;

export class SnapshotReplaced extends Error {}

/** The rows of each of these months, in order. */
export async function loadMonthRows(meta: SnapMeta, spans: MonthSpan[]): Promise<StockRow[][]> {
  if (!memo || memo.buildId !== meta.buildId) memo = { buildId: meta.buildId, months: new Map() };
  const held = memo.months;
  const missing = spans.filter((s) => !held.has(s.ym));
  await Promise.all(
    missing.map(async (s) => {
      const blob = await kvGet<Blob>(blobKey(meta.buildId, s.ym));
      if (!blob || typeof blob.z !== 'string') throw new SnapshotReplaced(`The saved stock data for ${s.ym} is not there (a new daily copy was just written).`);
      held.set(s.ym, unpackRows(blob.z));
    })
  );
  return spans.map((s) => held.get(s.ym) as StockRow[]);
}

// ------------------------------------------------------------------------------------------------ the daily refresh

/**
 * Makes sure there is a snapshot read today. A run reads the months one after the other and stops when `budgetMs`
 * is used up, keeping what it has read; calling it again carries on. Nothing is swapped in until every month is in.
 */
export async function ensureSnapshot(today: string, budgetMs: number, opts: { force?: boolean } = {}): Promise<SnapProgress> {
  const months = monthSpans(today);
  const total = months.length;
  const current = (m: SnapMeta | null) => !!m && m.asOf === today && sameSpans(m.months, months);

  const existing = await readSnapshot();
  if (current(existing) && !opts.force) return { complete: true, done: total, total, busy: false, builtNow: 0, meta: existing, skipped: true };

  if (!(await acquireLock(K_LOCK, Math.ceil(budgetMs / 1000) + 120))) {
    const st = await kvGet<BuildState>(K_BUILD);
    return { complete: false, done: st && st.asOf === today ? st.done.length : 0, total, busy: true, builtNow: 0, meta: existing };
  }
  try {
    // another request may have finished the job while this one waited for the lock
    const again = await readSnapshot();
    if (current(again) && !opts.force) return { complete: true, done: total, total, busy: false, builtNow: 0, meta: again, skipped: true };

    let state = await kvGet<BuildState>(K_BUILD);
    const resumable = !!state && state.asOf === today && state.done.every((d) => months.some((m) => m.ym === d.ym && m.to === d.to)) && (!opts.force || state.forced);
    if (!resumable) {
      if (state) await kvDel(state.done.map((d) => blobKey((state as BuildState).buildId, d.ym))); // a half-finished older run
      state = {
        buildId: `${today}-${Date.now().toString(36)}`,
        asOf: today,
        startedAt: new Date().toISOString(),
        forced: !!opts.force,
        done: [],
        chain: { pairs: 0, breaks: 0, examples: [] },
      };
    }
    const st = state as BuildState;

    const t0 = Date.now();
    let built = 0;
    let lastMs = 0;
    let prev: { ym: string; rows: StockRow[] } | null = null;
    for (const m of months) {
      if (st.done.some((d) => d.ym === m.ym && d.to === m.to)) continue;
      if (built > 0 && Date.now() - t0 + lastMs * 1.3 > budgetMs) break;
      const t1 = Date.now();
      const pulled = await pullStockReport(m.from, m.to);
      const readAt = new Date().toISOString();
      const blob: Blob = { v: 1, ym: m.ym, from: m.from, to: m.to, readAt, z: packRows(pulled.rows) };
      await kvSetStrict(blobKey(st.buildId, m.ym), blob);

      // does this month start where the previous one ended? (best effort: only when both were read by this call)
      if (prev && monthAfter(prev.ym) === m.ym) {
        const open = new Map(pulled.rows.map((r) => [r.itemId, r.opening]));
        st.chain.pairs += 1;
        let broke = 0;
        for (const r of prev.rows) {
          if (Math.abs(r.closing - (open.get(r.itemId) ?? 0)) > 0.002) {
            broke += 1;
            if (st.chain.examples.length < 5) st.chain.examples.push(`${r.name}: closing ${r.closing} on ${prev.ym} but opening ${open.get(r.itemId) ?? 0} on ${m.ym}`);
          }
        }
        st.chain.breaks += broke;
      }
      prev = { ym: m.ym, rows: pulled.rows };

      st.done.push({ ...m, readAt, qualifying: qualifyingProducts(pulled.rows) });
      await kvSetStrict(K_BUILD, st); // saved month by month: a stop half-way loses nothing
      built += 1;
      lastMs = Date.now() - t1;
    }

    if (st.done.length < total) return { complete: false, done: st.done.length, total, busy: false, builtNow: built, meta: existing };

    // every month is in: swap the new snapshot in, then remove the previous one
    const ordered = months.map((m) => st.done.find((d) => d.ym === m.ym && d.to === m.to) as BuildState['done'][number]);
    const meta: SnapMeta = {
      rules: SNAP_RULES,
      buildId: st.buildId,
      asOf: today,
      startedAt: st.startedAt,
      builtAt: new Date().toISOString(),
      months: ordered.map(({ ym, from, to, readAt }) => ({ ym, from, to, readAt })),
      lists: listsFromMonths(ordered),
      chain: st.chain,
    };
    await kvSetStrict(K_META, meta);
    if (existing && existing.buildId !== meta.buildId) await kvDel(existing.months.map((m) => blobKey(existing.buildId, m.ym)));
    await kvDel([K_BUILD]);
    return { complete: true, done: total, total, busy: false, builtNow: built, meta };
  } finally {
    await releaseLock(K_LOCK);
  }
}

function monthAfter(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

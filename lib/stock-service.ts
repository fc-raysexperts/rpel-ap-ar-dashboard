// One place that answers "the Stock Statement for From..To", for the page and for the Excel download. Server only.
//
// Cache-first, like the Debtors / Creditors tabs: the answer is worked out from the daily snapshot (stock-snapshot.ts,
// read from Zoho once a day at 07:45 India time), so opening a period never waits on Zoho. The one exception is a
// custom period that is not made of whole months (e.g. 5 Sep to 20 Sep): Zoho's report is period based and cannot be
// added up from months, so that one is read from Zoho directly, kept for a few minutes, and marked "Live".

import { buildStatement, qualifyingProducts, type StockApiData, type StockRow } from './stock-calculator';
import { getUnits, pullStockReport } from './stock-zoho';
import { composeRows, monthsFor } from './stock-compose';
import { ensureSnapshot, loadMonthRows, readSnapshot, SnapshotReplaced, type SnapMeta } from './stock-snapshot';
import { fyLabel, fyStartYearOf } from './stock-period';
import { isMockMode } from './mock-data';
import { mockStockRows, mockUnits } from './stock-mock';

/** Today's date in India (the server itself runs in UTC, which is still "yesterday" until 5:30 AM IST). */
export function todayIST(): string {
  return new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
}

export type StockResult =
  | { building: true; progress: { done: number; total: number }; busy: boolean }
  | { building: false; data: StockApiData };

// A custom period read live is kept for a few minutes so that the Excel download that follows a look at the page does
// not read Zoho again.
const LIVE_TTL_MS = 5 * 60_000;
const live = new Map<string, { at: number; buildId: string; data: StockApiData }>();

/** How long one request may spend reading the year's months (only the very first load of all, or a missed daily refresh) before it hands back "still preparing" (the page asks again). */
const BUILD_BUDGET_MS = Number(process.env.STOCK_LIST_BUDGET_MS ?? 40_000);

const redisConfigured = () => Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);

export async function getStock(from: string, to: string, opts: { today: string }): Promise<StockResult> {
  const fyOf = (d: string) => fyStartYearOf(d);

  if (isMockMode()) {
    const rows = mockStockRows();
    const keys = new Set(qualifyingProducts(rows).map((q) => q.key));
    const units = mockUnits();
    const stmt = buildStatement(rows, keys, (id) => units[id] ?? '');
    return {
      building: false,
      data: { ...stmt, from, to, fy: fyLabel(fyOf(to)), listCount: keys.size, pulledAt: new Date().toISOString(), cached: false, source: 'snapshot', mock: true },
    };
  }

  // 1. The snapshot. A page load only READS it. It is read from Zoho here (and the page shows "still preparing") only when there
  //    is none at all (the very first load), or when this is a local run, where there is no 07:45 job to renew it each day.
  let meta = await readSnapshot();
  const localRun = !redisConfigured() || process.env.NODE_ENV !== 'production';
  if (!meta || (localRun && meta.asOf !== opts.today)) {
    const p = await ensureSnapshot(opts.today, BUILD_BUDGET_MS);
    if (!p.complete || !p.meta) return { building: true, progress: { done: p.done, total: p.total }, busy: p.busy };
    meta = p.meta;
  }

  // 2. Whole months: add them up from the snapshot. (One retry: a new daily copy may have replaced the one just read.)
  const whole = monthsFor(meta.months, from, to, meta.asOf);
  if (whole) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const parts = await loadMonthRows(meta, whole.months);
        return { building: false, data: await fromRows(composeRows(parts), from, whole.to, meta, 'snapshot', meta.builtAt) };
      } catch (e) {
        if (!(e instanceof SnapshotReplaced) || attempt === 1) throw e;
        const fresh = await readSnapshot();
        if (!fresh) throw e;
        meta = fresh;
        const again = monthsFor(meta.months, from, to, meta.asOf);
        if (!again) break;
        whole.months = again.months;
        whole.to = again.to;
      }
    }
  }

  // 3. Dates that are not whole months: Zoho's own report for exactly these dates, read now.
  const key = `${from}..${to}`;
  const hit = live.get(key);
  if (hit && hit.buildId === meta.buildId && Date.now() - hit.at < LIVE_TTL_MS) return { building: false, data: { ...hit.data, cached: true } };
  const pulled = await pullStockReport(from, to);
  const data = await fromRows(pulled.rows, from, to, meta, 'live', new Date().toISOString());
  data.pages = pulled.pages;
  data.ms = pulled.ms;
  if (live.size >= 20) {
    const oldest = live.keys().next().value;
    if (oldest !== undefined) live.delete(oldest);
  }
  live.set(key, { at: Date.now(), buildId: meta.buildId, data });
  return { building: false, data };
}

async function fromRows(rows: StockRow[], from: string, to: string, meta: SnapMeta, source: 'snapshot' | 'live', pulledAt: string): Promise<StockApiData> {
  const fy = fyStartYearOf(to);
  const list = meta.lists[String(fy)] ?? {};
  const keys = new Set(Object.keys(list));
  // Units: what the daily refresh stored, however old (the report does not carry them, the item list does).
  const units = await getUnits({ staleOk: true });
  const stmt = buildStatement(rows, keys, (id) => units.units[id] ?? '');
  return {
    ...stmt,
    from,
    to,
    fy: fyLabel(fy),
    listCount: keys.size,
    pulledAt,
    cached: source === 'snapshot',
    source,
    snapshotAsOf: meta.asOf,
  };
}

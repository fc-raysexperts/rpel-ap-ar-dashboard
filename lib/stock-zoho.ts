// Reading the Stock Summary from Zoho Books, plus the small storage helpers the daily snapshot uses. Server only.
//
// The report is Zoho's own "Stock Summary" (entity inventory_stock_details). It is read from Zoho only by the daily
// refresh (stock-snapshot.ts, 07:45 IST) and, rarely, for a custom period that is not made of whole months; every
// other page load is answered from the snapshot the refresh saved.

import { Redis } from '@upstash/redis';
import { zohoTry } from './zoho-client';
import type { StockRow } from './stock-calculator';

// ------------------------------------------------------------------------------------------------ storage

let redisClient: Redis | null = null;
function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  if (!redisClient) redisClient = new Redis({ url, token });
  return redisClient;
}
// Without Redis (a local run with no Upstash) everything is kept in memory for as long as the server runs.
const mem = new Map<string, unknown>();
const memLocks = new Map<string, number>();

export async function kvGet<T>(key: string): Promise<T | null> {
  const r = getRedis();
  if (!r) return (mem.get(key) as T | undefined) ?? null;
  try {
    return (await r.get<T>(key)) ?? null;
  } catch (e) {
    console.error('Redis read failed (stock):', e);
    return (mem.get(key) as T | undefined) ?? null;
  }
}
export async function kvSet(key: string, value: unknown): Promise<void> {
  mem.set(key, value);
  const r = getRedis();
  if (!r) return;
  try {
    await r.set(key, JSON.stringify(value));
  } catch (e) {
    console.error('Redis write failed (stock):', e);
  }
}
/** Like kvSet, but a failed Redis write is an error: used for the snapshot, which must never point at data that was not saved. */
export async function kvSetStrict(key: string, value: unknown): Promise<void> {
  const r = getRedis();
  if (!r) {
    mem.set(key, value);
    return;
  }
  await r.set(key, JSON.stringify(value));
  mem.set(key, value);
}
export async function kvDel(keys: string[]): Promise<void> {
  for (const k of keys) mem.delete(k);
  const r = getRedis();
  if (!r || keys.length === 0) return;
  try {
    for (let i = 0; i < keys.length; i += 40) await r.del(...keys.slice(i, i + 40));
  } catch (e) {
    console.error('Redis delete failed (stock):', e);
  }
}
export async function acquireLock(key: string, seconds: number): Promise<boolean> {
  const r = getRedis();
  if (!r) {
    if ((memLocks.get(key) ?? 0) > Date.now()) return false;
    memLocks.set(key, Date.now() + seconds * 1000);
    return true;
  }
  try {
    return (await r.set(key, new Date().toISOString(), { nx: true, ex: seconds })) === 'OK';
  } catch {
    return true; // Redis down: carry on rather than block
  }
}
export async function releaseLock(key: string): Promise<void> {
  memLocks.delete(key);
  const r = getRedis();
  if (!r) return;
  try {
    await r.del(key);
  } catch {
    /* it expires by itself */
  }
}

// ------------------------------------------------------------------------------------------------ the report

type Raw = Record<string, unknown>;
const num = (v: unknown): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/** Every object in the response that looks like a stock line, however deeply the report nests it. */
function findRows(body: unknown): Raw[] {
  const out: Raw[] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 6 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    const o = v as Raw;
    if ('item_name' in o && ('closing_stock' in o || 'closing_stock_value' in o || 'opening_stock' in o)) {
      out.push(o);
      return;
    }
    for (const x of Object.values(o)) walk(x, depth + 1);
  };
  walk(body, 0);
  return out;
}
const hasMore = (body: Raw): boolean => Boolean((body.page_context as Raw | undefined)?.has_more_page);

// The path Zoho answers on for this account was found on 12 Oct 2026 (the report's entity name without underscores).
let workingPath: string | null = null;
const reportPaths = () => [process.env.ZOHO_REPORT_PATH_STOCK, 'inventorystockdetails', 'inventory_stock_details'].filter((p): p is string => Boolean(p));

/**
 * One read of Zoho's Stock Summary for From..To: every item (the report lists items with no stock too), with
 * Opening Stock, Quantity In, Quantity Out, Closing Stock and Closing Stock Amount. Pages are read three at a time.
 */
export async function pullStockReport(from: string, to: string): Promise<{ rows: StockRow[]; pages: number; ms: number }> {
  const t0 = Date.now();
  const params = (page: number) => ({
    filter_by: 'TransactionDate.CustomDate',
    from_date: from,
    to_date: to,
    per_page: 500,
    response_option: 1,
    usestate: 'false',
    ...(page > 1 ? { page } : {}),
  });

  let first: Raw | null = null;
  let path = '';
  let lastError = '';
  for (const p of workingPath ? [workingPath] : reportPaths()) {
    const res = await zohoTry(`/reports/${p}`, params(1));
    if (res.ok) {
      first = res.body;
      path = p;
      workingPath = p;
      break;
    }
    lastError = `HTTP ${res.status}: ${res.error}`;
    if (res.status !== 404) break; // 404 is only a wrong path name; anything else is a real answer from Zoho
  }
  if (!first) {
    workingPath = null;
    throw new Error(`Zoho would not give the Stock Summary report (${lastError}). Check that the Zoho credentials may read reports.`);
  }

  const raw: Raw[] = [...findRows(first)];
  let pages = 1;
  let more = hasMore(first);
  while (more && pages < 30) {
    const batch = [pages + 1, pages + 2, pages + 3];
    const results = await Promise.all(batch.map((p) => zohoTry(`/reports/${path}`, params(p))));
    let stop = false;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (!r.ok) throw new Error(`Zoho stopped part-way through the Stock Summary (page ${batch[i]}, HTTP ${r.status}): ${r.error}`);
      const rs = findRows(r.body);
      raw.push(...rs);
      if (rs.length === 0 || !hasMore(r.body)) {
        stop = true;
        break;
      }
    }
    pages += batch.length;
    more = !stop;
  }

  // one row per item; if Zoho ever repeated a row across two pages it must not be counted twice
  const byId = new Map<string, StockRow>();
  for (const r of raw) {
    const itemId = String(r.item_id ?? '') || `name:${String(r.item_name)}`;
    byId.set(itemId, {
      itemId,
      name: String(r.item_name ?? ''),
      opening: num(r.opening_stock),
      qtyIn: num(r.quantity_in),
      qtyOut: num(r.quantity_out),
      closing: num(r.closing_stock),
      closingValue: num(r.closing_stock_value),
    });
  }
  if (byId.size === 0) throw new Error(`Zoho's Stock Summary came back with no items for ${from} to ${to}.`);
  return { rows: [...byId.values()], pages, ms: Date.now() - t0 };
}

// ------------------------------------------------------------------------------------------------ units

const UNITS_KEY = 'rpel-apar:stock:units';
interface UnitCache {
  fetchedAt: string;
  units: Record<string, string>;
}
let unitMemo: UnitCache | null = null;

/** item id -> unit ("Nos", "Mtr"...). The Stock Summary does not carry it, the item list does. Renewed by the daily refresh. */
export async function getUnits(opts: { force?: boolean; maxAgeMs?: number; staleOk?: boolean } = {}): Promise<UnitCache> {
  // staleOk: whatever is stored is used however old it is (a page load never reads Zoho for it); the daily refresh renews it
  const maxAge = opts.staleOk ? Infinity : (opts.maxAgeMs ?? 24 * 3_600_000);
  const fresh = (c: UnitCache | null) => c !== null && Date.now() - new Date(c.fetchedAt).getTime() < maxAge;
  if (!opts.force && fresh(unitMemo)) return unitMemo as UnitCache;
  if (!opts.force) {
    const stored = await kvGet<UnitCache>(UNITS_KEY);
    if (stored && fresh(stored)) {
      unitMemo = stored;
      return stored;
    }
  }
  const units: Record<string, string> = {};
  let ok = true;
  for (let page = 1; page <= 40; page++) {
    const res = await zohoTry('/items', { per_page: 200, page, filter_by: 'Status.All' });
    if (!res.ok) {
      ok = false;
      console.error(`Item list page ${page} failed (HTTP ${res.status}): ${res.error}`);
      break;
    }
    for (const it of (Array.isArray(res.body.items) ? res.body.items : []) as Raw[]) {
      if (it.item_id !== undefined) units[String(it.item_id)] = String(it.unit ?? '');
    }
    if (!hasMore(res.body)) break;
  }
  if (!ok && Object.keys(units).length === 0) {
    // could not read the list at all: a stale copy is better than none
    const stale = unitMemo ?? (await kvGet<UnitCache>(UNITS_KEY));
    return stale ?? { fetchedAt: new Date(0).toISOString(), units: {} };
  }
  const cache: UnitCache = { fetchedAt: new Date().toISOString(), units };
  if (ok) {
    unitMemo = cache;
    await kvSet(UNITS_KEY, cache);
  }
  return cache;
}

import { Redis } from '@upstash/redis';
import {
  listJournalSummaries,
  getJournalDetailRaw,
  isJNCleanJournal,
  isForeignJournal,
  type ZohoJournalSummary,
} from './zoho-client';
import { isExcludedStatus } from './status-filter';
import { extractJNEntry, type JNCleanEntry } from './jn-clean';

// Same idea as the main journal store (journal-job.ts): fetch each JN-Clean
// journal's detail ONCE, remember it, and afterwards only re-fetch one whose
// last_modified_time changed (e.g. when more of its credit gets applied to a
// new bill). There are ~670 JN-Clean journals, so the very first run costs
// ~670 calls (about 1-2 minutes); every later run costs almost nothing.
//
// Most JN-Clean journals only touch ledger accounts and carry no customer or
// vendor. They are stored as `entry: null` markers so they are not fetched
// again on every run.

// v2: lines now keep their account_id, so the store rebuilds once.
const STORE_KEY = 'rpel-apar:jnclean-store-v2';
const CONCURRENCY = 5;

interface StoredJN {
  lastModifiedTime: string;
  entry: JNCleanEntry | null;
  /** true once the amounts were read in rupees (foreign-currency journals stored earlier are re-read once) */
  inRupees?: boolean;
}
type Store = Record<string, StoredJN>;

function getClient(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

export interface JNSyncStats {
  jnJournals: number;
  fetchedThisRun: number;
  failed: number;
  /** true when the time budget ran out before every needed journal was fetched */
  partial: boolean;
  /** JN-Clean journals in a foreign currency (their lines are stored at the rupee value) */
  foreignJournals: number;
  entriesWithContacts: number;
  contactLines: number;
  applications: number;
  applicationTotal: number;
}

export interface JNSyncResult {
  entries: JNCleanEntry[];
  stats: JNSyncStats;
}

export async function syncJNClean(opts: {
  onProgress?: (fetched: number, total: number) => void;
  /** stop fetching after this long (serverless safety); leftovers are picked up next run */
  timeBudgetMs?: number;
} = {}): Promise<JNSyncResult> {
  const redis = getClient();
  const store: Store = redis ? ((await redis.get<Store>(STORE_KEY)) ?? {}) : {};

  const summaries = await listJournalSummaries();
  const jn = summaries.filter((j: ZohoJournalSummary) => isJNCleanJournal(j) && !isExcludedStatus(j.status));
  const needs = jn.filter((j) => {
    const cached = store[j.journal_id];
    return !cached || cached.lastModifiedTime !== j.last_modified_time || (isForeignJournal(j) && !cached.inRupees);
  });

  const deadline = opts.timeBudgetMs ? Date.now() + opts.timeBudgetMs : Infinity;
  let fetched = 0;
  let failed = 0;
  let partial = false;

  for (let i = 0; i < needs.length; i += CONCURRENCY) {
    if (Date.now() > deadline) {
      partial = true;
      break;
    }
    const chunk = needs.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      chunk.map(async (s) => {
        try {
          const raw = await getJournalDetailRaw(s.journal_id);
          store[s.journal_id] = {
            lastModifiedTime: s.last_modified_time,
            entry: extractJNEntry({ ...raw, journal_id: raw.journal_id ?? s.journal_id }),
            inRupees: true,
          };
          return true;
        } catch (err) {
          console.error(`Failed to fetch JN-Clean journal ${s.journal_id}, will retry next run:`, err);
          return false;
        }
      })
    );
    failed += results.filter((r) => !r).length;
    fetched += chunk.length;
    opts.onProgress?.(fetched, needs.length);
  }

  const wanted = new Set(jn.map((j) => j.journal_id));
  for (const id of Object.keys(store)) if (!wanted.has(id)) delete store[id];
  if (redis) await redis.set(STORE_KEY, JSON.stringify(store));

  const entries = jn
    .map((j) => store[j.journal_id]?.entry)
    .filter((e): e is JNCleanEntry => Boolean(e));

  return {
    entries,
    stats: {
      jnJournals: jn.length,
      fetchedThisRun: fetched,
      failed,
      partial,
      foreignJournals: jn.filter(isForeignJournal).length,
      entriesWithContacts: entries.filter((e) => e.lines.length > 0).length,
      contactLines: entries.reduce((s, e) => s + e.lines.length, 0),
      applications: entries.reduce((s, e) => s + e.applications.length, 0),
      applicationTotal: entries.reduce((s, e) => s + e.applications.reduce((a, x) => a + x.amount, 0), 0),
    },
  };
}

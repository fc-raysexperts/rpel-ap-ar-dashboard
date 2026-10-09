import { Redis } from '@upstash/redis';
import { listJournalSummaries, getJournalDetail, isJNCleanJournal, isForeignJournal, journalLineInBase, type ZohoJournalSummary } from './zoho-client';
import { isExcludedStatus } from './status-filter';

// Fetching a journal's line_items (needed to know which contact and how
// much) requires one API call PER journal -- the list endpoint doesn't
// return them (confirmed against a live response). RPEL has 2,000+
// journals, and Zoho's 100/min cap makes fetching all of them take 20+
// minutes -- but re-doing that EVERY single day, forever, is wasteful and
// unnecessary: once a journal is approved, it essentially never changes
// again. So this keeps a PERSISTENT store of every journal's fetched
// detail, keyed by journal_id, and each run only fetches what's actually
// NEW or CHANGED since last time (detected via Zoho's own
// last_modified_time on the cheap list response) -- typically a handful
// of journals per day, not 2,000+. The expensive full pass only ever
// happens once, the first time this runs against an empty store.

// v2 keys: the first-generation store saved every journal line WITHOUT its
// contact (the code read a field Zoho never sends -- see
// fetchAndStoreOne). Because incremental sync only re-fetches journals
// whose last_modified_time changed, those contact-less entries would
// never have been refreshed on their own. Switching to new key names
// makes the whole store rebuild once; the legacy keys are deleted below.
// v3: each line now also keeps its account_id (needed to tell which lines reach a
// contact's ledger), so the store rebuilds once.
const DETAILS_STORE_KEY = 'rpel-apar:journal-details-store-v3';
const JOB_KEY = 'rpel-apar:journal-job-v3';
const LEGACY_KEYS = ['rpel-apar:journal-details-store', 'rpel-apar:journal-job', 'rpel-apar:journal-details-store-v2', 'rpel-apar:journal-job-v2'];
const BATCH_TIME_BUDGET_MS = 45_000; // stay well under typical serverless limits
const CONCURRENCY = 5; // small parallel batches -- rate limit is the real ceiling either way
const MIN_HOURS_BETWEEN_FULL_CHECKS = 20; // "once a day" without needing exact clock alignment

export interface TrimmedJournalLine {
  contact_id?: string;
  account_id?: string;
  account_name?: string;
  debit_or_credit: 'debit' | 'credit';
  /** In RUPEES, whatever currency the journal was posted in. */
  amount: number;
  /** Only for a foreign-currency journal: the amount in that currency, kept so it can be shown. */
  face_amount?: number;
}

export interface TrimmedJournal {
  journal_id: string;
  journal_date: string;
  entry_number: string;
  available_receivables_credits?: number;
  available_payables_credits?: number;
  /** Only for a foreign-currency journal. */
  currency_code?: string;
  exchange_rate?: number;
  /** Only for a foreign-currency journal: Zoho's own rupee total, kept so the converted lines can be checked against it. */
  bcy_total?: number;
  line_items: TrimmedJournalLine[];
}

interface StoredEntry {
  detail: TrimmedJournal;
  lastModifiedTime: string;
  /** true once the lines were read in rupees (bcy_amount). Older entries lack it; only the
   *  foreign-currency ones among them are fetched again, once. */
  inRupees?: boolean;
}

type DetailsStore = Record<string, StoredEntry>;

interface JournalJobState {
  status: 'fetching-details' | 'done';
  startedAt: string;
  completedAt?: string;
  lastFullCheckAt?: string;
  queue: string[]; // journal_ids still needing a detail fetch this run
  relevantIds: string[]; // every journal_id that should end up in the final result
  failedIds: string[]; // fetch failures this run -- retried automatically next run, never silently dropped
}

function getClient(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

async function loadStore(redis: Redis): Promise<DetailsStore> {
  try {
    await redis.del(...LEGACY_KEYS); // best-effort cleanup of the contact-less first-generation data
  } catch {
    /* harmless if it fails */
  }
  return (await redis.get<DetailsStore>(DETAILS_STORE_KEY)) ?? {};
}

async function saveStore(redis: Redis, store: DetailsStore): Promise<void> {
  await redis.set(DETAILS_STORE_KEY, JSON.stringify(store));
}

async function getJobState(redis: Redis): Promise<JournalJobState | null> {
  return (await redis.get<JournalJobState>(JOB_KEY)) ?? null;
}

async function saveJobState(redis: Redis, state: JournalJobState): Promise<void> {
  await redis.set(JOB_KEY, JSON.stringify(state));
}

/**
 * Compares the cheap summary list against the persistent store to figure
 * out what actually needs a detail call. A journal only needs (re-)fetching
 * if it's not in the store yet, or its last_modified_time has changed
 * since the version we have stored -- i.e. genuinely new or edited since
 * last run. Everything else can just reuse what's already cached.
 */
async function computeDelta(store: DetailsStore) {
  const summaries = await listJournalSummaries();
  const relevant = summaries.filter((j: ZohoJournalSummary) => {
    if (isExcludedStatus(j.status)) return false;
    if (isJNCleanJournal(j)) return false;
    return true;
  });
  const needsFetch = relevant.filter((j) => {
    const cached = store[j.journal_id];
    if (!cached || cached.lastModifiedTime !== j.last_modified_time) return true;
    // A foreign-currency journal stored before lines were read in rupees is read again, once.
    return isForeignJournal(j) && !cached.inRupees;
  });
  return {
    relevantIds: relevant.map((j) => j.journal_id),
    needsFetch,
  };
}

async function fetchAndStoreOne(store: DetailsStore, summary: ZohoJournalSummary): Promise<boolean> {
  try {
    const detail = await getJournalDetail(summary.journal_id);
    if (isJNCleanJournal(detail)) {
      return true; // slipped past the summary check, caught here -- handled, just not stored
    }
    // The journal's own rate; if the detail does not give one, the rate implied by the list row's two totals.
    const implied = isForeignJournal(summary) && summary.total ? (summary.bcy_total as number) / summary.total : 1;
    const rate = typeof detail.exchange_rate === 'number' && detail.exchange_rate > 0 ? detail.exchange_rate : implied;
    const foreign = isForeignJournal(summary) || rate !== 1;
    // The unapplied credit Zoho reports is in the journal's own currency; the lines are kept in
    // rupees, so it is converted the same way (a rupee journal has rate 1 and is untouched).
    const inRupees = (v: number | undefined) => (v === undefined || v === null ? v : Math.round(v * rate * 100) / 100);
    store[detail.journal_id] = {
      lastModifiedTime: summary.last_modified_time,
      inRupees: true,
      detail: {
        journal_id: detail.journal_id,
        journal_date: detail.journal_date,
        entry_number: detail.entry_number ?? '',
        available_receivables_credits: inRupees(detail.available_receivables_credits),
        available_payables_credits: inRupees(detail.available_payables_credits),
        ...(foreign ? { currency_code: detail.currency_code, exchange_rate: rate, bcy_total: summary.bcy_total } : {}),
        line_items: (detail.line_items ?? []).map((li) => ({
          // Zoho puts the contact (customer OR vendor) in `customer_id`;
          // it is '' when the line has no contact. Reading `contact_id`
          // here (as this used to) always gave undefined, so no journal
          // line was ever linked to anyone.
          contact_id: li.customer_id || li.contact_id || undefined,
          account_id: li.account_id || undefined,
          account_name: li.account_name,
          debit_or_credit: li.debit_or_credit,
          amount: journalLineInBase(li, rate),
          ...(foreign ? { face_amount: li.amount } : {}),
        })),
      },
    };
    return true;
  } catch (err) {
    console.error(`Failed to fetch journal ${summary.journal_id}, will retry next run:`, err);
    return false;
  }
}

function assembleFromStore(store: DetailsStore, relevantIds: string[]): TrimmedJournal[] {
  const result: TrimmedJournal[] = [];
  for (const id of relevantIds) {
    const entry = store[id];
    if (entry) result.push(entry.detail);
    // If still missing (a persistent failure), it's left out of this
    // run's result -- failedIds in the job state tracks this so
    // progress/status reporting stays honest instead of hiding it.
  }
  return result;
}

function pruneStaleEntries(store: DetailsStore, relevantIds: string[]): void {
  const relevantSet = new Set(relevantIds);
  for (const id of Object.keys(store)) {
    if (!relevantSet.has(id)) delete store[id]; // e.g. voided/rejected since it was last cached
  }
}

export interface JournalJobProgress {
  configured: boolean;
  status: JournalJobState['status'] | 'not-started';
  fetchedThisRun: number;
  remainingThisRun: number;
  failedThisRun: number;
  totalRelevant: number;
  startedAt?: string;
}

function summaryOf(state: JournalJobState): JournalJobProgress {
  return {
    configured: true,
    status: state.status,
    fetchedThisRun: state.relevantIds.length - state.queue.length - state.failedIds.length,
    remainingThisRun: state.queue.length,
    failedThisRun: state.failedIds.length,
    totalRelevant: state.relevantIds.length,
    startedAt: state.startedAt,
  };
}

async function processTick(
  redis: Redis,
  state: JournalJobState,
  store: DetailsStore,
  queueSummaries: ZohoJournalSummary[],
  budgetMs: number = BATCH_TIME_BUDGET_MS
): Promise<{ progress: JournalJobProgress; journals: TrimmedJournal[] | null }> {
  const byId = new Map(queueSummaries.map((s) => [s.journal_id, s] as const));
  const deadline = Date.now() + budgetMs;

  while (state.queue.length > 0 && Date.now() < deadline) {
    const chunkIds = state.queue.slice(0, CONCURRENCY);
    const chunkSummaries = chunkIds.map((id) => byId.get(id)).filter((s): s is ZohoJournalSummary => Boolean(s));
    const results = await Promise.all(chunkSummaries.map((s) => fetchAndStoreOne(store, s)));
    chunkIds.forEach((id, i) => {
      if (!results[i]) state.failedIds.push(id);
    });
    state.queue = state.queue.slice(chunkIds.length);
  }

  await saveStore(redis, store);

  if (state.queue.length === 0) {
    state.status = 'done';
    state.completedAt = new Date().toISOString();
    pruneStaleEntries(store, state.relevantIds);
    await saveStore(redis, store);
    await saveJobState(redis, state);
    return { progress: summaryOf(state), journals: assembleFromStore(store, state.relevantIds) };
  }

  await saveJobState(redis, state);
  return { progress: summaryOf(state), journals: null };
}

/**
 * Call this from the cron route on every tick.
 *
 * `journals` is non-null ONLY on the tick where a run completes (queue
 * empty) -- that's the caller's signal to do final cache assembly. Every
 * other tick (mid-run, or already checked recently with nothing pending)
 * returns `journals: null`.
 *
 * The common case, after the first backfill: computeDelta finds nothing
 * new, the queue starts empty, and this returns `done` on the VERY FIRST
 * tick of the day -- no waiting around needed.
 *
 * `forceNewCheck` is for the once-a-day 7 AM refresh: it always starts a fresh
 * comparison against Zoho instead of waiting for the 20-hour gap (which could
 * otherwise make the daily run skip itself and leave yesterday's data in
 * place). Journals already stored are not fetched again, so it costs the same
 * handful of calls. `budgetMs` lets that run spend longer than one
 * 45-second batch, since it has the full function time to finish the delta.
 */
export async function advanceJournalJob(opts: { forceNewCheck?: boolean; budgetMs?: number } = {}): Promise<{
  progress: JournalJobProgress;
  journals: TrimmedJournal[] | null;
}> {
  const redis = getClient();
  if (!redis) {
    return {
      progress: { configured: false, status: 'not-started', fetchedThisRun: 0, remainingThisRun: 0, failedThisRun: 0, totalRelevant: 0 },
      journals: null,
    };
  }

  const existing = await getJobState(redis);

  const needsNewCheck =
    opts.forceNewCheck ||
    !existing ||
    (existing.status === 'done' &&
      (!existing.lastFullCheckAt ||
        (Date.now() - new Date(existing.lastFullCheckAt).getTime()) / 3_600_000 >= MIN_HOURS_BETWEEN_FULL_CHECKS));

  if (needsNewCheck) {
    const store = await loadStore(redis);
    const { relevantIds, needsFetch } = await computeDelta(store);
    const state: JournalJobState = {
      status: needsFetch.length === 0 ? 'done' : 'fetching-details',
      startedAt: new Date().toISOString(),
      completedAt: needsFetch.length === 0 ? new Date().toISOString() : undefined,
      lastFullCheckAt: new Date().toISOString(),
      queue: needsFetch.map((j) => j.journal_id),
      relevantIds,
      failedIds: [],
    };

    if (state.status === 'done') {
      pruneStaleEntries(store, relevantIds);
      await saveStore(redis, store);
      await saveJobState(redis, state);
      return { progress: summaryOf(state), journals: assembleFromStore(store, relevantIds) };
    }

    await saveJobState(redis, state);
    return processTick(redis, state, store, needsFetch, opts.budgetMs);
  }

  if (existing!.status === 'done') {
    return { progress: summaryOf(existing!), journals: null }; // checked recently, nothing pending
  }

  // Mid-run: continue the existing queue.
  const store = await loadStore(redis);
  const summaries = await listJournalSummaries();
  const byId = new Map(summaries.map((s) => [s.journal_id, s] as const));
  const queueSummaries = existing!.queue
    .map((id) => byId.get(id))
    .filter((s): s is ZohoJournalSummary => Boolean(s));
  return processTick(redis, existing!, store, queueSummaries, opts.budgetMs);
}

/** For a status-check endpoint / manual inspection -- doesn't advance anything. */
export async function getJournalJobProgress(): Promise<JournalJobProgress> {
  const redis = getClient();
  if (!redis) {
    return { configured: false, status: 'not-started', fetchedThisRun: 0, remainingThisRun: 0, failedThisRun: 0, totalRelevant: 0 };
  }
  const state = await getJobState(redis);
  if (!state) {
    return { configured: true, status: 'not-started', fetchedThisRun: 0, remainingThisRun: 0, failedThisRun: 0, totalRelevant: 0 };
  }
  return summaryOf(state);
}

/**
 * Runs the delta computation AND fetches every needed journal to
 * completion, no time-boxing -- for local dev (scripts/sync-cache.ts) and
 * the uncached live-fallback path, neither of which has a serverless
 * timeout to worry about. Uses and updates the SAME persistent store, so
 * a second run (even from a different entry point) only fetches what's
 * changed since the first -- including the very first time this runs
 * from a fresh, empty store, in which case it behaves the same as before
 * (a full ~20-25 minute pass), but never again after that.
 */
export async function syncJournalsToCompletion(
  onProgress?: (fetched: number, total: number) => void
): Promise<TrimmedJournal[]> {
  const redis = getClient();
  const store = redis ? await loadStore(redis) : ({} as DetailsStore);
  const { relevantIds, needsFetch } = await computeDelta(store);

  let fetched = 0;
  const LOCAL_CONCURRENCY = 5;
  for (let i = 0; i < needsFetch.length; i += LOCAL_CONCURRENCY) {
    const chunk = needsFetch.slice(i, i + LOCAL_CONCURRENCY);
    await Promise.all(chunk.map((s) => fetchAndStoreOne(store, s)));
    fetched += chunk.length;
    onProgress?.(fetched, needsFetch.length);
  }

  if (redis) {
    pruneStaleEntries(store, relevantIds);
    await saveStore(redis, store);
  }

  return assembleFromStore(store, relevantIds);
}


export interface JournalLinkageStats {
  journals: number;
  lines: number;
  linesWithContact: number;
}

export function journalLinkageStats(journals: TrimmedJournal[]): JournalLinkageStats {
  let lines = 0;
  let linesWithContact = 0;
  for (const j of journals) {
    for (const l of j.line_items) {
      lines += 1;
      if (l.contact_id) linesWithContact += 1;
    }
  }
  return { journals: journals.length, lines, linesWithContact };
}

/**
 * Safety net against a repeat of the silent failure that happened twice:
 * journals that "load fine" but carry no customer/vendor link, so every
 * contact's journal total quietly computes as zero. If we have a real
 * number of journals and not a single line points at a contact, something
 * is wrong with the field mapping -- fail loudly instead of caching it.
 */
export function assertJournalLinkage(journals: TrimmedJournal[]): void {
  const s = journalLinkageStats(journals);
  if (s.journals >= 50 && s.linesWithContact === 0) {
    throw new Error(
      `Fetched ${s.journals} journals (${s.lines} lines) but NONE of the lines is linked to a customer or vendor. ` +
        'The contact field mapping is broken; refusing to cache data that would silently ignore every journal.'
    );
  }
}

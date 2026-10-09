import { Redis } from '@upstash/redis';
import type { RawZohoData } from './zoho-raw-fetch';

// Every key this app touches is prefixed so it can safely share a Redis
// instance with other projects (e.g. an existing MIS dashboard's cache)
// without any risk of key collisions.
//
// Split into one key PER DATA TYPE rather than one giant blob for the
// whole snapshot. Found the hard way: Upstash enforces a 10MB max size
// per single request (their own documented limit), and at RPEL's scale
// (thousands of invoices/bills/payments across ~4,000 contacts) a single
// combined JSON blob exceeded that. Splitting means each write stays
// comfortably under the ceiling on its own, and stays that way even as
// the org's data grows further -- no single key has to hold everything.
const KEYS = {
  meta: 'rpel-apar:snapshot:meta',
  activeCustomers: 'rpel-apar:snapshot:customers',
  activeVendors: 'rpel-apar:snapshot:vendors',
  invoices: 'rpel-apar:snapshot:invoices',
  customerPayments: 'rpel-apar:snapshot:customer-payments',
  creditNotes: 'rpel-apar:snapshot:credit-notes',
  bills: 'rpel-apar:snapshot:bills',
  vendorPayments: 'rpel-apar:snapshot:vendor-payments',
  vendorCredits: 'rpel-apar:snapshot:vendor-credits',
  journals: 'rpel-apar:snapshot:journals',
  jnClean: 'rpel-apar:snapshot:jnclean',
  accounts: 'rpel-apar:snapshot:accounts',
  openingBalances: 'rpel-apar:snapshot:openingbalances',
  paymentTds: 'rpel-apar:snapshot:paymenttds',
  vendorLedgerToday: 'rpel-apar:snapshot:vendorledgertoday',
} as const;

let client: Redis | null = null;

function getClient(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null; // caching is optional -- callers fall back to live fetch
  if (!client) client = new Redis({ url, token });
  return client;
}

type CacheMeta = {
  fetchedAt: string;
  jnCleanStats?: RawZohoData['jnCleanStats'];
  openingBalanceStats?: RawZohoData['openingBalanceStats'];
  accountTypeStats?: RawZohoData['accountTypeStats'];
  paymentTdsStats?: RawZohoData['paymentTdsStats'];
  settleStats?: RawZohoData['settleStats'];
};

// The snapshot only changes once a day (the 7 AM refresh), so the parsed copy is kept in memory and
// re-used for as long as the small `meta` key still says the same `fetchedAt`. A page load then costs
// ONE tiny Redis read instead of fifteen large ones, and is instant. If Redis hiccups, the copy held in
// memory is served rather than an error (it is the same snapshot every visitor was already seeing).
let memo: { fetchedAt: string; data: RawZohoData } | null = null;

export async function getCachedRawData(): Promise<RawZohoData | null> {
  const redis = getClient();
  if (!redis) return null;
  try {
    const meta = await redis.get<CacheMeta>(KEYS.meta);
    if (meta && memo && memo.fetchedAt === meta.fetchedAt) return memo.data;

    const [activeCustomers, activeVendors, invoices, customerPayments, creditNotes, bills, vendorPayments, vendorCredits, journals, jnClean, ledgerAccounts, openingBalances, vendorPaymentTds, vendorLedgerToday] =
      await Promise.all([
        redis.get<RawZohoData['activeCustomers']>(KEYS.activeCustomers),
        redis.get<RawZohoData['activeVendors']>(KEYS.activeVendors),
        redis.get<RawZohoData['invoices']>(KEYS.invoices),
        redis.get<RawZohoData['customerPayments']>(KEYS.customerPayments),
        redis.get<RawZohoData['creditNotes']>(KEYS.creditNotes),
        redis.get<RawZohoData['bills']>(KEYS.bills),
        redis.get<RawZohoData['vendorPayments']>(KEYS.vendorPayments),
        redis.get<RawZohoData['vendorCredits']>(KEYS.vendorCredits),
        redis.get<RawZohoData['journals']>(KEYS.journals),
        redis.get<RawZohoData['jnClean']>(KEYS.jnClean),
        redis.get<RawZohoData['ledgerAccounts']>(KEYS.accounts),
        redis.get<RawZohoData['openingBalances']>(KEYS.openingBalances),
        redis.get<RawZohoData['vendorPaymentTds']>(KEYS.paymentTds),
        redis.get<RawZohoData['vendorLedgerToday']>(KEYS.vendorLedgerToday),
      ]);

    // If any piece is missing, treat the whole snapshot as absent rather
    // than silently computing against a partial dataset.
    if (!meta || !activeCustomers || !activeVendors || !invoices || !customerPayments || !creditNotes || !bills || !vendorPayments || !vendorCredits || !journals) {
      return memo?.data ?? null;
    }

    const data: RawZohoData = {
      fetchedAt: meta.fetchedAt,
      activeCustomers,
      activeVendors,
      invoices,
      customerPayments,
      creditNotes,
      bills,
      vendorPayments,
      vendorCredits,
      journals,
      // Absent in snapshots written before JN-Clean support: load as "not loaded".
      jnClean: jnClean ?? undefined,
      jnCleanStats: meta.jnCleanStats,
      ledgerAccounts: ledgerAccounts ?? undefined,
      openingBalances: openingBalances ?? undefined,
      openingBalanceStats: meta.openingBalanceStats,
      accountTypeStats: meta.accountTypeStats,
      vendorPaymentTds: vendorPaymentTds ?? undefined,
      paymentTdsStats: meta.paymentTdsStats,
      settleStats: meta.settleStats,
      vendorLedgerToday: vendorLedgerToday ?? undefined,
    };
    memo = { fetchedAt: meta.fetchedAt, data };
    return data;
  } catch (err) {
    console.error('Redis read failed:', err);
    // Same snapshot as before is better than an error page; with nothing held, callers fall back as they always did.
    return memo?.data ?? null;
  }
}

/** When the cached snapshot was read from Zoho (one tiny Redis read), or null if there is none. */
export async function getCachedFetchedAt(): Promise<string | null> {
  const redis = getClient();
  if (!redis) return null;
  try {
    const meta = await redis.get<CacheMeta>(KEYS.meta);
    return meta?.fetchedAt ?? null;
  } catch {
    return memo?.fetchedAt ?? null;
  }
}

const LOCK_KEY = 'rpel-apar:refresh-lock';

/**
 * One refresh at a time. Vercel can occasionally deliver the same scheduled run twice, and a second run
 * on top of the first would only double the load on Zoho. The lock expires on its own, so a run that
 * dies can never block tomorrow's. Returns false if another refresh holds it.
 */
export async function acquireRefreshLock(seconds = 330): Promise<boolean> {
  const redis = getClient();
  if (!redis) return true; // no shared store, nothing to collide with
  const r = await redis.set(LOCK_KEY, new Date().toISOString(), { nx: true, ex: seconds });
  return r === 'OK';
}

export async function releaseRefreshLock(): Promise<void> {
  const redis = getClient();
  if (!redis) return;
  try {
    await redis.del(LOCK_KEY);
  } catch {
    /* it expires by itself */
  }
}

export async function setCachedRawData(data: RawZohoData): Promise<void> {
  const redis = getClient();
  if (!redis) return; // no cache configured -- silently skip, not a hard failure
  // No TTL: the 7 AM job overwrites this once a day. If a day is somehow
  // missed, yesterday's data staying available is better than the
  // dashboard going empty.
  //
  // The data keys go first and `meta` (which carries fetchedAt, the version everyone compares against)
  // goes LAST, so anyone who sees the new fetchedAt is guaranteed to find the new data behind it.
  await Promise.all([
    redis.set(KEYS.activeCustomers, JSON.stringify(data.activeCustomers)),
    redis.set(KEYS.activeVendors, JSON.stringify(data.activeVendors)),
    redis.set(KEYS.invoices, JSON.stringify(data.invoices)),
    redis.set(KEYS.customerPayments, JSON.stringify(data.customerPayments)),
    redis.set(KEYS.creditNotes, JSON.stringify(data.creditNotes)),
    redis.set(KEYS.bills, JSON.stringify(data.bills)),
    redis.set(KEYS.vendorPayments, JSON.stringify(data.vendorPayments)),
    redis.set(KEYS.vendorCredits, JSON.stringify(data.vendorCredits)),
    redis.set(KEYS.journals, JSON.stringify(data.journals)),
    redis.set(KEYS.jnClean, JSON.stringify(data.jnClean ?? [])),
    redis.set(KEYS.accounts, JSON.stringify(data.ledgerAccounts ?? { receivable: [], payable: [] })),
    redis.set(KEYS.openingBalances, JSON.stringify(data.openingBalances ?? {})),
    redis.set(KEYS.paymentTds, JSON.stringify(data.vendorPaymentTds ?? {})),
    redis.set(KEYS.vendorLedgerToday, JSON.stringify(data.vendorLedgerToday ?? {})),
  ]);
  await redis.set(KEYS.meta, JSON.stringify({ fetchedAt: data.fetchedAt, jnCleanStats: data.jnCleanStats, openingBalanceStats: data.openingBalanceStats, accountTypeStats: data.accountTypeStats, paymentTdsStats: data.paymentTdsStats, settleStats: data.settleStats }));
  memo = null; // the next read picks the new snapshot up
}

export function isCacheConfigured(): boolean {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

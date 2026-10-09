// Zoho Books API client — handles OAuth token refresh and paginated requests.
//
// Requires these environment variables (see .env.local.example):
//   ZOHO_CLIENT_ID
//   ZOHO_CLIENT_SECRET
//   ZOHO_REFRESH_TOKEN
//   ZOHO_ORGANIZATION_ID
//   ZOHO_ACCOUNTS_BASE   (e.g. https://accounts.zoho.in for India-hosted accounts,
//                          https://accounts.zoho.com for US)
//   ZOHO_API_BASE        (e.g. https://www.zohoapis.in/books/v3 for India,
//                          https://www.zohoapis.com/books/v3 for US)
//
// Zoho access tokens expire after ~1 hour. We cache the token + expiry in module
// scope (fine for a serverless function's warm lifetime; a cold start just
// re-fetches) rather than persisting anywhere, since the refresh token itself
// is the durable credential.
//
// IMPORTANT — no date filtering happens here, deliberately. AP/AR is a
// cumulative balance-sheet figure, not a period flow: a `date_after` filter
// can only ever DROP a genuinely-still-open old invoice/bill, never add
// anything useful. Every list* function below fetches a contact's/org's
// COMPLETE history; the calculators decide what's relevant for a given
// "as of" period using each record's own `balance` field (which Zoho keeps
// correctly at 0 once something is fully settled, however old it is) and,
// for period-bounded views, each record's own issue date.

import { contactCurrencies, currencyCodeMap, foreignDoc, type ContactCurrencyBalance, type ForeignDoc } from './currency';

interface TokenCache {
  accessToken: string;
  expiresAt: number; // epoch ms
}

let tokenCache: TokenCache | null = null;
// De-duplicates concurrent refresh attempts: if many requests all see a
// missing/expired token at the same instant (easy to hit here, since AR
// and AP page loads fire in parallel, each triggering several Zoho calls
// of their own), each one used to independently fire its own OAuth
// refresh call -- which is exactly what tripped Zoho's "too many requests
// continuously" block on the token endpoint. Now every concurrent caller
// awaits the SAME in-flight refresh instead of starting a new one.
let inFlightRefresh: Promise<string> | null = null;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `Missing required environment variable: ${name}. Set it in .env.local (dev) or your Vercel project's Environment Variables (production).`
    );
  }
  return v;
}

async function getAccessToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) {
    return tokenCache.accessToken;
  }
  if (inFlightRefresh) {
    return inFlightRefresh;
  }

  inFlightRefresh = (async () => {
    try {
      const clientId = requireEnv('ZOHO_CLIENT_ID');
      const clientSecret = requireEnv('ZOHO_CLIENT_SECRET');
      const refreshToken = requireEnv('ZOHO_REFRESH_TOKEN');
      const accountsBase = requireEnv('ZOHO_ACCOUNTS_BASE');

      const url = new URL(`${accountsBase}/oauth/v2/token`);
      url.searchParams.set('refresh_token', refreshToken);
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('client_secret', clientSecret);
      url.searchParams.set('grant_type', 'refresh_token');

      const res = await fetch(url.toString(), { method: 'POST' });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Zoho OAuth token refresh failed (${res.status}): ${body}`);
      }
      const data = await res.json();
      if (!data.access_token) {
        throw new Error(`Zoho OAuth token refresh returned no access_token: ${JSON.stringify(data)}`);
      }

      tokenCache = {
        accessToken: data.access_token,
        expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
      };
      return tokenCache.accessToken;
    } finally {
      inFlightRefresh = null; // clear regardless of success/failure, so a future call can retry
    }
  })();

  return inFlightRefresh;
}

/**
 * Zoho allows 100 calls a minute per organization and BLOCKS the caller for a
 * while when that is exceeded ("For security reasons you have been blocked for
 * some time", HTTP 429, code 43). One sync makes several hundred calls, so the
 * code paces itself: every call, from every part of the app, first takes a slot
 * from a shared budget (default 80 per rolling minute, leaving headroom) and
 * waits for one if the budget is spent. If Zoho throttles anyway, the call
 * waits much longer and tries again.
 */
const recentCalls: number[] = [];

async function acquireSlot(): Promise<void> {
  const max = Number(process.env.ZOHO_MAX_PER_MIN ?? 80);
  const windowMs = Number(process.env.ZOHO_RATE_WINDOW_MS ?? 60_000);
  for (;;) {
    const now = Date.now();
    while (recentCalls.length && now - recentCalls[0] >= windowMs) recentCalls.shift();
    if (recentCalls.length < max) {
      recentCalls.push(now);
      return;
    }
    await new Promise((r) => setTimeout(r, windowMs - (now - recentCalls[0]) + 25));
  }
}

const THROTTLE_RE = /too many requests|rate limit|maximum number of requests|try after some time|blocked for some time/i;

async function fetchWithRetry(url: string, accessToken: string): Promise<{ ok: boolean; status: number; text: string }> {
  // Waits if throttled anyway (multiples of ZOHO_RETRY_BASE_MS, default 5s): 5s, 20s, 1m, 2m, 3m.
  const base = Number(process.env.ZOHO_RETRY_BASE_MS ?? 5000);
  const waits = [1, 4, 12, 24, 36].map((m) => m * base);
  for (let attempt = 0; ; attempt++) {
    await acquireSlot();
    const res = await fetch(url, {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
      // Zoho Books data changes throughout the day; don't let Next.js cache these.
      cache: 'no-store',
    });
    const text = await res.text();
    const throttled = !res.ok && (res.status === 429 || THROTTLE_RE.test(text));
    if (throttled && attempt < waits.length) {
      await new Promise((r) => setTimeout(r, waits[attempt]));
      continue;
    }
    return { ok: res.ok, status: res.status, text };
  }
}

/**
 * Makes a single request against the Zoho Books API, attaching the
 * organization_id query param and the Zoho-oauthtoken auth header.
 */
async function zohoRequest<T = unknown>(
  path: string,
  params: Record<string, string | number | boolean | undefined> = {}
): Promise<T> {
  const apiBase = requireEnv('ZOHO_API_BASE');
  const orgId = requireEnv('ZOHO_ORGANIZATION_ID');
  const accessToken = await getAccessToken();

  const url = new URL(`${apiBase}${path}`);
  url.searchParams.set('organization_id', orgId);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const res = await fetchWithRetry(url.toString(), accessToken);
  if (!res.ok) {
    throw new Error(`Zoho API request failed: ${path} (${res.status}): ${res.text}`);
  }
  return JSON.parse(res.text) as T;
}

/**
 * Fetches every page of a Zoho Books list endpoint and concatenates the
 * named array field. Zoho paginates at up to 200 records/page.
 */
async function zohoListAll<T = unknown>(
  path: string,
  arrayField: string,
  params: Record<string, string | number | boolean | undefined> = {}
): Promise<T[]> {
  const results: T[] = [];
  let page = 1;
  // Safety cap so a bug can't spin forever against a live API.
  for (let i = 0; i < 200; i++) {
    const data = (await zohoRequest<Record<string, unknown>>(path, {
      ...params,
      page,
      per_page: 200,
    })) as Record<string, unknown> & { page_context?: { has_more_page: boolean } };
    const chunk = (data[arrayField] as T[]) ?? [];
    results.push(...chunk);
    if (!data.page_context?.has_more_page) break;
    page += 1;
  }
  return results;
}

// ---- Contacts ----

/**
 * Everything on the dashboard is in the BASE currency (rupees). A bill, invoice,
 * payment or credit raised in another currency carries its own exchange rate,
 * and Zoho's own rupee balance for it is amount x that rate (a USD 24,000 bill
 * at 92.00885 is Rs 22,08,212, not Rs 24,000). Zoho also sends ready-made
 * rupee figures on some rows (bcy_*); those win when present.
 *
 * A record whose currency or rate is missing is left as-is (rate 1): it then
 * shows up as a flagged gap against Zoho's rupee ledger rather than silently
 * passing as rupees.
 */
function baseCurrency(): string {
  return (process.env.ZOHO_BASE_CURRENCY || 'INR').toUpperCase();
}

function rateOf(r: Record<string, unknown>): number {
  const code = String(r.currency_code ?? '').toUpperCase();
  const rate = Number(r.exchange_rate);
  if (!code || code === baseCurrency() || !(rate > 0)) return 1;
  return rate;
}

function inBase(r: Record<string, unknown>, value: unknown, bcyKey?: string): number | undefined {
  if (bcyKey && typeof r[bcyKey] === 'number') return r[bcyKey] as number;
  const v = Number(value);
  if (value === undefined || value === null || !Number.isFinite(v)) return undefined;
  return Math.round(v * rateOf(r) * 100) / 100;
}

/** spread helper: adds `foreign` to a document only when it is in a foreign currency (a rupee document gains no key at all) */
function fx(f: ForeignDoc | undefined): { foreign?: ForeignDoc } {
  return f ? { foreign: f } : {};
}

export interface ZohoContact {
  contact_id: string;
  contact_name: string;
  contact_type: 'customer' | 'vendor';
  status: string;
  // Zoho's own pre-computed per-contact balances, carried along ONLY as an
  // independent cross-check against our computed numbers (they can be
  // distorted by JN-Clean migration journals, so never used as the answer).
  outstanding_receivable_amount?: number;
  outstanding_payable_amount?: number;
  unused_credits_receivable_amount?: number;
  unused_credits_payable_amount?: number;
  /**
   * Zoho's own balance for this contact IN EACH CURRENCY (face amounts, not rupees). Present only for a contact that
   * has anything to do with a foreign currency; a rupee-only contact carries nothing. This is what a multi-currency
   * Statement is compared with, column by column, so no exchange rate has to be worked out or guessed.
   */
  by_currency?: ContactCurrencyBalance[];
}

/**
 * Active contacts, PLUS any inactive contact that still holds a balance.
 *
 * The original call was "keep Inactive out of scope entirely". That call was made
 * on a check of open Bills/Invoices, which found nothing. It missed balances that
 * live in manual journals: one inactive vendor (Harish Chauhan, journal 240, Rs 5,911)
 * still shows on Zoho's own ledger, so the Creditors total fell short of Zoho by
 * exactly that. Inactive contacts that are genuinely at zero stay out of the
 * dashboard (about 2,200 of them), so nothing changes for them. Only a contact whose
 * balance on Zoho's own record is more than Rs 1 is kept.
 *
 * To go back to Active-only, set INCLUDE_INACTIVE_WITH_BALANCE=false.
 */
function includeInactiveWithBalance(): boolean {
  return String(process.env.INCLUDE_INACTIVE_WITH_BALANCE ?? 'true').toLowerCase() !== 'false';
}

/** The contact's net balance on Zoho's own record (what they owe us for a customer, what we owe for a vendor). */
export function contactRecordBalance(c: ZohoContact): number {
  return c.contact_type === 'customer'
    ? (c.outstanding_receivable_amount ?? 0) - (c.unused_credits_receivable_amount ?? 0)
    : (c.outstanding_payable_amount ?? 0) - (c.unused_credits_payable_amount ?? 0);
}

/** Pure selection step (no network), kept separate so it can be tested. */
export function selectContacts(
  rows: Record<string, unknown>[],
  contactType: 'customer' | 'vendor',
  opts: { includeInactiveWithBalance?: boolean } = {}
): ZohoContact[] {
  const withInactive = opts.includeInactiveWithBalance ?? includeInactiveWithBalance();
  const codes = currencyCodeMap(rows);
  return rows
    .map((r) => trimContact(r, codes))
    .filter((c) => {
      if (c.contact_type !== contactType) return false;
      if (String(c.status).toLowerCase() === 'active') return true;
      return withInactive && Math.abs(contactRecordBalance(c)) > 1;
    });
}

export function trimContact(c: Record<string, unknown>, codeById?: Map<string, string>): ZohoContact {
  const by_currency = contactCurrencies(c, codeById);
  return {
    contact_id: c.contact_id as string,
    contact_name: c.contact_name as string,
    contact_type: c.contact_type as 'customer' | 'vendor',
    status: c.status as string,
    // The plain figures cover only the contact's own-currency transactions (a vendor
    // with a USD bill showed it nowhere); the _bcy figures are the full rupee balance.
    outstanding_receivable_amount: (c.outstanding_receivable_amount_bcy ?? c.outstanding_receivable_amount) as number | undefined,
    outstanding_payable_amount: (c.outstanding_payable_amount_bcy ?? c.outstanding_payable_amount) as number | undefined,
    unused_credits_receivable_amount: (c.unused_credits_receivable_amount_bcy ?? c.unused_credits_receivable_amount) as number | undefined,
    unused_credits_payable_amount: (c.unused_credits_payable_amount_bcy ?? c.unused_credits_payable_amount) as number | undefined,
    ...(by_currency ? { by_currency } : {}),
  };
}

export async function listActiveContacts(
  contactType: 'customer' | 'vendor'
): Promise<ZohoContact[]> {
  // Verified live: when filter_by=Status.Active is sent, Zoho IGNORES
  // contact_type (asking for customers returned vendors), so both calls
  // used to return the same combined ~4,000-contact list. Fetch by type
  // only (that filter does work on its own), then filter status and
  // type client-side.
  const raw = await zohoListAll<Record<string, unknown>>('/contacts', 'contacts', {
    contact_type: contactType,
  });
  return selectContacts(raw, contactType);
}

/** All-status version, for debug/investigative tools only (e.g.
 *  app/api/debug/inactive-contacts) -- NOT used by the production
 *  calculators, which stay Active-only per listActiveContacts() above. */
export async function listAllContactsAnyStatus(
  contactType: 'customer' | 'vendor'
): Promise<ZohoContact[]> {
  const raw = await zohoListAll<Record<string, unknown>>('/contacts', 'contacts', {
    contact_type: contactType,
  });
  const codes = currencyCodeMap(raw);
  return raw.map((r) => trimContact(r, codes));
}

// ---- Org-wide fetches — complete history, every time ----
//
// Fetching each transaction type ONCE for the whole org (paginated,
// ~200 records/call) and grouping by contact_id in memory, rather than
// once per contact, keeps this to a small, roughly-fixed number of calls
// (scales with total transaction volume, not contact headcount) — Zoho
// Books' rate limit (100 req/min, 1,000-10,000/day) is enforced per
// ORGANIZATION, shared with every other tool hitting this org.

export interface ZohoInvoice {
  invoice_id: string;
  customer_id: string;
  date: string;
  due_date: string;
  total: number;
  balance: number;
  status: string;
  /** only when raised in a foreign currency: Zoho's own rate and the face amounts (total / balance are the rupee values) */
  foreign?: ForeignDoc;
}

export async function listAllInvoices(extra: Record<string, string | number | boolean | undefined> = {}): Promise<ZohoInvoice[]> {
  const raw = await zohoListAll<Record<string, unknown>>('/invoices', 'invoices', extra);
  return raw.map((r) => ({
    invoice_id: r.invoice_id as string,
    customer_id: r.customer_id as string,
    date: r.date as string,
    due_date: r.due_date as string,
    total: inBase(r, r.total, 'bcy_total') as number,
    balance: inBase(r, r.balance, 'bcy_balance') as number,
    status: r.status as string,
    ...fx(foreignDoc(r, { total: r.total, open: r.balance })),
  }));
}

export interface ZohoCustomerPayment {
  payment_id: string;
  customer_id: string;
  date: string;
  amount: number;
  unused_amount?: number;
  status?: string;
  foreign?: ForeignDoc;
}

export async function listAllCustomerPayments(extra: Record<string, string | number | boolean | undefined> = {}): Promise<ZohoCustomerPayment[]> {
  const raw = await zohoListAll<Record<string, unknown>>('/customerpayments', 'customerpayments', extra);
  return raw.map((r) => ({
    payment_id: r.payment_id as string,
    customer_id: r.customer_id as string,
    date: r.date as string,
    amount: inBase(r, r.amount, 'bcy_amount') as number,
    unused_amount: inBase(r, r.unused_amount, 'bcy_unused_amount'),
    status: (r.status ?? r.payment_status) as string | undefined,
    ...fx(foreignDoc(r, { total: r.amount, open: r.unused_amount })),
  }));
}

export interface ZohoCreditNote {
  creditnote_id: string;
  customer_id: string;
  date: string;
  total: number;
  balance: number;
  status?: string;
  foreign?: ForeignDoc;
}

export async function listAllCreditNotes(extra: Record<string, string | number | boolean | undefined> = {}): Promise<ZohoCreditNote[]> {
  const raw = await zohoListAll<Record<string, unknown>>('/creditnotes', 'creditnotes', extra);
  return raw.map((r) => ({
    creditnote_id: r.creditnote_id as string,
    customer_id: r.customer_id as string,
    date: r.date as string,
    total: inBase(r, r.total, 'bcy_total') as number,
    balance: inBase(r, r.balance, 'bcy_balance') as number,
    status: r.status as string | undefined,
    ...fx(foreignDoc(r, { total: r.total, open: r.balance })),
  }));
}

export interface ZohoBill {
  bill_id: string;
  vendor_id: string;
  date: string;
  due_date: string;
  total: number;
  balance: number;
  status: string;
  foreign?: ForeignDoc;
}

export async function listAllBills(extra: Record<string, string | number | boolean | undefined> = {}): Promise<ZohoBill[]> {
  const raw = await zohoListAll<Record<string, unknown>>('/bills', 'bills', extra);
  return raw.map((r) => ({
    bill_id: r.bill_id as string,
    vendor_id: r.vendor_id as string,
    date: r.date as string,
    due_date: r.due_date as string,
    total: inBase(r, r.total, 'bcy_total') as number,
    balance: inBase(r, r.balance, 'bcy_balance') as number,
    status: r.status as string,
    ...fx(foreignDoc(r, { total: r.total, open: r.balance })),
  }));
}

export interface ZohoVendorPayment {
  payment_id: string;
  vendor_id: string;
  date: string;
  amount: number;
  unused_amount?: number;
  status?: string;
  foreign?: ForeignDoc;
}

export async function listAllVendorPayments(extra: Record<string, string | number | boolean | undefined> = {}): Promise<ZohoVendorPayment[]> {
  const raw = await zohoListAll<Record<string, unknown>>('/vendorpayments', 'vendorpayments', extra);
  return raw.map((r) => ({
    payment_id: r.payment_id as string,
    vendor_id: r.vendor_id as string,
    date: r.date as string,
    amount: inBase(r, r.amount, 'bcy_amount') as number,
    // Vendor payment LIST rows call the unapplied portion `balance`
    // (customer payments call it `unused_amount`). Verified live against
    // a real payment: amount 1,10,00,000, applied 91,15,356, balance
    // 18,84,644. Reading `unused_amount` here always returned undefined,
    // so every vendor's excess payments silently counted as zero.
    unused_amount: inBase(r, r.balance ?? r.unused_amount, 'bcy_balance'),
    status: r.status as string | undefined,
    ...fx(foreignDoc(r, { total: r.amount, open: r.balance ?? r.unused_amount })),
  }));
}

export interface ZohoVendorCredit {
  vendor_credit_id: string;
  vendor_id: string;
  date: string;
  total: number;
  balance: number;
  status?: string;
  foreign?: ForeignDoc;
}

export async function listAllVendorCredits(extra: Record<string, string | number | boolean | undefined> = {}): Promise<ZohoVendorCredit[]> {
  const raw = await zohoListAll<Record<string, unknown>>('/vendorcredits', 'vendor_credits', extra);
  return raw.map((r) => ({
    vendor_credit_id: r.vendor_credit_id as string,
    vendor_id: r.vendor_id as string,
    date: r.date as string,
    total: inBase(r, r.total, 'bcy_total') as number,
    balance: inBase(r, r.balance, 'bcy_balance') as number,
    status: r.status as string | undefined,
    ...fx(foreignDoc(r, { total: r.total, open: r.balance })),
  }));
}

// ---- Journals (for identifying genuine, non-JN-Clean manual adjustments) ----
//
// IMPORTANT, discovered the hard way: the List Journals endpoint does NOT
// return `line_items` at all -- only the single "Get journal" endpoint
// does. And the "JN-Clean-XXX" identifiers live in `entry_number`, not
// `reference_number` (which is blank on real entries). So a full,
// correct journal fetch is two-tier: a cheap list call to get IDs/dates/
// entry_number/status (used to exclude JN-Clean and Draft/Rejected/Void
// entries WITHOUT paying for a detail call), then individual detail
// calls -- one per surviving journal -- to get the line_items that
// actually say which contact and how much. See lib/journal-job.ts for
// how this gets chunked across multiple cron invocations, since RPEL has
// 2,000+ journals and Zoho's 100/min cap makes that ~22+ minutes of calls
// no single serverless invocation can fit.

export interface ZohoJournalSummary {
  journal_id: string;
  journal_date: string;
  entry_number: string;
  reference_number: string;
  status: string;
  total: number;
  /** Zoho's own rupee total for the journal. Differs from `total` when the journal is in a foreign currency. */
  bcy_total?: number;
  currency_id?: string;
  last_modified_time: string;
}

/**
 * True when a journal, seen only as a LIST row, is in a foreign currency: Zoho's rupee total
 * differs from the face total (journal 296: USD 1,398.47 face, Rs 1,30,735.48 in rupees).
 * This is how journals that need their rupee value read are found without fetching every one.
 */
export function isForeignJournal(s: { total?: number; bcy_total?: number }): boolean {
  return typeof s.total === 'number' && typeof s.bcy_total === 'number' && Math.abs(s.bcy_total - s.total) > 0.005;
}

/**
 * A journal line's value in RUPEES. Journals can be posted in a foreign currency, and then `amount`
 * is in that currency (journal 296 on Xiamen Ampace: USD 1,398.47, counted as Rs 1,398.47 for months,
 * when Zoho holds it at Rs 1,30,735.48). `bcy_amount` is Zoho's own rupee figure; if a response lacks it
 * the journal's exchange rate is applied; a rupee journal passes through unchanged.
 */
export function journalLineInBase(li: { amount?: number; bcy_amount?: number }, exchangeRate?: number): number {
  if (typeof li.bcy_amount === 'number') return li.bcy_amount;
  const amount = typeof li.amount === 'number' ? li.amount : 0;
  const rate = typeof exchangeRate === 'number' && exchangeRate > 0 ? exchangeRate : 1;
  return Math.round(amount * rate * 100) / 100;
}

export interface ZohoJournal {
  journal_id: string;
  journal_date: string;
  entry_number?: string;
  reference_number: string;
  journal_number_prefix?: string;
  journal_number_suffix?: string;
  status?: string;
  notes?: string;
  /** 'USD' for a dollar journal; the rupee value of each line is its bcy_amount. */
  currency_code?: string;
  exchange_rate?: number;
  /** Unapplied part of this journal's customer / vendor credits (detail response only). */
  available_receivables_credits?: number;
  available_payables_credits?: number;
  /** Invoices / bills this journal's credit was applied to (shape confirmed
   *  at runtime by /api/debug/probe; parsed defensively in jn-clean.ts). */
  invoices_credited?: unknown[];
  bills_credited?: unknown[];
  line_items: Array<{
    account_id: string;
    account_name: string;
    /** Zoho's name for the contact on a journal line -- holds the ID of a
     *  customer OR a vendor (per Zoho's API docs: "ID of the Customer/
     *  Vendor"). Empty string when the line has no contact. */
    customer_id?: string;
    /** Not actually sent by Zoho; kept optional purely as a fallback. */
    contact_id?: string;
    debit_or_credit: 'debit' | 'credit';
    /** In the journal's own currency. */
    amount: number;
    /** The same amount in rupees (Zoho's figure). */
    bcy_amount?: number;
  }>;
}

/**
 * Checks EVERY field that could plausibly carry a "JN-Clean" identifier --
 * entry_number (confirmed live to be where it actually lives),
 * reference_number (confirmed blank on real entries, checked anyway as a
 * pure safety net), and journal_number_prefix + journal_number_suffix
 * (only present on the single-record detail response; e.g. "SJ-" + "1406"
 * -> "SJ-1406", same value entry_number already carries in practice, but
 * checked independently in case that ever isn't true). Matching on ANY of
 * these is enough to exclude the entry -- this is deliberately
 * over-inclusive in what it checks, not narrowed to "the one field we
 * think is right."
 */
export function isJNCleanJournal(j: {
  entry_number?: string;
  reference_number?: string;
  journal_number_prefix?: string;
  journal_number_suffix?: string;
}): boolean {
  const candidates = [
    j.entry_number,
    j.reference_number,
    j.journal_number_prefix && j.journal_number_suffix
      ? `${j.journal_number_prefix}${j.journal_number_suffix}`
      : undefined,
  ];
  return candidates.some((v) => v && v.includes('JN-Clean'));
}

/** Cheap: list-level fields only, no line_items. Used to decide WHICH
 *  journals are even worth a detail call. */
export async function listJournalSummaries(): Promise<ZohoJournalSummary[]> {
  return zohoListAll<ZohoJournalSummary>('/journals', 'journals');
}

/** Expensive: one API call per journal. Only call this for journal IDs
 *  that survived the summary-level Draft/Rejected/Void and JN-Clean
 *  filtering. */
export async function getJournalDetail(journalId: string): Promise<ZohoJournal> {
  const data = await zohoRequest<{ journal: ZohoJournal }>(`/journals/${journalId}`);
  return data.journal;
}


/** Same call as getJournalDetail, but returns the untyped response so
 *  jn-clean.ts can read fields (like the applied invoices/bills) that the
 *  typed version doesn't model. */
export async function getJournalDetailRaw(journalId: string): Promise<Record<string, unknown>> {
  const data = await zohoRequest<{ journal: Record<string, unknown> }>(`/journals/${journalId}`);
  return data.journal;
}

/** One contact, fresh from Zoho (used by the verify route to re-read a
 *  flagged contact and rule out timing noise). */
export async function getContactFresh(contactId: string): Promise<ZohoContact> {
  const data = await zohoRequest<{ contact: Record<string, unknown> }>(`/contacts/${contactId}`);
  return trimContact(data.contact);
}

export type TryResult =
  | { ok: true; status: number; body: Record<string, unknown> }
  | { ok: false; status: number; error: string };

/**
 * Like zohoRequest, but never throws: a wrong guess at an endpoint comes
 * back as { ok: false, ... } so a probe can try several candidates and
 * report on each, instead of dying on the first miss.
 */
export async function zohoTry(
  path: string,
  params: Record<string, string | number | boolean | undefined> = {}
): Promise<TryResult> {
  try {
    const apiBase = requireEnv('ZOHO_API_BASE');
    const orgId = requireEnv('ZOHO_ORGANIZATION_ID');
    const accessToken = await getAccessToken();
    const url = new URL(`${apiBase}${path}`);
    url.searchParams.set('organization_id', orgId);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
    const res = await fetchWithRetry(url.toString(), accessToken);
    const text = res.text;
    if (!res.ok) return { ok: false, status: res.status, error: text.slice(0, 300) };
    try {
      return { ok: true, status: res.status, body: JSON.parse(text) as Record<string, unknown> };
    } catch {
      return { ok: false, status: res.status, error: 'Response was not JSON: ' + text.slice(0, 200) };
    }
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
  }
}


export interface AccountInfo {
  account_id: string;
  account_name: string;
  account_type: string;
}

/**
 * One account, looked up by id. (The unfiltered chart-of-accounts list hides
 * child accounts and stops after one page; asking for a specific id returns
 * the account even when it is a child or inactive.) null = not found / failed.
 */
export async function getAccountInfoDetailed(accountId: string): Promise<{ info: AccountInfo | null; reason?: string }> {
  const res = await zohoTry('/chartofaccounts', { account_id: accountId, filter_by: 'AccountType.All', per_page: 5 });
  if (!res.ok) return { info: null, reason: `HTTP ${res.status}: ${res.error.slice(0, 140)}` };
  const rows = Array.isArray(res.body.chartofaccounts) ? (res.body.chartofaccounts as Record<string, unknown>[]) : [];
  const hit = rows.find((r) => String(r.account_id) === accountId);
  if (!hit) return { info: null, reason: 'Zoho returned no account with that id' };
  return { info: { account_id: accountId, account_name: String(hit.account_name ?? ''), account_type: String(hit.account_type ?? '') } };
}

export async function getAccountInfo(accountId: string): Promise<AccountInfo | null> {
  return (await getAccountInfoDetailed(accountId)).info;
}

export interface ContactOpeningBalance {
  receivable: number;
  payable: number;
  docId?: string;
}

/** The outstanding opening balance of one contact (the single-contact
 *  lookup carries it; the contact list does not). */
export async function getContactOpeningBalance(contactId: string): Promise<ContactOpeningBalance> {
  const data = await zohoRequest<{ contact: Record<string, unknown> }>(`/contacts/${contactId}`);
  const c = data.contact;
  const first = Array.isArray(c.opening_balances) ? (c.opening_balances[0] as Record<string, unknown> | undefined) : undefined;
  const docId = first ? String(first.ob_invoice_id ?? first.ob_bill_id ?? '') : '';
  return {
    receivable: Number(c.outstanding_ob_receivable_amount) || 0,
    payable: Number(c.outstanding_ob_payable_amount) || 0,
    docId: docId || undefined,
  };
}


/**
 * TDS still withheld on the unused part of one vendor payment, in rupees. The payment LIST does
 * not carry it; the payment's own record does (balance_tax_amount_withheld).
 */
export async function getVendorPaymentTds(paymentId: string): Promise<number> {
  const data = await zohoRequest<{ vendorpayment: Record<string, unknown> }>(`/vendorpayments/${paymentId}`);
  const p = data.vendorpayment;
  const v = Number(p.balance_tax_amount_withheld);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.round(v * rateOf(p) * 100) / 100;
}

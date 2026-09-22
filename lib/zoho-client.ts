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

interface TokenCache {
  accessToken: string;
  expiresAt: number; // epoch ms
}

let tokenCache: TokenCache | null = null;

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
    // Zoho returns expires_in in seconds (typically 3600)
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  return tokenCache.accessToken;
}

interface ZohoListResponse<T> {
  page_context?: {
    page: number;
    per_page: number;
    has_more_page: boolean;
    report_name?: string;
  };
  [key: string]: unknown;
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

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    // Zoho Books data changes throughout the day; don't let Next.js cache these.
    cache: 'no-store',
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Zoho API request failed: ${path} (${res.status}): ${body}`);
  }
  return res.json() as Promise<T>;
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

export interface ZohoContact {
  contact_id: string;
  contact_name: string;
  contact_type: 'customer' | 'vendor';
  status: string;
}

export async function listActiveContacts(
  contactType: 'customer' | 'vendor'
): Promise<ZohoContact[]> {
  return zohoListAll<ZohoContact>('/contacts', 'contacts', {
    contact_type: contactType,
    filter_by: 'Status.Active',
  });
}

// ---- AR side: Invoices, Customer Payments, Credit Notes ----

export interface ZohoInvoice {
  invoice_id: string;
  customer_id: string;
  date: string;
  due_date: string;
  total: number;
  balance: number;
  status: string;
}

export async function listInvoicesForCustomer(
  customerId: string,
  dateAfter?: string
): Promise<ZohoInvoice[]> {
  return zohoListAll<ZohoInvoice>('/invoices', 'invoices', {
    customer_id: customerId,
    ...(dateAfter ? { date_after: dateAfter } : {}),
  });
}

export interface ZohoCustomerPayment {
  payment_id: string;
  customer_id: string;
  date: string;
  amount: number;
}

export async function listCustomerPayments(
  customerId: string,
  dateAfter?: string
): Promise<ZohoCustomerPayment[]> {
  return zohoListAll<ZohoCustomerPayment>('/customerpayments', 'customerpayments', {
    customer_id: customerId,
    ...(dateAfter ? { date_after: dateAfter } : {}),
  });
}

export interface ZohoCreditNote {
  creditnote_id: string;
  customer_id: string;
  date: string;
  total: number;
  balance: number;
}

export async function listCreditNotesForCustomer(
  customerId: string,
  dateAfter?: string
): Promise<ZohoCreditNote[]> {
  return zohoListAll<ZohoCreditNote>('/creditnotes', 'creditnotes', {
    customer_id: customerId,
    ...(dateAfter ? { date_after: dateAfter } : {}),
  });
}

// ---- AP side: Bills, Vendor Payments, Vendor Credits ----

export interface ZohoBill {
  bill_id: string;
  vendor_id: string;
  date: string;
  due_date: string;
  total: number;
  balance: number;
  status: string;
}

export async function listBillsForVendor(
  vendorId: string,
  dateAfter?: string
): Promise<ZohoBill[]> {
  return zohoListAll<ZohoBill>('/bills', 'bills', {
    vendor_id: vendorId,
    ...(dateAfter ? { date_after: dateAfter } : {}),
  });
}

export interface ZohoVendorPayment {
  payment_id: string;
  vendor_id: string;
  date: string;
  amount: number;
}

export async function listVendorPayments(
  vendorId: string,
  dateAfter?: string
): Promise<ZohoVendorPayment[]> {
  return zohoListAll<ZohoVendorPayment>('/vendorpayments', 'vendorpayments', {
    vendor_id: vendorId,
    ...(dateAfter ? { date_after: dateAfter } : {}),
  });
}

export interface ZohoVendorCredit {
  vendor_credit_id: string;
  vendor_id: string;
  date: string;
  total: number;
  balance: number;
}

export async function listVendorCreditsForVendor(
  vendorId: string,
  dateAfter?: string
): Promise<ZohoVendorCredit[]> {
  return zohoListAll<ZohoVendorCredit>('/vendorcredits', 'vendor_credits', {
    vendor_id: vendorId,
    ...(dateAfter ? { date_after: dateAfter } : {}),
  });
}

// ---- Journals (for identifying genuine, non-JN-Clean manual adjustments) ----

export interface ZohoJournal {
  journal_id: string;
  journal_date: string;
  reference_number: string;
  notes?: string;
  line_items: Array<{
    account_id: string;
    account_name: string;
    contact_id?: string;
    debit_or_credit: 'debit' | 'credit';
    amount: number;
  }>;
}

export async function listJournals(dateAfter?: string): Promise<ZohoJournal[]> {
  return zohoListAll<ZohoJournal>('/journals', 'journals', {
    ...(dateAfter ? { date_after: dateAfter } : {}),
  });
}

// Foreign-currency helpers. Pure: no network, no clock, nothing is guessed.
//
// The dashboard's totals are in rupees and always come from Zoho's own rupee values. What was missing is the
// FOREIGN side of the picture, which is needed to prove a foreign-currency contact against its Statement:
//
//   1. Zoho's balance for the contact IN EACH CURRENCY (a Statement prints one column per currency), and
//   2. the exchange rate Zoho itself put on every foreign bill / invoice / payment / credit.
//
// Both are read from Zoho and kept in the cache, so nothing has to be worked out from the Statement or typed in.
//
// Where Zoho keeps them:
//   - contact LIST row : the plain figures (outstanding_payable_amount ...) are in the contact's OWN currency
//                        (currency_code); every other currency is in non_default_currency_values[], which names
//                        the currency by id only (currency_id), so ids are turned into codes with a map built
//                        from the other rows of the same list (a USD vendor's row has both currency_id and code).
//   - single contact   : vendor_currency_summaries[] / customer_currency_summaries[], one entry per currency, code included.
//   - documents        : currency_code + exchange_rate on every bill, invoice, payment and credit.

/** One contact's balance in one currency, in that currency (not rupees). Positive = payable (vendor) / receivable (customer). */
export interface ContactCurrencyBalance {
  currency: string;
  outstanding: number;
  unused: number;
  /** outstanding - unused */
  net: number;
}

/** The foreign side of a document, present ONLY on documents raised in a foreign currency (so it adds nothing to the cache otherwise). */
export interface ForeignDoc {
  currency: string;
  /** Zoho's exchange rate on this document. 0 = the row came without one. */
  rate: number;
  /** face amount in `currency`: a bill / invoice / credit total, or a payment's amount */
  total?: number;
  /** face amount in `currency` still open: the balance, or the unapplied part of a payment */
  open?: number;
}

export function baseCurrencyCode(): string {
  return (process.env.ZOHO_BASE_CURRENCY || 'INR').toUpperCase();
}

const num = (v: unknown): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const clean = (n: number) => Math.round(n * 1e6) / 1e6; // no floating-point dust (24000.000000001)

/** currency_id -> code, learnt from every row that names both */
export function currencyCodeMap(rows: Record<string, unknown>[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of rows) {
    const id = r.currency_id;
    const code = r.currency_code;
    if (id !== undefined && id !== null && String(id) && typeof code === 'string' && code) m.set(String(id), code.toUpperCase());
  }
  return m;
}

/** What a currency is called when its id could not be turned into a code (shown, never silently dropped) */
export const unknownCurrency = (id: unknown) => `CUR#${String(id)}`;

/**
 * The contact's balances per currency, or undefined when the contact has nothing to do with a foreign currency
 * (the vast majority: nothing is stored for them).
 */
export function contactCurrencies(c: Record<string, unknown>, codeById: Map<string, string> = new Map()): ContactCurrencyBalance[] | undefined {
  const side = c.contact_type === 'customer' ? 'receivable' : 'payable';
  const other = side === 'receivable' ? 'payable' : 'receivable';
  const pick = (o: Record<string, unknown>, kind: 'outstanding' | 'unused_credits') =>
    num(o[`${kind}_${side}_amount`]) ?? num(o[`${kind}_${other}_amount`]) ?? 0;

  const out: ContactCurrencyBalance[] = [];
  const add = (code: string, o: Record<string, unknown>) => {
    const currency = code.toUpperCase();
    if (!currency || out.some((e) => e.currency === currency)) return; // the first entry for a currency wins
    const outstanding = clean(pick(o, 'outstanding'));
    const unused = clean(pick(o, 'unused_credits'));
    out.push({ currency, outstanding, unused, net: clean(outstanding - unused) });
  };

  const summaries = Array.isArray(c.vendor_currency_summaries) && c.vendor_currency_summaries.length ? c.vendor_currency_summaries : Array.isArray(c.customer_currency_summaries) ? c.customer_currency_summaries : [];
  if (summaries.length) {
    for (const s of summaries as Record<string, unknown>[]) add(String(s.currency_code ?? (s.currency_id !== undefined ? codeById.get(String(s.currency_id)) ?? unknownCurrency(s.currency_id) : '')), s);
  } else {
    const own = String(c.currency_code ?? '');
    if (own) add(own, c);
    if (Array.isArray(c.non_default_currency_values)) {
      for (const nd of c.non_default_currency_values as Record<string, unknown>[]) {
        add(String(nd.currency_code ?? codeById.get(String(nd.currency_id)) ?? unknownCurrency(nd.currency_id)), nd);
      }
    }
  }
  const base = baseCurrencyCode();
  return out.some((e) => e.currency !== base) ? out : undefined;
}

/** The foreign side of a document row (undefined for a rupee document). `faces` are the row's raw face amounts. */
export function foreignDoc(r: Record<string, unknown>, faces: { total?: unknown; open?: unknown }): ForeignDoc | undefined {
  const currency = String(r.currency_code ?? '').toUpperCase();
  if (!currency || currency === baseCurrencyCode()) return undefined;
  const rate = num(r.exchange_rate);
  const d: ForeignDoc = { currency, rate: rate !== undefined && rate > 0 ? rate : 0 };
  const total = num(faces.total);
  const open = num(faces.open);
  if (total !== undefined) d.total = total;
  if (open !== undefined) d.open = open;
  return d;
}

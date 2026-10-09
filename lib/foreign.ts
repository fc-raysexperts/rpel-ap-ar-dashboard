// Foreign-currency contacts, proven against Zoho's own figures. Pure: works on the cached data, no network.
//
// The old way to check a foreign vendor was to ask "what rate makes the numbers fit?" -- a guess that had to be
// repeated for every new vendor. This does the opposite. Everything comes from Zoho:
//
//   - the contact's balance IN EACH CURRENCY (ContactCurrencyBalance, from the contact record) -- compared directly
//     with the matching column of the Statement, so no rate is needed to say whether a Statement agrees;
//   - the exchange rate Zoho put on every open foreign bill / invoice / payment / credit (ForeignDoc) -- which gives
//     the rupee value of each, and the rate Zoho is really using for the contact's balance;
//   - Zoho's rupee value for the contact as a whole (bcy) -- the dashboard's number, and the yardstick for the rest.
//
// What is left over after the open foreign documents (a rupee residual from an advance and a journal that were
// cleared at different rates, as on Xiamen) is shown as the "exchange difference", not hidden and not guessed.

import type { RawZohoData } from './zoho-raw-fetch';
import { contactRecordBalance, type ZohoContact } from './zoho-client';
import { baseCurrencyCode } from './currency';
import { isExcludedStatus } from './status-filter';
import { accountSets, lineHitsLedger } from './accounts';
import { unusedFraction } from './open-items';

const FACE_TOL = 0.01; // a foreign amount agrees within one cent
const RUPEE_TOL = 1; // the established Re. 1 rule
const r2 = (n: number) => Math.round(n * 100) / 100;

export interface ForeignDocLine {
  kind: 'bill' | 'invoice' | 'payment' | 'credit' | 'journal';
  id: string;
  date: string;
  /** signed in the contact's direction: + adds to what is owed on the contact's side, - reduces it (an unapplied payment, a credit) */
  face: number;
  /** Zoho's exchange rate on the document (0 = the row came without one) */
  rate: number;
  /** Zoho's own rupee value of the open part, signed like `face` */
  rupees: number;
}

export interface ForeignCurrencyLine {
  currency: string;
  /** Zoho's contact record in this currency; null when the cache was written before per-currency balances were kept */
  zohoFace: number | null;
  /** the open foreign documents behind it */
  documents: ForeignDocLine[];
  documentsFace: number;
  documentsRupees: number;
  /** do the open documents add up to Zoho's balance in this currency? (null = nothing to compare with) */
  documentsAgree: boolean | null;
  /** the rate the open documents carry together: documentsRupees / documentsFace (null if they net to nothing) */
  documentsRate: number | null;
  /** Zoho's rupee value of this currency's balance; known when it is the contact's only foreign currency */
  zohoRupees: number | null;
  /** the rate Zoho is using for the balance: zohoRupees / zohoFace */
  zohoRate: number | null;
}

export interface ForeignContactView {
  contactId: string;
  name: string;
  side: 'customer' | 'vendor';
  /**
   * open     : a balance in a foreign currency
   * residual : no foreign balance, but a rupee difference left over from foreign settlements (Xiamen)
   * settled  : foreign documents exist, all cleared, nothing left over
   * tag      : set up with a foreign currency, nothing transacted
   */
  status: 'open' | 'residual' | 'settled' | 'tag';
  hasContactCurrencies: boolean;
  /** Zoho's rupee balance for the contact (what the dashboard shows) */
  zohoRupees: number;
  /** Zoho's balance in the base-currency column (the rupee section of the Statement) */
  baseFace: number | null;
  /** Zoho's rupee value of everything foreign: zohoRupees - baseFace */
  foreignRupees: number | null;
  currencies: ForeignCurrencyLine[];
  /** rupees Zoho carries on the foreign side beyond the open foreign documents (0 when they explain it all) */
  exchangeDifference: number | null;
  problems: string[];
}

interface ContactDocs {
  lines: Map<string, ForeignDocLine[]>; // currency -> open foreign documents
  any: boolean; // has foreign documents of any state
}

function docsOf(raw: RawZohoData, side: 'customer' | 'vendor', id: string): ContactDocs {
  const lines = new Map<string, ForeignDocLine[]>();
  let any = false;
  const put = (currency: string, l: ForeignDocLine) => {
    const arr = lines.get(currency) ?? [];
    arr.push(l);
    lines.set(currency, arr);
  };
  const doc = (
    kind: ForeignDocLine['kind'],
    d: { foreign?: { currency: string; rate: number; open?: number }; date: string },
    docId: string,
    status: string | undefined,
    rupees: number | undefined,
    sign: 1 | -1
  ) => {
    if (!d.foreign) return;
    any = true;
    const open = d.foreign.open ?? 0;
    if (open <= 0 || isExcludedStatus(status)) return;
    put(d.foreign.currency, { kind, id: docId, date: d.date, face: sign * open, rate: d.foreign.rate, rupees: sign * (rupees ?? open * d.foreign.rate) });
  };
  if (side === 'vendor') {
    for (const b of raw.bills) if (b.vendor_id === id) doc('bill', b, b.bill_id, b.status, b.balance, 1);
    for (const p of raw.vendorPayments) if (p.vendor_id === id) doc('payment', p, p.payment_id, p.status, p.unused_amount, -1);
    for (const c of raw.vendorCredits) if (c.vendor_id === id) doc('credit', c, c.vendor_credit_id, c.status, c.balance, -1);
  } else {
    for (const i of raw.invoices) if (i.customer_id === id) doc('invoice', i, i.invoice_id, i.status, i.balance, 1);
    for (const p of raw.customerPayments) if (p.customer_id === id) doc('payment', p, p.payment_id, p.status, p.unused_amount, -1);
    for (const c of raw.creditNotes) if (c.customer_id === id) doc('credit', c, c.creditnote_id, c.status, c.balance, -1);
  }

  // Journals in a foreign currency count the way the calculators count them: a line in the "owed" direction in full,
  // a credit-like line only for its unused part. They are part of Zoho's balance in that currency, so they belong here.
  const base = baseCurrencyCode();
  const ledgerSide = side === 'vendor' ? 'payable' : 'receivable';
  const sets = accountSets(raw.ledgerAccounts);
  for (const j of raw.journals) {
    const currency = String(j.currency_code ?? '').toUpperCase();
    if (!currency || currency === base) continue;
    const unused = unusedFraction(j, ledgerSide, sets);
    for (const l of j.line_items) {
      if (l.contact_id !== id || !lineHitsLedger(sets, ledgerSide, l.account_id)) continue;
      any = true;
      const owedDirection = side === 'vendor' ? l.debit_or_credit === 'credit' : l.debit_or_credit === 'debit';
      const share = owedDirection ? 1 : unused;
      const sign = owedDirection ? 1 : -1;
      if (share <= 0 || l.face_amount === undefined) continue;
      put(currency, { kind: 'journal', id: j.entry_number || j.journal_id, date: j.journal_date, face: sign * l.face_amount * share, rate: j.exchange_rate ?? 0, rupees: sign * l.amount * share });
    }
  }
  return { lines, any };
}

/** One contact's foreign-currency picture, or null when it has nothing to do with a foreign currency. */
export function foreignBreakdown(raw: RawZohoData, contact: ZohoContact): ForeignContactView | null {
  const side = contact.contact_type;
  const docs = docsOf(raw, side, contact.contact_id);
  const by = contact.by_currency;
  if (!by && !docs.any) return null;

  const base = baseCurrencyCode();
  const zohoRupees = contactRecordBalance(contact);
  const baseFace = by ? (by.find((e) => e.currency === base)?.net ?? 0) : null;
  const foreignRupees = baseFace === null ? null : r2(zohoRupees - baseFace);

  const codes = [...new Set([...(by ?? []).filter((e) => e.currency !== base).map((e) => e.currency), ...docs.lines.keys()])];
  // with exactly one foreign currency the contact's whole foreign rupee value belongs to it, and so does its rate
  const single = by ? by.filter((e) => e.currency !== base).length === 1 : false;

  const currencies: ForeignCurrencyLine[] = codes.map((currency) => {
    const documents = (docs.lines.get(currency) ?? []).sort((a, b) => a.date.localeCompare(b.date));
    const documentsFace = r2(documents.reduce((s, d) => s + d.face, 0));
    const documentsRupees = r2(documents.reduce((s, d) => s + d.rupees, 0));
    const zohoFace = by ? (by.find((e) => e.currency === currency)?.net ?? 0) : null;
    const zohoRupeesHere = single && foreignRupees !== null ? foreignRupees : null;
    return {
      currency,
      zohoFace,
      documents,
      documentsFace,
      documentsRupees,
      documentsAgree: zohoFace === null ? null : Math.abs(documentsFace - zohoFace) <= FACE_TOL,
      documentsRate: Math.abs(documentsFace) > FACE_TOL ? documentsRupees / documentsFace : null,
      zohoRupees: zohoRupeesHere,
      zohoRate: zohoRupeesHere !== null && zohoFace !== null && Math.abs(zohoFace) > FACE_TOL ? zohoRupeesHere / zohoFace : null,
    };
  });

  const documentsRupeesTotal = currencies.reduce((s, c) => s + c.documentsRupees, 0);
  const exchangeDifference = foreignRupees === null ? null : r2(foreignRupees - documentsRupeesTotal);

  const problems: string[] = [];
  for (const c of currencies) {
    if (c.documentsAgree === false) problems.push(`${c.currency}: Zoho's contact record says ${c.currency} ${c.zohoFace}, the open documents add up to ${c.currency} ${c.documentsFace}`);
    if (c.documents.some((d) => d.rate === 0)) problems.push(`${c.currency}: a document came from Zoho without an exchange rate`);
  }
  if (exchangeDifference !== null && Math.abs(exchangeDifference) > RUPEE_TOL) problems.push(`Rs ${exchangeDifference} on the foreign side of Zoho's rupee balance is not explained by the open foreign documents`);
  for (const e of by ?? []) if (e.currency.startsWith('CUR#') && (Math.abs(e.net) > FACE_TOL || Math.abs(e.outstanding) > FACE_TOL)) problems.push(`a balance in a currency whose code could not be read (${e.currency})`);

  const anyForeignFace = currencies.some((c) => Math.abs(c.zohoFace ?? c.documentsFace) > FACE_TOL);
  const status: ForeignContactView['status'] = anyForeignFace
    ? 'open'
    : foreignRupees !== null && Math.abs(foreignRupees) > RUPEE_TOL
      ? 'residual'
      : docs.any
        ? 'settled'
        : 'tag';

  return { contactId: contact.contact_id, name: contact.contact_name, side, status, hasContactCurrencies: by !== undefined, zohoRupees, baseFace, foreignRupees, currencies, exchangeDifference, problems };
}

/** Every customer / vendor with something foreign about it, largest rupee balance first. */
export function foreignContacts(raw: RawZohoData): ForeignContactView[] {
  const withForeignDocs = new Set<string>();
  for (const d of raw.invoices) if (d.foreign) withForeignDocs.add(d.customer_id);
  for (const d of raw.customerPayments) if (d.foreign) withForeignDocs.add(d.customer_id);
  for (const d of raw.creditNotes) if (d.foreign) withForeignDocs.add(d.customer_id);
  for (const d of raw.bills) if (d.foreign) withForeignDocs.add(d.vendor_id);
  for (const d of raw.vendorPayments) if (d.foreign) withForeignDocs.add(d.vendor_id);
  for (const d of raw.vendorCredits) if (d.foreign) withForeignDocs.add(d.vendor_id);
  for (const j of raw.journals) if (j.currency_code && j.currency_code.toUpperCase() !== baseCurrencyCode()) for (const l of j.line_items) if (l.contact_id) withForeignDocs.add(l.contact_id);

  const out: ForeignContactView[] = [];
  for (const c of [...raw.activeCustomers, ...raw.activeVendors]) {
    if (!c.by_currency && !withForeignDocs.has(c.contact_id)) continue;
    const v = foreignBreakdown(raw, c);
    if (v) out.push(v);
  }
  return out.sort((a, b) => Math.abs(b.zohoRupees) - Math.abs(a.zohoRupees));
}

// ------------------------------------------------ Statement vs Zoho, column by column

export interface StatementColumn {
  currency: string;
  /** the Balance Due printed for this currency */
  printed: number;
}

export interface ColumnVerdict {
  currency: string;
  statement: number;
  zoho: number;
  diff: number;
  ok: boolean;
}

/**
 * Each currency column of the Statement against Zoho's balance for the contact in that currency. No exchange rate
 * is involved. null when the cache has no per-currency balances for the contact (written before this was kept).
 */
export function compareColumns(view: ForeignContactView, columns: StatementColumn[]): ColumnVerdict[] | null {
  if (!view.hasContactCurrencies) return null;
  const base = baseCurrencyCode();
  const codes = [...new Set([base, ...view.currencies.map((c) => c.currency), ...columns.map((c) => c.currency)])];
  return codes.map((currency) => {
    const statement = columns.find((c) => c.currency === currency)?.printed ?? 0;
    const zoho = currency === base ? (view.baseFace ?? 0) : (view.currencies.find((c) => c.currency === currency)?.zohoFace ?? 0);
    const diff = statement - zoho;
    return { currency, statement, zoho, diff, ok: Math.abs(diff) <= (currency === base ? RUPEE_TOL : FACE_TOL) };
  });
}

export interface StatementVerdict {
  columns: ColumnVerdict[];
  columnsMatch: boolean;
  /** Zoho's rupee value of the foreign part (taken from Zoho, not worked out from the Statement) */
  foreignRupees: number;
  /** the rupee figure the Statement stands for: its rupee section (as the rule in force reads it) + Zoho's foreign part */
  target: number;
  diff: number;
  match: boolean;
}

/**
 * The verdict for one foreign-currency Statement: every column agrees with Zoho's contact record, and the dashboard's
 * rupee figure equals the Statement's rupee section plus Zoho's own rupee value of the foreign part.
 */
export function statementVerdict(view: ForeignContactView, columns: StatementColumn[], baseTarget: number, dashboard: number): StatementVerdict | null {
  const cols = compareColumns(view, columns);
  if (!cols || view.foreignRupees === null) return null;
  const target = baseTarget + view.foreignRupees;
  const diff = dashboard - target;
  const columnsMatch = cols.every((c) => c.ok);
  return { columns: cols, columnsMatch, foreignRupees: view.foreignRupees, target, diff, match: columnsMatch && Math.abs(diff) <= RUPEE_TOL };
}

// ------------------------------------------------ plain-text description (sync-cache, check-statement)

const money = (n: number, d = 2) => n.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
const face = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
const rs = (n: number) => `${n < 0 ? '-' : ''}Rs ${money(Math.abs(n))}`;
const KIND: Record<ForeignDocLine['kind'], string> = { bill: 'Bill', invoice: 'Invoice', payment: 'Payment', credit: 'Credit', journal: 'Journal' };

/** Lines describing a foreign contact in Zoho's own terms (rates are the ones on the documents / implied by Zoho's rupee figure). */
export function describeForeign(v: ForeignContactView): string[] {
  const out: string[] = [];
  out.push(`${v.name} [${v.side}]  Zoho rupee balance ${rs(v.zohoRupees)}`);
  if (v.baseFace !== null) out.push(`  rupee column: ${rs(v.baseFace)}`);
  for (const c of v.currencies) {
    const bal = c.zohoFace === null ? `(open documents) ${c.currency} ${face(c.documentsFace)}` : `${c.currency} ${face(c.zohoFace)}`;
    const rate = c.zohoRate !== null ? ` = ${rs(c.zohoRupees ?? 0)} at Zoho's rate ${c.zohoRate.toFixed(5)}` : c.documentsRate !== null ? ` = ${rs(c.documentsRupees)} at the documents' rate ${c.documentsRate.toFixed(5)}` : '';
    out.push(`  ${bal}${rate}${c.documentsAgree === true ? '   [open documents agree]' : c.documentsAgree === false ? '   [OPEN DOCUMENTS DO NOT AGREE]' : ''}`);
    for (const d of c.documents) out.push(`      ${KIND[d.kind].padEnd(8)} ${d.id}  ${d.date}  ${c.currency} ${face(d.face)} @ ${d.rate || '(no rate)'} = ${rs(d.rupees)}`);
  }
  if (v.exchangeDifference !== null && Math.abs(v.exchangeDifference) > RUPEE_TOL) {
    out.push(`  NOT EXPLAINED by the open foreign documents: ${rs(v.exchangeDifference)} of Zoho's rupee value for the foreign side`);
  }
  if (v.status === 'residual' && v.foreignRupees !== null) {
    out.push(`  the foreign balance is nil, yet the foreign side nets to ${rs(v.foreignRupees)}: the documents above were cleared at different rates, and Zoho's rupee ledger already nets it (a rupee journal clears it on the Statement)`);
  }
  for (const p of v.problems) out.push(`  CHECK: ${p}`);
  if (!v.hasContactCurrencies) out.push('  (this cache was written before per-currency balances were kept: run npm run sync-cache to store them)');
  return out;
}

/** compact JSON for /api/debug/reconcile */
export function foreignSummary(v: ForeignContactView) {
  return {
    contact: v.name,
    side: v.side,
    status: v.status,
    zohoRupeeBalance: Math.round(v.zohoRupees * 100) / 100,
    rupeeColumn: v.baseFace,
    foreignPartInRupees: v.foreignRupees,
    exchangeDifference: v.exchangeDifference,
    currencies: v.currencies.map((c) => ({
      currency: c.currency,
      zohoBalance: c.zohoFace,
      zohoRate: c.zohoRate === null ? null : Number(c.zohoRate.toFixed(5)),
      openDocumentsBalance: c.documentsFace,
      openDocumentsRate: c.documentsRate === null ? null : Number(c.documentsRate.toFixed(5)),
      openDocumentsAgree: c.documentsAgree,
      openDocuments: c.documents.map((d) => ({ kind: d.kind, id: d.id, date: d.date, face: d.face, rate: d.rate, rupees: d.rupees })),
    })),
    problems: v.problems,
  };
}

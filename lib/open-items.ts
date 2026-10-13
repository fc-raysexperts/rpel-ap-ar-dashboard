import { differenceInCalendarDays, parseISO } from 'date-fns';
import type { RawZohoData } from './zoho-raw-fetch';
import { isExcludedStatus } from './status-filter';
import { keptJNContacts, type JNIndex } from './jn-clean';
import { accountSets, lineHitsLedger, type AccountSets } from './accounts';
import type { TrimmedJournal } from './journal-job';

/** Opening balances carry no date in Zoho's contact record; they belong to the books' opening position. */
export const OPENING_BALANCE_DATE = process.env.ZOHO_OPENING_BALANCE_DATE || '2025-03-31';

// ONE place that turns the raw documents into "what is still owed, item by
// item". Both calculators sum these items for the totals, and AR ages the
// same items for its <=180 / >180 split, so a total and its buckets can never
// disagree.
//
// Each item is one invoice / bill / journal line, with `amount` positive
// when it is owed. For invoices and bills the amount is Zoho's current
// balance PLUS whatever a JN-Clean credit was spent on it. JN-Clean's own
// rows cancel on the Statement, but the credit it spent is inside each
// document's balance as if it had been paid, so adding it back is what makes
// the sum of the documents equal the Statement total (and keeps an invoice
// aged on what is really owed).
//
// EXCEPTION (default rule, see lib/jn-rule.ts): for a contact where JN-Clean does NOT
// cancel on its ledger, the rows are kept. Its documents then stay at Zoho's own
// balances (nothing added back), and what is left of the JN-Clean lines -- their net
// effect on the ledger plus the part already spent on documents -- is added as one
// item (owed) or one credit, so the total equals the Statement.

export interface OpenItem {
  kind: 'invoice' | 'bill' | 'journal' | 'opening';
  id: string;
  date: string;
  /** date used for ageing: due date for invoices/bills, the journal's own date for journals */
  ageDate: string;
  /** positive = owed */
  amount: number;
  /** the part of `amount` that is JN-Clean spend added back */
  jnSpent: number;
}

export interface OpenItems {
  items: Map<string, OpenItem[]>;
  /** unapplied payments + unused credit notes / vendor credits, per contact */
  credits: Map<string, number>;
}

/**
 * A journal line that CREDITS a customer (or DEBITS a vendor) behaves like a
 * credit note / vendor credit: it can be applied to invoices or bills, and the
 * part that has been applied is ALREADY inside those documents' reduced
 * balances. Counting the whole line again double-counts it (Soltown: two
 * applied credit journals, Rs 26,77,892 = its entire gap). Only the unused part
 * is still owed to the contact, and Zoho records it on the journal
 * (available_receivables_credits / available_payables_credits). A journal with
 * several such lines is spread in proportion to the line amounts.
 */
export function unusedFraction(j: TrimmedJournal, side: 'receivable' | 'payable', sets: AccountSets | null): number {
  const available = side === 'receivable' ? j.available_receivables_credits : j.available_payables_credits;
  if (available === undefined || available === null) return 1; // not recorded: count it all, as before
  const creditLike = side === 'receivable' ? 'credit' : 'debit';
  let total = 0;
  for (const l of j.line_items) {
    if (l.contact_id && l.debit_or_credit === creditLike && lineHitsLedger(sets, side, l.account_id)) total += l.amount;
  }
  if (total <= 0) return 1;
  return Math.min(1, Math.max(0, available / total));
}

function push<T>(m: Map<string, T[]>, k: string, v: T) {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
}
const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);

/**
 * What remains of a kept contact's JN-Clean lines once the part already inside its documents' balances is
 * set aside: positive = owed (one item, dated by the latest JN-Clean line), negative = a credit.
 */
function keepJNResidual(items: Map<string, OpenItem[]>, credits: Map<string, number>, id: string, residual: number, date: string | undefined) {
  if (Math.abs(residual) < 0.005) return;
  if (residual > 0) {
    const d = date ?? OPENING_BALANCE_DATE;
    push(items, id, { kind: 'journal', id: 'JN-Clean (kept: does not cancel)', date: d, ageDate: d, amount: residual, jnSpent: 0 });
  } else {
    add(credits, id, -residual);
  }
}

/**
 * `from` (optional) narrows the view to documents DATED on/after it, for a custom From-To range: invoices, journal
 * lines, payments, credit notes and the opening balance older than `from` are left out. Their balances are still
 * Zoho's balances as of the latest refresh (Zoho keeps no history on them), so a range answers "what is still unpaid
 * from documents dated From..To". Without `from` nothing changes.
 */
export function receivableItems(raw: RawZohoData, asOf: string, jn: JNIndex, from?: string): OpenItems {
  const asOfDate = parseISO(asOf);
  const early = (d: string) => from !== undefined && d < from; // dated before the range starts
  const active = new Set(raw.activeCustomers.map((c) => c.contact_id));
  const sets = accountSets(raw.ledgerAccounts);
  const items = new Map<string, OpenItem[]>();
  const credits = new Map<string, number>();
  const kept = keptJNContacts(jn, 'receivable');
  const leftInDocs = new Map<string, number>(); // JN spend that stays inside the documents' own balances (kept contacts)

  for (const inv of raw.invoices) {
    if (!active.has(inv.customer_id) || isExcludedStatus(inv.status) || parseISO(inv.date) > asOfDate || early(inv.date)) continue;
    const spent = jn.appliedByInvoice.get(inv.invoice_id) ?? 0;
    if (kept.has(inv.customer_id)) add(leftInDocs, inv.customer_id, spent);
    const jnSpent = kept.has(inv.customer_id) ? 0 : spent;
    const open = (inv.balance || 0) + jnSpent;
    if (open <= 0) continue;
    push(items, inv.customer_id, { kind: 'invoice', id: inv.invoice_id, date: inv.date, ageDate: inv.due_date, amount: open, jnSpent });
  }
  for (const j of raw.journals) {
    if (parseISO(j.journal_date) > asOfDate || early(j.journal_date)) continue;
    const unused = unusedFraction(j, 'receivable', sets);
    for (const l of j.line_items) {
      if (!l.contact_id || !active.has(l.contact_id)) continue;
      if (!lineHitsLedger(sets, 'receivable', l.account_id)) continue; // tagged, but not on an Accounts Receivable account
      if (l.debit_or_credit === 'debit') {
        // a debit to a customer is owed by them, like an invoice
        push(items, l.contact_id, { kind: 'journal', id: j.journal_id, date: j.journal_date, ageDate: j.journal_date, amount: l.amount, jnSpent: 0 });
      } else {
        // a credit to a customer is a credit, like a credit note: only its unused part counts
        add(credits, l.contact_id, l.amount * unused);
      }
    }
  }
  // Opening balance carried over from the old books (never in the invoice list).
  for (const c of raw.activeCustomers) {
    const ob = raw.openingBalances?.[c.contact_id];
    if (!ob || parseISO(OPENING_BALANCE_DATE) > asOfDate || early(OPENING_BALANCE_DATE)) continue;
    const spent = ob.docId ? (jn.appliedByInvoice.get(ob.docId) ?? 0) : 0;
    if (kept.has(c.contact_id)) add(leftInDocs, c.contact_id, spent);
    const jnSpent = kept.has(c.contact_id) ? 0 : spent;
    const open = ob.receivable + jnSpent;
    if (open <= 0) continue;
    push(items, c.contact_id, { kind: 'opening', id: ob.docId ?? 'opening-balance', date: OPENING_BALANCE_DATE, ageDate: OPENING_BALANCE_DATE, amount: open, jnSpent });
  }
  for (const p of raw.customerPayments) {
    if (!active.has(p.customer_id) || !p.unused_amount || isExcludedStatus(p.status) || parseISO(p.date) > asOfDate || early(p.date)) continue;
    add(credits, p.customer_id, p.unused_amount);
  }
  for (const cn of raw.creditNotes) {
    if (!active.has(cn.customer_id) || !cn.balance || isExcludedStatus(cn.status) || parseISO(cn.date) > asOfDate || early(cn.date)) continue;
    add(credits, cn.customer_id, cn.balance);
  }
  // JN-Clean rows kept for contacts where they do not cancel: debit - credit on the ledger, plus what was spent on documents
  for (const id of kept) {
    if (!active.has(id) || early(jn.lastLineDate.get(id) ?? OPENING_BALANCE_DATE)) continue; // a range keeps it only if its latest line falls inside
    keepJNResidual(items, credits, id, (jn.netOnReceivable.get(id) ?? 0) + (leftInDocs.get(id) ?? 0), jn.lastLineDate.get(id));
  }
  return { items, credits };
}

export function payableItems(raw: RawZohoData, asOf: string, jn: JNIndex, from?: string): OpenItems {
  const asOfDate = parseISO(asOf);
  const early = (d: string) => from !== undefined && d < from; // dated before the range starts
  const active = new Set(raw.activeVendors.map((v) => v.contact_id));
  const sets = accountSets(raw.ledgerAccounts);
  const items = new Map<string, OpenItem[]>();
  const credits = new Map<string, number>();
  const kept = keptJNContacts(jn, 'payable');
  const leftInDocs = new Map<string, number>();

  for (const b of raw.bills) {
    if (!active.has(b.vendor_id) || isExcludedStatus(b.status) || parseISO(b.date) > asOfDate || early(b.date)) continue;
    const spent = jn.appliedByBill.get(b.bill_id) ?? 0;
    if (kept.has(b.vendor_id)) add(leftInDocs, b.vendor_id, spent);
    const jnSpent = kept.has(b.vendor_id) ? 0 : spent;
    const open = (b.balance || 0) + jnSpent;
    if (open <= 0) continue;
    push(items, b.vendor_id, { kind: 'bill', id: b.bill_id, date: b.date, ageDate: b.due_date, amount: open, jnSpent });
  }
  for (const j of raw.journals) {
    if (parseISO(j.journal_date) > asOfDate || early(j.journal_date)) continue;
    const unused = unusedFraction(j, 'payable', sets);
    for (const l of j.line_items) {
      if (!l.contact_id || !active.has(l.contact_id)) continue;
      if (!lineHitsLedger(sets, 'payable', l.account_id)) continue; // tagged, but not on an Accounts Payable account
      if (l.debit_or_credit === 'credit') {
        // a credit to a vendor is owed to them, like a bill
        push(items, l.contact_id, { kind: 'journal', id: j.journal_id, date: j.journal_date, ageDate: j.journal_date, amount: l.amount, jnSpent: 0 });
      } else {
        // a debit to a vendor is a vendor credit: only its unused part counts
        add(credits, l.contact_id, l.amount * unused);
      }
    }
  }
  for (const v of raw.activeVendors) {
    const ob = raw.openingBalances?.[v.contact_id];
    if (!ob || parseISO(OPENING_BALANCE_DATE) > asOfDate || early(OPENING_BALANCE_DATE)) continue;
    const spent = ob.docId ? (jn.appliedByBill.get(ob.docId) ?? 0) : 0;
    if (kept.has(v.contact_id)) add(leftInDocs, v.contact_id, spent);
    const jnSpent = kept.has(v.contact_id) ? 0 : spent;
    const open = ob.payable + jnSpent;
    if (open <= 0) continue;
    push(items, v.contact_id, { kind: 'opening', id: ob.docId ?? 'opening-balance', date: OPENING_BALANCE_DATE, ageDate: OPENING_BALANCE_DATE, amount: open, jnSpent });
  }
  for (const p of raw.vendorPayments) {
    if (!active.has(p.vendor_id) || !p.unused_amount || isExcludedStatus(p.status) || parseISO(p.date) > asOfDate || early(p.date)) continue;
    add(credits, p.vendor_id, p.unused_amount + (raw.vendorPaymentTds?.[p.payment_id] ?? 0));
  }
  for (const c of raw.vendorCredits) {
    if (!active.has(c.vendor_id) || !c.balance || isExcludedStatus(c.status) || parseISO(c.date) > asOfDate || early(c.date)) continue;
    add(credits, c.vendor_id, c.balance);
  }
  // JN-Clean rows kept for contacts where they do not cancel: credit - debit on the ledger, plus what was spent on documents
  for (const id of kept) {
    if (!active.has(id) || early(jn.lastLineDate.get(id) ?? OPENING_BALANCE_DATE)) continue;
    keepJNResidual(items, credits, id, -(jn.netOnPayable.get(id) ?? 0) + (leftInDocs.get(id) ?? 0), jn.lastLineDate.get(id));
  }
  return { items, credits };
}

/** Plain two-way split used by the bank statement: days past ageDate > edge goes to `more`. A bucket netting below zero is floored at 0 (your existing rule). */
export function splitAtEdge(items: OpenItem[], asOf: string, edgeDays = 180): { less: number; more: number } {
  const asOfDate = parseISO(asOf);
  let less = 0;
  let more = 0;
  for (const it of items) {
    if (differenceInCalendarDays(asOfDate, parseISO(it.ageDate)) > edgeDays) more += it.amount;
    else less += it.amount;
  }
  return { less: Math.max(0, less), more: Math.max(0, more) };
}

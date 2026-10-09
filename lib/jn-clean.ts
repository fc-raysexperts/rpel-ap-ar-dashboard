import { parseISO } from 'date-fns';
import { accountSets, lineHitsLedger, type LedgerAccounts } from './accounts';
import { jnRule } from './jn-rule';

// JN-Clean journals are RPEL's one-off "transfer ledger balance from old to
// new ledger" entries (every one carries that note). For each contact they
// post a CREDIT on the old account and a matching DEBIT on the new one, so
// on a contact's Statement the pair cancels to zero -- verified to the rupee
// against three official Statements, and across the 31 March journal export
// (571 of 572 contacts net exactly zero).
//
// They still matter in two ways, which is why they are kept rather than
// thrown away:
//
//  1. NET per contact. Your rule is "exclude JN-Clean rows". Because the
//     pair cancels, that normally changes nothing, but we compute each
//     contact's JN net and subtract it, so the rule is applied literally and
//     any contact where it does NOT cancel is caught instead of hidden.
//
//  2. APPLICATIONS. The credit leg is "spent" on open invoices / bills (they
//     look paid although no money moved), so those documents' own `balance`
//     already has the JN credit taken off, while the matching debit is not
//     counted. Adding that spend back onto each document is what makes the
//     AR age buckets right. Totals do not need it (they come from the ledger).

export interface JNLine {
  contact_id: string;
  account_id?: string;
  debit_or_credit: 'debit' | 'credit';
  amount: number;
}

export interface JNApplication {
  kind: 'invoice' | 'bill';
  doc_id: string;
  amount: number;
  date?: string;
}

export interface JNCleanEntry {
  journal_id: string;
  entry_number: string;
  journal_date: string;
  /** Only lines tagged to a customer/vendor are kept. */
  lines: JNLine[];
  applications: JNApplication[];
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function firstNum(...vals: unknown[]): number | undefined {
  for (const v of vals) {
    const n = num(v);
    if (n !== undefined) return n;
  }
  return undefined;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function parseApplications(arr: unknown, kind: 'invoice' | 'bill'): JNApplication[] {
  if (!Array.isArray(arr)) return [];
  const out: JNApplication[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const docId = str(item.invoice_id ?? item.bill_id ?? item.entity_id ?? item.document_id);
    const amount = firstNum(item.amount_applied, item.applied_amount, item.credited_amount, item.credit_applied, item.amount);
    if (!docId || !amount) continue;
    const date = str(item.date ?? item.applied_date ?? item.credited_date ?? item.apply_date) || undefined;
    out.push({ kind, doc_id: docId, amount, date });
  }
  return out;
}

/**
 * Reduces a raw journal-detail response to what the dashboard needs.
 * Returns null when there is nothing contact-related in it (most JN-Clean
 * journals only touch ledger accounts, no customers or vendors).
 *
 * The applications live in `invoices_credited` / `bills_credited` on the
 * journal. Because that shape has to be confirmed against live data
 * (/api/debug/probe does that), any top-level array whose name mentions
 * "invoice" or "bill" is also tried -- a wrong guess here degrades to
 * "no applications found", which the sync output and the verify route
 * report loudly, never to a silent wrong number.
 */
export function extractJNEntry(raw: Record<string, unknown>): JNCleanEntry | null {
  const lineItems = Array.isArray(raw.line_items) ? (raw.line_items as Record<string, unknown>[]) : [];
  // A journal in a foreign currency carries `amount` in THAT currency; the books are in rupees.
  // Zoho gives the rupee value per line as `bcy_amount`; failing that, face amount x the journal's rate.
  const rate = num(raw.exchange_rate);
  const lines: JNLine[] = [];
  for (const li of lineItems) {
    const contact = str(li.customer_id) || str(li.contact_id);
    const face = num(li.amount);
    const amount = num(li.bcy_amount) ?? (face === undefined ? undefined : rate !== undefined && rate > 0 ? Math.round(face * rate * 100) / 100 : face);
    const side = li.debit_or_credit;
    if (!contact || amount === undefined) continue;
    if (side !== 'debit' && side !== 'credit') continue;
    lines.push({ contact_id: contact, account_id: str(li.account_id) || undefined, debit_or_credit: side, amount });
  }

  const applications: JNApplication[] = [];
  const seenKeys = new Set<string>();
  const tryKey = (key: string, kind: 'invoice' | 'bill') => {
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    applications.push(...parseApplications(raw[key], kind));
  };
  tryKey('invoices_credited', 'invoice');
  tryKey('bills_credited', 'bill');
  for (const key of Object.keys(raw)) {
    if (key === 'line_items' || seenKeys.has(key) || !Array.isArray(raw[key])) continue;
    if (/bill/i.test(key)) tryKey(key, 'bill');
    else if (/invoice/i.test(key)) tryKey(key, 'invoice');
  }

  if (lines.length === 0 && applications.length === 0) return null;
  return {
    journal_id: str(raw.journal_id),
    entry_number: str(raw.entry_number) || str(raw.journal_number),
    journal_date: str(raw.journal_date),
    lines,
    applications,
  };
}

export interface JNIndex {
  /** debit minus credit, per contact, over ALL tagged JN-Clean lines dated on/before asOf */
  netDrMinusCr: Map<string, number>;
  /** the same, but only lines on Accounts Receivable accounts: what reaches a CUSTOMER's ledger */
  netOnReceivable: Map<string, number>;
  /** only lines on Accounts Payable accounts: what reaches a VENDOR's ledger */
  netOnPayable: Map<string, number>;
  /** JN credit spent on each invoice / bill (to add back onto its balance) */
  appliedByInvoice: Map<string, number>;
  appliedByBill: Map<string, number>;
  /** latest JN-Clean journal date with a line for each contact (dates a kept JN balance) */
  lastLineDate: Map<string, string>;
  contactCount: number;
  applicationCount: number;
  applicationTotal: number;
}

export function buildJNIndex(entries: JNCleanEntry[] | undefined, asOf: string, accounts?: LedgerAccounts): JNIndex {
  const sets = accountSets(accounts);
  const idx: JNIndex = {
    netDrMinusCr: new Map(),
    netOnReceivable: new Map(),
    netOnPayable: new Map(),
    appliedByInvoice: new Map(),
    appliedByBill: new Map(),
    lastLineDate: new Map(),
    contactCount: 0,
    applicationCount: 0,
    applicationTotal: 0,
  };
  const asOfDate = parseISO(asOf);
  for (const e of entries ?? []) {
    const jDate = e.journal_date ? parseISO(e.journal_date) : undefined;
    if (jDate && jDate > asOfDate) continue;
    for (const l of e.lines) {
      const signed = l.debit_or_credit === 'debit' ? l.amount : -l.amount;
      const prevDate = idx.lastLineDate.get(l.contact_id);
      if (e.journal_date && (!prevDate || e.journal_date > prevDate)) idx.lastLineDate.set(l.contact_id, e.journal_date);
      idx.netDrMinusCr.set(l.contact_id, (idx.netDrMinusCr.get(l.contact_id) ?? 0) + signed);
      if (lineHitsLedger(sets, 'receivable', l.account_id)) idx.netOnReceivable.set(l.contact_id, (idx.netOnReceivable.get(l.contact_id) ?? 0) + signed);
      if (lineHitsLedger(sets, 'payable', l.account_id)) idx.netOnPayable.set(l.contact_id, (idx.netOnPayable.get(l.contact_id) ?? 0) + signed);
    }
    for (const a of e.applications) {
      const aDate = a.date ? parseISO(a.date) : jDate;
      if (aDate && aDate > asOfDate) continue;
      const target = a.kind === 'invoice' ? idx.appliedByInvoice : idx.appliedByBill;
      target.set(a.doc_id, (target.get(a.doc_id) ?? 0) + a.amount);
      idx.applicationCount += 1;
      idx.applicationTotal += a.amount;
    }
  }
  idx.contactCount = idx.netDrMinusCr.size;
  return idx;
}

/**
 * Contacts whose JN-Clean rows are KEPT rather than excluded: those where the rows do not cancel on the
 * receivable / payable ledger (more than Re. 1 of net), under the default rule. Empty under JN_CLEAN_RULE=literal.
 */
export function keptJNContacts(jn: JNIndex, side: 'receivable' | 'payable'): Set<string> {
  const out = new Set<string>();
  if (jnRule() === 'literal') return out;
  for (const [id, n] of side === 'receivable' ? jn.netOnReceivable : jn.netOnPayable) if (Math.abs(n) > 1) out.add(id);
  return out;
}

import type { RawZohoData } from './zoho-raw-fetch';
import { buildJNIndex, keptJNContacts } from './jn-clean';
import type { LedgerBalances } from './ledger';
import { differenceInCalendarDays, parseISO } from 'date-fns';
import { receivableItems, splitAtEdge } from './open-items';
import { splitRow, type AgingRecord, type AgingRow } from './aging';
import type { JNIndex } from './jn-clean';

export interface CustomerAR {
  customerId: string;
  customerName: string;
  less180: number;
  more180: number;
  agedTotal: number; // less180 + more180 (before credits)
  unappliedCredits: number; // excess payments / unused credit notes, not tied to a dated invoice
  /** The total: what the invoices + journals add up to (JN-Clean spend added back), less unapplied credits. */
  netTotal: number;
  /** Zoho's own ledger balance for the contact (its Statement balance) with JN-Clean rows removed, when available. */
  ledgerTotal?: number;
  /** ledgerTotal - netTotal. 0 = the documents add up to Zoho's ledger. Non-zero rows are flagged, never hidden. */
  gap: number;
}

export interface ARSummary {
  asOfDate: string;
  customers: CustomerAR[];
  grandTotal: {
    less180: number;
    more180: number;
    agedTotal: number;
    unappliedCredits: number;
    netTotal: number;
  };
  /** Set for a custom From-To range: only documents dated from this day on are counted (see receivableItems). */
  fromDate?: string;
  /** Zoho's ledger total over the same listed customers (undefined if no ledger for this date). */
  ledgerGrandTotal?: number;
  /** Contacts listed whose documents do not add up to the ledger (|gap| > Re. 1). */
  unreconciledCount: number;
}

const TOL = 1; // rupees

/**
 * AR for every active customer AS OF a date, from already-fetched data
 * (no API calls).
 *
 * TOTAL = the sum of the documents, item by item (lib/open-items.ts):
 * open invoices (Zoho balance + whatever JN-Clean spent on each), ordinary
 * journal lines, less unapplied payments and credit notes. JN-Clean's own
 * journal rows are not counted -- your rule; they cancel on the Statement.
 * What does matter is the credit JN-Clean spent on an invoice: it sits inside
 * that invoice's balance as if it had been paid, so it is added back,
 * otherwise the invoices would fall short of the Statement by that amount.
 *
 * AGE BUCKETS come from the same items (<=180 / >180 days past due date;
 * journals by their own date), so the buckets always add up to the total.
 *
 * LEDGER CHECK: Zoho's own balance for the contact (outstanding minus
 * unused credits on the contact record, or a stored report snapshot for an
 * earlier date) with JN-Clean rows removed. It is an independent second
 * route to the same number. `gap` = ledger - documents; non-zero means
 * something is not covered by the documents (timing while Zoho is being
 * edited, an item type we do not fetch, JN-Clean spend we could not read).
 */
export function computeARDetail(
  raw: RawZohoData,
  asOf: string,
  opts: { ledger?: LedgerBalances | null; historical?: boolean; aging?: AgingRecord | null; from?: string } = {}
): CustomerAR[] {
  const jn = buildJNIndex(raw.jnClean, asOf, raw.ledgerAccounts);
  const kept = keptJNContacts(jn, 'receivable'); // contacts whose JN-Clean rows are kept because they do not cancel
  const { items, credits } = receivableItems(raw, asOf, jn, opts.from);
  const ledger = opts.ledger?.customers;
  // Past date with Zoho's aging report stored for that day: exact buckets (see lib/aging.ts)
  const reportBuckets = opts.historical && opts.aging && ledger ? historicalBuckets(raw, asOf, jn, items, opts.aging) : null;

  return raw.activeCustomers.map((c) => {
    const rb = reportBuckets?.get(c.contact_id);
    const { less, more } = reportBuckets ? (rb ?? { less: 0, more: 0 }) : splitAtEdge(items.get(c.contact_id) ?? [], asOf, 180);
    const agedTotal = less + more;
    let unappliedCredits = credits.get(c.contact_id) ?? 0;
    let explained = agedTotal - unappliedCredits;

    // in a past-date snapshot a contact the report does not list had no balance that day
    const ledgerRaw = ledger?.get(c.contact_id) ?? (opts.historical && ledger ? 0 : undefined);
    const ledgerTotal = ledgerRaw === undefined ? undefined : ledgerRaw - (kept.has(c.contact_id) ? 0 : (jn.netOnReceivable.get(c.contact_id) ?? 0));
    // For a PAST date the documents cannot be summed (Zoho keeps only today's balances on them),
    // so the stored ledger snapshot for that day is the total; buckets stay an approximation.
    const netTotal = opts.historical && ledgerTotal !== undefined ? ledgerTotal : explained;
    let gap = opts.historical || ledgerTotal === undefined ? 0 : ledgerTotal - netTotal;
    if (reportBuckets && ledgerTotal !== undefined) {
      // The buckets are real; the total is Zoho's ledger. Whatever the buckets overshoot is
      // credits (unapplied payments, credit notes); whatever they fall short by is unexplained.
      const remainder = ledgerTotal - agedTotal;
      unappliedCredits = remainder < 0 ? -remainder : 0;
      explained = agedTotal - unappliedCredits;
      gap = remainder > TOL ? remainder : 0;
    }

    return {
      customerId: c.contact_id,
      customerName: c.contact_name,
      less180: less,
      more180: more,
      agedTotal,
      unappliedCredits,
      netTotal,
      ledgerTotal,
      gap: Math.abs(gap) <= TOL ? 0 : gap,
    };
  });
}

/**
 * What the dashboard shows: customers whose documents total more than Re. 1
 * (the established bank-statement rule), largest first. A customer whose
 * documents say ~0 but whose Zoho ledger says otherwise is listed too (and
 * flagged), so a hidden balance cannot slip through unnoticed.
 */
export function computeARSummary(
  raw: RawZohoData,
  asOf: string,
  opts: { ledger?: LedgerBalances | null; historical?: boolean; aging?: AgingRecord | null; from?: string } = {}
): ARSummary {
  // A custom range counts only part of the documents, so Zoho's whole-contact ledger cannot be a check on it.
  if (opts.from !== undefined) opts = { ...opts, ledger: null, historical: false, aging: null };
  const customers = computeARDetail(raw, asOf, opts).filter((c) => c.netTotal > TOL || (c.ledgerTotal ?? 0) > TOL);
  customers.sort((a, b) => b.netTotal - a.netTotal);

  const counted = customers.filter((c) => c.netTotal > TOL);
  const grandTotal = counted.reduce(
    (acc, c) => ({
      less180: acc.less180 + c.less180,
      more180: acc.more180 + c.more180,
      agedTotal: acc.agedTotal + c.agedTotal,
      unappliedCredits: acc.unappliedCredits + c.unappliedCredits,
      netTotal: acc.netTotal + c.netTotal,
    }),
    { less180: 0, more180: 0, agedTotal: 0, unappliedCredits: 0, netTotal: 0 }
  );
  const haveLedger = customers.some((c) => c.ledgerTotal !== undefined);

  return {
    asOfDate: asOf,
    ...(opts.from !== undefined ? { fromDate: opts.from } : {}),
    customers,
    grandTotal,
    ledgerGrandTotal: haveLedger
      ? customers.filter((c) => (c.ledgerTotal ?? 0) > TOL).reduce((s, c) => s + (c.ledgerTotal ?? 0), 0)
      : undefined,
    unreconciledCount: customers.filter((c) => c.gap !== 0).length,
  };
}

/**
 * Exact buckets for a past date: Zoho's aging report for that day, plus what the
 * report cannot see (JN-Clean's spend, non-invoice journal debits, opening balances).
 */
function historicalBuckets(
  raw: RawZohoData,
  asOf: string,
  jn: JNIndex,
  items: Map<string, { kind: string; ageDate: string; amount: number }[]>,
  aging: AgingRecord
): Map<string, { less: number; more: number }> {
  const asOfDate = parseISO(asOf);
  const out = new Map<string, { less: number; more: number }>();
  const slot = (id: string) => {
    let e = out.get(id);
    if (!e) {
      e = { less: 0, more: 0 };
      out.set(id, e);
    }
    return e;
  };
  const place = (id: string, amount: number, ageDate: string) => {
    const e = slot(id);
    if (differenceInCalendarDays(asOfDate, parseISO(ageDate)) > 180) e.more += amount;
    else e.less += amount;
  };

  // 1. what Zoho says was open on that day
  for (const [id, row] of aging.rows) {
    const { less, more } = splitRow(row as AgingRow);
    const e = slot(id);
    e.less += less;
    e.more += more;
  }

  // 2. JN-Clean's spend (applications dated on/before the day), aged by the invoice's due date
  const keptContacts = keptJNContacts(jn, 'receivable'); // their JN rows are part of the ledger, so nothing is added back
  const invoiceById = new Map(raw.invoices.map((i) => [i.invoice_id, i]));
  const openingDoc = new Map<string, string>();
  for (const [contactId, ob] of Object.entries(raw.openingBalances ?? {})) if (ob.docId) openingDoc.set(ob.docId, contactId);
  for (const [docId, amount] of jn.appliedByInvoice) {
    const inv = invoiceById.get(docId);
    if (inv) {
      if (!keptContacts.has(inv.customer_id)) place(inv.customer_id, amount, inv.due_date);
    } else if (openingDoc.has(docId) && !keptContacts.has(openingDoc.get(docId)!)) slot(openingDoc.get(docId)!).more += amount; // an opening balance is old
  }

  // 3. journal debits (owed, like an invoice), by journal date
  for (const [contactId, its] of items) for (const it of its) if (it.kind === 'journal') place(contactId, it.amount, it.ageDate);

  // 4. opening balances, unless the report already includes them
  if (!aging.includesOpening) {
    for (const [contactId, ob] of Object.entries(raw.openingBalances ?? {})) if (ob.receivable > 0) slot(contactId).more += ob.receivable;
  }
  return out;
}

/**
 * Does Zoho's aging report already contain the opening-balance invoices? Settled from
 * the data: build the buckets both ways and keep the one that leaves less unexplained
 * against the ledger.
 */
export function chooseAgingOpeningBasis(
  raw: RawZohoData,
  asOf: string,
  ledger: LedgerBalances,
  rows: Map<string, AgingRow>
): { includesOpening: boolean; unexplainedIfIncluded: number; unexplainedIfNot: number } {
  // Only customers with an opening balance can tell the two assumptions apart. If the report
  // already holds the opening balance and it is added again, the surplus would pass as harmless
  // "credits"; so the comparison counts overshoot as well as shortfall.
  const withOpening = new Set(Object.keys(raw.openingBalances ?? {}));
  const run = (includesOpening: boolean) =>
    computeARDetail(raw, asOf, { ledger, historical: true, aging: { asOf, rows, includesOpening } })
      .filter((r) => withOpening.has(r.customerId))
      .reduce((s, r) => s + Math.abs(r.netTotal - r.agedTotal), 0);
  const unexplainedIfIncluded = run(true);
  const unexplainedIfNot = run(false);
  return { includesOpening: unexplainedIfIncluded < unexplainedIfNot, unexplainedIfIncluded, unexplainedIfNot };
}

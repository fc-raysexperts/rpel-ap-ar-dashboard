import type { RawZohoData } from './zoho-raw-fetch';
import { computeARDetail, type CustomerAR } from './ar-calculator';
import { computeAPDetail, type VendorAP } from './ap-calculator';
import { ledgerFromContacts, cacheDay, fetchBalanceReport, calibrate, nameIndex } from './ledger';
import { syncPaymentTds } from './payment-tds';
import type { TrimmedJournal } from './journal-job';
import {
  getContactFresh,
  listAllInvoices,
  listAllCustomerPayments,
  listAllCreditNotes,
  listAllBills,
  listAllVendorPayments,
  listAllVendorCredits,
  type ZohoContact,
  type ZohoInvoice,
  type ZohoCustomerPayment,
  type ZohoCreditNote,
  type ZohoBill,
  type ZohoVendorPayment,
  type ZohoVendorCredit,
} from './zoho-client';

// AUTOMATIC RE-CHECK OF FLAGGED CONTACTS.
//
// Zoho is live: while a sync is running (it can take many minutes) staff keep
// posting, so a contact read at minute 1 and its invoices read at minute 12 can
// legitimately disagree. That is not an error in the books, only in the timing
// of the read. The old way to tell the difference was a manual ?reread=1.
//
// Now the sync does it itself, at the end: every contact whose documents do not
// add up to its ledger is read again from Zoho -- the contact record, ALL its
// documents, and (vendors) the vendor balance report -- as one fresh picture.
//
//   * the gap is gone on the fresh read  -> it was timing. The fresh picture
//     replaces the stale one in the cache, so the flag simply disappears.
//   * the gap is still there             -> it is real (or Zoho's contact record
//     is lagging an edit by a few minutes). It stays flagged, and is listed with
//     what the balance report says, which tells the two apart.
//
// Only the flagged contacts are touched; everyone else keeps the picture they
// were read with, so totals stay internally consistent.

const TOL = 1;
const rd = (n: number) => Math.round(n);

export type Side = 'customer' | 'vendor';
export type Row = CustomerAR | VendorAP;
export const idOf = (r: Row) => ('customerId' in r ? r.customerId : r.vendorId);
export const nameOf = (r: Row) => ('customerName' in r ? r.customerName : r.vendorName);

export interface FreshContact {
  side: Side;
  id: string;
  contact: ZohoContact;
  invoices: ZohoInvoice[];
  customerPayments: ZohoCustomerPayment[];
  creditNotes: ZohoCreditNote[];
  bills: ZohoBill[];
  vendorPayments: ZohoVendorPayment[];
  vendorCredits: ZohoVendorCredit[];
  /** TDS on the unused part of this vendor's payments (payment_id -> rupees), looked up if new */
  paymentTds: Record<string, number>;
}

/** Reads one contact and everything of theirs from Zoho right now. */
export async function readContactFresh(side: Side, id: string, previous?: ZohoContact): Promise<FreshContact> {
  const extra = side === 'customer' ? { customer_id: id } : { vendor_id: id };
  const read = await getContactFresh(id);
  // balances come ONLY from the fresh read; just the identity fields fall back to what was held before
  const contact: ZohoContact = {
    ...read,
    contact_name: read.contact_name ?? previous?.contact_name ?? id,
    contact_type: read.contact_type ?? previous?.contact_type ?? side,
    status: read.status ?? previous?.status ?? 'active',
  };
  // A read that comes back without the balance fields cannot be compared with anything; treating it as "no gap"
  // would hide the flag, so it counts as a failed re-read instead.
  if ((side === 'customer' ? read.outstanding_receivable_amount : read.outstanding_payable_amount) === undefined) {
    throw new Error('Zoho returned the contact without its balance fields');
  }
  const out: FreshContact = {
    side,
    id,
    contact,
    invoices: [],
    customerPayments: [],
    creditNotes: [],
    bills: [],
    vendorPayments: [],
    vendorCredits: [],
    paymentTds: {},
  };
  // Each list is filtered to this contact again here: if Zoho ever ignored the filter (it has done so for
  // other parameters) another contact's documents must not leak into this one's picture.
  if (side === 'customer') {
    out.invoices = (await listAllInvoices(extra)).filter((d) => d.customer_id === id);
    out.customerPayments = (await listAllCustomerPayments(extra)).filter((d) => d.customer_id === id);
    out.creditNotes = (await listAllCreditNotes(extra)).filter((d) => d.customer_id === id);
  } else {
    out.bills = (await listAllBills(extra)).filter((d) => d.vendor_id === id);
    out.vendorPayments = (await listAllVendorPayments(extra)).filter((d) => d.vendor_id === id);
    out.vendorCredits = (await listAllVendorCredits(extra)).filter((d) => d.vendor_id === id);
    // a payment made since the sync began has no TDS on file yet: look it up (remembered afterwards)
    out.paymentTds = (await syncPaymentTds(out.vendorPayments)).tds;
  }
  return out;
}

/** Zoho's vendor balance report for `day`, accepted only if it matches the contact records for nearly everyone (same test as the main sync). */
export async function readVendorReport(raw: RawZohoData, day: string, exclude: Set<string> = new Set()): Promise<Map<string, number> | null> {
  try {
    const rep = await fetchBalanceReport('vendor', day, nameIndex(raw.activeVendors));
    if (!rep.ok) return null;
    // The vendors being re-read are flagged precisely because their (stale) contact record disagrees with
    // something, so they cannot be the yardstick for whether the report is being read correctly.
    const yardstick = new Map([...ledgerFromContacts(raw, { contactRecordsOnly: true }).vendors].filter(([id]) => !exclude.has(id)));
    const cal = calibrate(rep.balances, yardstick);
    return cal.agreement >= 0.9 && cal.sign === 1 ? rep.balances : null;
  } catch {
    return null;
  }
}

/** The contact's row as the calculators would compute it from the fresh picture alone. */
export function evaluateFresh(raw: RawZohoData, asOf: string, f: FreshContact, vendorReport: Map<string, number> | null, fetchedAt = raw.fetchedAt): Row {
  const mini: RawZohoData = {
    ...raw,
    fetchedAt,
    activeCustomers: f.side === 'customer' ? [f.contact] : [],
    activeVendors: f.side === 'vendor' ? [f.contact] : [],
    invoices: f.invoices,
    customerPayments: f.customerPayments,
    creditNotes: f.creditNotes,
    bills: f.bills,
    vendorPayments: f.vendorPayments,
    vendorCredits: f.vendorCredits,
    vendorPaymentTds: { ...(raw.vendorPaymentTds ?? {}), ...f.paymentTds },
    // never the stale report from the cache: the fresh one, or none (then the fresh contact record, corrected for TDS)
    vendorLedgerToday: vendorReport ? Object.fromEntries(vendorReport) : undefined,
  };
  const ledger = ledgerFromContacts(mini);
  return (f.side === 'customer' ? computeARDetail(mini, asOf, { ledger }) : computeAPDetail(mini, asOf, { ledger }))[0];
}

/** Puts the fresh pictures into the snapshot in place of the stale ones (only for the contacts read). */
export function applyFresh(raw: RawZohoData, fresh: FreshContact[], vendorReport: Map<string, number> | null): RawZohoData {
  if (fresh.length === 0) return raw;
  const cust = new Map(fresh.filter((f) => f.side === 'customer').map((f) => [f.id, f]));
  const vend = new Map(fresh.filter((f) => f.side === 'vendor').map((f) => [f.id, f]));
  const swap = <T extends { contact_id: string }>(list: T[], m: Map<string, FreshContact>) => list.map((c) => (m.has(c.contact_id) ? (m.get(c.contact_id)!.contact as unknown as T) : c));

  const vendorPayments = [
    ...raw.vendorPayments.filter((p) => !vend.has(p.vendor_id)),
    ...fresh.filter((f) => f.side === 'vendor').flatMap((f) => f.vendorPayments),
  ];
  const tds = { ...(raw.vendorPaymentTds ?? {}) };
  for (const p of raw.vendorPayments) if (vend.has(p.vendor_id)) delete tds[p.payment_id];
  for (const f of fresh) Object.assign(tds, f.paymentTds);

  const ledgerToday = raw.vendorLedgerToday ? { ...raw.vendorLedgerToday } : undefined;
  if (ledgerToday) {
    for (const id of vend.keys()) {
      const v = vendorReport?.get(id);
      if (v !== undefined) ledgerToday[id] = v;
      else delete ledgerToday[id]; // no fresh report row: fall back to the fresh contact record, not a stale report value
    }
  }

  return {
    ...raw,
    activeCustomers: swap(raw.activeCustomers, cust),
    activeVendors: swap(raw.activeVendors, vend),
    invoices: [...raw.invoices.filter((i) => !cust.has(i.customer_id)), ...fresh.flatMap((f) => f.invoices)],
    customerPayments: [...raw.customerPayments.filter((p) => !cust.has(p.customer_id)), ...fresh.flatMap((f) => f.customerPayments)],
    creditNotes: [...raw.creditNotes.filter((c) => !cust.has(c.customer_id)), ...fresh.flatMap((f) => f.creditNotes)],
    bills: [...raw.bills.filter((b) => !vend.has(b.vendor_id)), ...fresh.flatMap((f) => f.bills)],
    vendorPayments,
    vendorCredits: [...raw.vendorCredits.filter((c) => !vend.has(c.vendor_id)), ...fresh.flatMap((f) => f.vendorCredits)],
    vendorPaymentTds: tds,
    vendorLedgerToday: ledgerToday,
  };
}

export interface SettleStats {
  ranAt: string;
  /** contacts whose documents did not add up to the ledger when the check began */
  flaggedBefore: number;
  /** of those, read again from Zoho */
  reread: number;
  /** gap gone on the fresh read: timing noise, cache updated, flag cleared */
  settled: number;
  /** gap still there on the fresh read */
  persistent: number;
  /** flagged but not read (over the limit or out of time) */
  notChecked: number;
  failed: number;
  journalsResynced: boolean;
  settledNames: string[];
  persistentDetails: {
    name: string;
    side: Side;
    documents: number;
    zohoLedger: number | null;
    gap: number;
    /** customers only: what Zoho's balance report says, and which side it agrees with */
    reportBalance?: number | null;
    reportAgrees?: 'documents' | 'contact record' | 'neither' | 'no report';
  }[];
  ms: number;
}

export const emptySettle = (): SettleStats => ({
  ranAt: new Date().toISOString(),
  flaggedBefore: 0,
  reread: 0,
  settled: 0,
  persistent: 0,
  notChecked: 0,
  failed: 0,
  journalsResynced: false,
  settledNames: [],
  persistentDetails: [],
  ms: 0,
});

function flaggedPicks(raw: RawZohoData, day: string): { side: Side; id: string; name: string; gap: number }[] {
  const ledger = ledgerFromContacts(raw);
  return [
    ...computeARDetail(raw, day, { ledger }).filter((r) => r.gap !== 0).map((r) => ({ side: 'customer' as const, id: r.customerId, name: r.customerName, gap: r.gap })),
    ...computeAPDetail(raw, day, { ledger }).filter((r) => r.gap !== 0).map((r) => ({ side: 'vendor' as const, id: r.vendorId, name: r.vendorName, gap: r.gap })),
  ].sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
}

export async function settleFlagged(
  base: RawZohoData,
  opts: {
    /** most contacts re-read per run (biggest gaps first) */
    limit?: number;
    timeBudgetMs?: number;
    /** incremental journal sync (cheap), run first so journals are as fresh as the contacts */
    resyncJournals?: () => Promise<TrimmedJournal[]>;
    onProgress?: (done: number, total: number) => void;
  } = {}
): Promise<{ raw: RawZohoData; stats: SettleStats }> {
  const started = Date.now();
  const stats = emptySettle();
  const day = cacheDay(base.fetchedAt);
  let cur = base;

  let picks = flaggedPicks(cur, day);
  stats.flaggedBefore = picks.length;
  if (picks.length === 0) return { raw: cur, stats };

  if (opts.resyncJournals) {
    try {
      cur = { ...cur, journals: await opts.resyncJournals() };
      stats.journalsResynced = true;
      picks = flaggedPicks(cur, day); // a journal posted during the sync may already explain some
    } catch (e) {
      console.warn('[settle] journal re-sync failed, continuing with the journals already read:', e instanceof Error ? e.message : e);
    }
  }

  const limit = opts.limit ?? 60;
  const deadline = opts.timeBudgetMs ? started + opts.timeBudgetMs : Infinity;
  const chosen = picks.slice(0, limit);
  const freshList: FreshContact[] = [];
  const CONCURRENCY = 3;
  for (let i = 0; i < chosen.length; i += CONCURRENCY) {
    if (Date.now() > deadline) break;
    const chunk = chosen.slice(i, i + CONCURRENCY);
    const got = await Promise.all(
      chunk.map(async (p) => {
        try {
          return await readContactFresh(p.side, p.id, (p.side === 'customer' ? cur.activeCustomers : cur.activeVendors).find((c) => c.contact_id === p.id));
        } catch (e) {
          console.warn(`[settle] could not re-read ${p.name}:`, e instanceof Error ? e.message : e);
          return null;
        }
      })
    );
    for (const g of got) if (g) freshList.push(g);
    stats.failed += got.filter((g) => !g).length;
    opts.onProgress?.(Math.min(i + CONCURRENCY, chosen.length), chosen.length);
  }

  // the vendor report is read AFTER the documents, so it is the newest thing in the picture
  const vendorReport = freshList.some((f) => f.side === 'vendor') ? await readVendorReport(cur, day, new Set(freshList.filter((f) => f.side === 'vendor').map((f) => f.id))) : null;

  const persistentIds: { side: Side; id: string; name: string; row: Row }[] = [];
  for (const f of freshList) {
    const row = evaluateFresh(cur, day, f, vendorReport);
    if (row.gap === 0) {
      stats.settled += 1;
      if (stats.settledNames.length < 25) stats.settledNames.push(nameOf(row));
    } else {
      stats.persistent += 1;
      persistentIds.push({ side: f.side, id: f.id, name: nameOf(row), row });
    }
  }
  stats.reread = freshList.length;
  stats.notChecked = Math.max(0, picks.length - stats.reread - stats.failed);

  cur = applyFresh(cur, freshList, vendorReport);

  // For contacts still flagged, ask Zoho's balance report who is right (customers: vendors already use it as the ledger).
  let custReport: Map<string, number> | null = null;
  if (persistentIds.some((p) => p.side === 'customer')) {
    try {
      const rep = await fetchBalanceReport('customer', day, nameIndex(cur.activeCustomers));
      if (rep.ok) custReport = rep.balances;
    } catch {
      /* diagnostic only */
    }
  }
  for (const p of persistentIds.slice(0, 20)) {
    const detail: SettleStats['persistentDetails'][number] = {
      name: p.name,
      side: p.side,
      documents: rd(p.row.netTotal),
      zohoLedger: p.row.ledgerTotal === undefined ? null : rd(p.row.ledgerTotal),
      gap: rd(p.row.gap),
    };
    if (p.side === 'customer') {
      const rep = custReport?.get(p.id);
      detail.reportBalance = rep === undefined ? null : rd(rep);
      detail.reportAgrees =
        !custReport || rep === undefined
          ? 'no report'
          : Math.abs(rep - p.row.netTotal) <= TOL
            ? 'documents'
            : p.row.ledgerTotal !== undefined && Math.abs(rep - p.row.ledgerTotal) <= TOL
              ? 'contact record'
              : 'neither';
    }
    stats.persistentDetails.push(detail);
  }

  stats.ms = Date.now() - started;
  return { raw: cur, stats };
}

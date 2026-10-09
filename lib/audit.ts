import type { RawZohoData } from './zoho-raw-fetch';
import { tdsByVendor, fetchBalanceReport, nameIndex, cacheDay, type LedgerBalances } from './ledger';
import { computeARDetail } from './ar-calculator';

// TWO-SOURCE AUDIT. Zoho gives two answers for a contact's balance, and they are
// produced by different code paths:
//
//   the contact record  (outstanding minus unused credits)    -- fast, but blind to
//                                                               TDS on advance payments
//   the balance report  (what the Statement is built from)     -- counts TDS
//
// For vendors, the report is the ledger the dashboard uses. This audit checks it
// against the contact record PLUS the TDS read from each payment's own record --
// for EVERY vendor, not a hand-picked few. If the TDS handling were wrong
// anywhere, that vendor lands in `unexplained`. Nothing is hidden: a vendor is
// "ok" only if the two routes agree to within Rs 1.50.

const TOL = 1.5;
const rd = (n: number) => Math.round(n);

/** A contact that Zoho's own balance report shows with a balance, but that the dashboard does not hold. */
export interface NotHeld {
  id: string;
  balance: number;
}

/** Report entries with a balance (more than Rs 1 either way) for contacts the dashboard does not hold. */
function reportBalancesNotHeld(report: Iterable<[string, number]>, held: Set<string>): NotHeld[] {
  const out: NotHeld[] = [];
  for (const [id, b] of report) if (!held.has(id) && Math.abs(b) > TOL) out.push({ id, balance: rd(b) });
  return out.sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));
}

export interface VendorUnexplained {
  name: string;
  contactRecord: number;
  tds: number;
  expectedFromContact: number;
  report: number;
  difference: number;
  reason: string;
}
export interface TdsVendor {
  name: string;
  tds: number;
  contactRecord: number;
  report: number;
  status: 'ok' | 'MISMATCH';
}

export function auditVendors(raw: RawZohoData) {
  const report = raw.vendorLedgerToday;
  if (!report || Object.keys(report).length === 0) {
    return {
      reportAvailable: false,
      vendorsCompared: 0,
      reportEqualsContactRecord: 0,
      reportEqualsContactRecordLessTds: 0,
      unexplained: 0,
      paymentsCarryingTds: 0,
      vendorsWithTds: 0,
      tdsTotal: 0,
      verdict: 'No vendor balance report was read, so the vendors\' ledger is the contact record corrected for TDS. Nothing to compare it with.',
      unexplainedList: [] as VendorUnexplained[],
      tdsVendors: [] as TdsVendor[],
      reportVendorsNotHeld: [] as NotHeld[],
      reportVendorsNotHeldCount: 0,
    };
  }
  // COVERAGE, read from Zoho's side: does the report show a balance for any vendor the dashboard does not hold?
  const notHeld = reportBalancesNotHeld(Object.entries(report), new Set(raw.activeVendors.map((v) => v.contact_id)));
  const tds = tdsByVendor(raw);
  let compared = 0;
  let agree = 0;
  let explainedByTds = 0;
  const unexplained: VendorUnexplained[] = [];
  const tdsVendors: TdsVendor[] = [];

  for (const v of raw.activeVendors) {
    if (v.outstanding_payable_amount === undefined) continue;
    const rec = v.outstanding_payable_amount - (v.unused_credits_payable_amount ?? 0);
    const t = tds.get(v.contact_id) ?? 0;
    const rep = report[v.contact_id] ?? 0;
    if (Math.abs(rec) <= TOL && Math.abs(rep) <= TOL && t <= TOL) continue; // nothing there
    compared += 1;
    const expected = rec - t;
    const ok = Math.abs(rep - expected) <= TOL;
    if (ok) {
      if (t > 0) explainedByTds += 1;
      else agree += 1;
    } else {
      unexplained.push({
        name: v.contact_name,
        contactRecord: rd(rec),
        tds: rd(t),
        expectedFromContact: rd(expected),
        report: rd(rep),
        difference: rd(rep - expected),
        reason:
          t > 0 && Math.abs(rep - rec) <= TOL
            ? 'the report ignores TDS that the payment record shows'
            : t > 0
              ? 'differs from the contact record even after TDS'
              : 'differs from the contact record and no TDS is involved',
      });
    }
    if (t > 0) tdsVendors.push({ name: v.contact_name, tds: rd(t), contactRecord: rd(rec), report: rd(rep), status: ok ? 'ok' : 'MISMATCH' });
  }
  unexplained.sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));
  tdsVendors.sort((a, b) => b.tds - a.tds);

  return {
    reportAvailable: true,
    vendorsCompared: compared,
    reportEqualsContactRecord: agree,
    reportEqualsContactRecordLessTds: explainedByTds,
    unexplained: unexplained.length,
    paymentsCarryingTds: Object.keys(raw.vendorPaymentTds ?? {}).length,
    vendorsWithTds: tdsVendors.length,
    tdsTotal: rd([...tds.values()].reduce((s, x) => s + x, 0)),
    verdict:
      unexplained.length === 0
        ? `All ${compared} vendors with a balance agree: ${agree} match their contact record exactly, ${explainedByTds} match once TDS on advance payments is taken off (${tdsVendors.length} vendors carry TDS). No vendor is left unexplained.`
        : `${unexplained.length} of ${compared} vendors are NOT explained by contact record + TDS (list below, biggest first). These are the ones to look at.`,
    unexplainedList: unexplained.slice(0, 20),
    tdsVendors: tdsVendors.slice(0, 40),
    reportVendorsNotHeld: notHeld.slice(0, 20),
    reportVendorsNotHeldCount: notHeld.length,
  };
}

/** Customers: the balance report (live, one extra call) against the contact record AND against our documents. */
export interface CustomerDiffer {
  name: string;
  report: number;
  contactRecord: number;
  documents: number;
  reportAgreesWith: string;
}

export async function auditCustomers(raw: RawZohoData, asOf: string, ledger: LedgerBalances | null) {
  const rep = await fetchBalanceReport('customer', cacheDay(raw.fetchedAt), nameIndex(raw.activeCustomers));
  if (!rep.ok) {
    return {
      reportAvailable: false,
      customersCompared: 0,
      reportEqualsContactRecord: 0,
      reportEqualsDocuments: 0,
      differ: 0,
      differList: [] as CustomerDiffer[],
      reportCustomersNotHeld: [] as NotHeld[],
      reportCustomersNotHeldCount: 0,
      tried: rep.tried.map((t) => `${t.path} [${t.variant}] HTTP ${t.status}: ${t.error.slice(0, 200)}`),
    };
  }
  const docs = new Map(computeARDetail(raw, asOf, { ledger }).map((r) => [r.customerId, r.netTotal]));
  let compared = 0;
  let reportEqualsContact = 0;
  let reportEqualsDocuments = 0;
  const differ: CustomerDiffer[] = [];
  for (const c of raw.activeCustomers) {
    if (c.outstanding_receivable_amount === undefined) continue;
    const rec = c.outstanding_receivable_amount - (c.unused_credits_receivable_amount ?? 0);
    const r = rep.balances.get(c.contact_id) ?? 0;
    const d = docs.get(c.contact_id) ?? 0;
    if (Math.abs(rec) <= TOL && Math.abs(r) <= TOL && Math.abs(d) <= TOL) continue;
    compared += 1;
    const eqC = Math.abs(r - rec) <= TOL;
    const eqD = Math.abs(r - d) <= TOL;
    if (eqC) reportEqualsContact += 1;
    if (eqD) reportEqualsDocuments += 1;
    if (!eqC || !eqD) {
      differ.push({
        name: c.contact_name,
        report: rd(r),
        contactRecord: rd(rec),
        documents: rd(d),
        reportAgreesWith: eqC ? 'contact record only (our documents are missing something)' : eqD ? 'our documents only (the contact record is lagging)' : 'neither',
      });
    }
  }
  differ.sort((a, b) => Math.abs(b.report - b.documents) + Math.abs(b.report - b.contactRecord) - (Math.abs(a.report - a.documents) + Math.abs(a.report - a.contactRecord)));
  return {
    reportAvailable: true,
    customersCompared: compared,
    reportEqualsContactRecord: reportEqualsContact,
    reportEqualsDocuments: reportEqualsDocuments,
    differ: differ.length,
    differList: differ.slice(0, 20),
    // COVERAGE, read from Zoho's side: any customer with a balance on the report that the dashboard does not hold?
    reportCustomersNotHeld: reportBalancesNotHeld(rep.balances.entries(), new Set(raw.activeCustomers.map((c) => c.contact_id))).slice(0, 20),
    reportCustomersNotHeldCount: reportBalancesNotHeld(rep.balances.entries(), new Set(raw.activeCustomers.map((c) => c.contact_id))).length,
    tried: [] as string[],
  };
}

import type { RawZohoData } from './zoho-raw-fetch';
import { buildJNIndex, keptJNContacts } from './jn-clean';
import type { LedgerBalances } from './ledger';
import { payableItems } from './open-items';

export interface VendorAP {
  vendorId: string;
  vendorName: string;
  billedTotal: number; // what the bills + journals add up to (before credits)
  unappliedCredits: number; // excess payments / unused vendor credits
  /** The total: bills (JN-Clean spend added back) + ordinary journals, less unapplied payments and vendor credits. */
  netTotal: number;
  /** Zoho's own ledger balance for the vendor (its Statement balance) with JN-Clean rows removed, when available. */
  ledgerTotal?: number;
  /** ledgerTotal - netTotal. 0 = the documents add up to Zoho's ledger. */
  gap: number;
}

export interface APSummary {
  asOfDate: string;
  /** Set for a custom From-To range: only documents dated from this day on are counted (see payableItems). */
  fromDate?: string;
  vendors: VendorAP[];
  grandTotal: {
    billedTotal: number;
    unappliedCredits: number;
    netTotal: number;
  };
  ledgerGrandTotal?: number;
  unreconciledCount: number;
}

const TOL = 1; // rupees

/**
 * AP for every active vendor AS OF a date. Same design as AR: the TOTAL is
 * the sum of the documents (lib/open-items.ts), the ledger is the check.
 *
 * JN-Clean's own journal rows are not counted (your rule; they cancel on the
 * Statement). But the credit it spent on a bill sits inside that bill's
 * balance as if it had been paid, so it is added back; without that the sum
 * of the bills would fall short of the Statement by exactly that amount.
 * AP is shown as totals only -- no age split.
 *
 * Retention and TDS need no special handling: a bill's `total` is already
 * net of TDS and its `balance` excludes retention held, as on the Statement
 * (checked on AE/26-27/35: total 83,07,000, paid 51,12,000, retention
 * 31,95,000, balance 0).
 */
export function computeAPDetail(
  raw: RawZohoData,
  asOf: string,
  opts: { ledger?: LedgerBalances | null; historical?: boolean; from?: string } = {}
): VendorAP[] {
  const jn = buildJNIndex(raw.jnClean, asOf, raw.ledgerAccounts);
  const kept = keptJNContacts(jn, 'payable'); // contacts whose JN-Clean rows are kept because they do not cancel
  const { items, credits } = payableItems(raw, asOf, jn, opts.from);
  const ledger = opts.ledger?.vendors;

  return raw.activeVendors.map((v) => {
    const its = items.get(v.contact_id) ?? [];
    const billedTotal = Math.max(0, its.reduce((s, i) => s + i.amount, 0));
    const unappliedCredits = credits.get(v.contact_id) ?? 0;
    const explained = billedTotal - unappliedCredits;

    // in a past-date snapshot a vendor the report does not list had no balance that day
    const ledgerRaw = ledger?.get(v.contact_id) ?? (opts.historical && ledger ? 0 : undefined);
    // JN-Clean's effect on a vendor's payable is credit minus debit on the lines that
    // reach the vendor's ledger (Accounts Payable accounts), i.e. minus the
    // (debit - credit) the index stores for them.
    const ledgerTotal = ledgerRaw === undefined ? undefined : ledgerRaw + (kept.has(v.contact_id) ? 0 : (jn.netOnPayable.get(v.contact_id) ?? 0));
    // For a PAST date the stored ledger snapshot for that day is the total (documents can't be summed back in time).
    const netTotal = opts.historical && ledgerTotal !== undefined ? ledgerTotal : explained;
    const gap = opts.historical || ledgerTotal === undefined ? 0 : ledgerTotal - netTotal;

    return {
      vendorId: v.contact_id,
      vendorName: v.contact_name,
      billedTotal,
      unappliedCredits,
      netTotal,
      ledgerTotal,
      gap: Math.abs(gap) <= TOL ? 0 : gap,
    };
  });
}

/** What the dashboard shows: vendors whose documents total more than Re. 1, largest first (plus any whose ledger disagrees, flagged). */
export function computeAPSummary(
  raw: RawZohoData,
  asOf: string,
  opts: { ledger?: LedgerBalances | null; historical?: boolean; from?: string } = {}
): APSummary {
  // A custom range counts only part of the documents, so Zoho's whole-contact ledger cannot be a check on it.
  if (opts.from !== undefined) opts = { ...opts, ledger: null, historical: false };
  const vendors = computeAPDetail(raw, asOf, opts).filter((v) => v.netTotal > TOL || (v.ledgerTotal ?? 0) > TOL);
  vendors.sort((a, b) => b.netTotal - a.netTotal);

  const counted = vendors.filter((v) => v.netTotal > TOL);
  const grandTotal = counted.reduce(
    (acc, v) => ({
      billedTotal: acc.billedTotal + v.billedTotal,
      unappliedCredits: acc.unappliedCredits + v.unappliedCredits,
      netTotal: acc.netTotal + v.netTotal,
    }),
    { billedTotal: 0, unappliedCredits: 0, netTotal: 0 }
  );
  const haveLedger = vendors.some((v) => v.ledgerTotal !== undefined);

  return {
    asOfDate: asOf,
    ...(opts.from !== undefined ? { fromDate: opts.from } : {}),
    vendors,
    grandTotal,
    ledgerGrandTotal: haveLedger
      ? vendors.filter((v) => (v.ledgerTotal ?? 0) > TOL).reduce((s, v) => s + (v.ledgerTotal ?? 0), 0)
      : undefined,
    unreconciledCount: vendors.filter((v) => v.gap !== 0).length,
  };
}

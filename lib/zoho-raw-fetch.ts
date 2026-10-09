import {
  listActiveContacts,
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
import { syncJournalsToCompletion, assertJournalLinkage, type TrimmedJournal } from './journal-job';
import { syncJNClean, type JNSyncStats } from './jn-clean-store';
import type { JNCleanEntry } from './jn-clean';
import type { LedgerAccounts } from './accounts';
import { syncAccountTypes, type AccountTypeStats } from './account-types';
import { syncOpeningBalances, type OpeningBalances, type OpeningBalanceStats } from './opening-balances';
import { ledgerFromContacts, cacheDay, fetchBalanceReport, calibrate, nameIndex } from './ledger';
import { syncPaymentTds, type PaymentTdsStats } from './payment-tds';
import { computeARDetail } from './ar-calculator';
import { computeAPDetail } from './ap-calculator';
import { settleFlagged, type SettleStats } from './settle';

export interface RawZohoData {
  fetchedAt: string;
  activeCustomers: ZohoContact[];
  activeVendors: ZohoContact[];
  invoices: ZohoInvoice[];
  customerPayments: ZohoCustomerPayment[];
  creditNotes: ZohoCreditNote[];
  bills: ZohoBill[];
  vendorPayments: ZohoVendorPayment[];
  vendorCredits: ZohoVendorCredit[];
  journals: TrimmedJournal[];
  /** JN-Clean journals (contact lines + what their credit was spent on).
   *  Optional so an older cached snapshot still loads; the API reports it
   *  as "JN-Clean data not loaded" instead of failing. */
  jnClean?: JNCleanEntry[];
  jnCleanStats?: JNSyncStats;
  /** Which accounts are Accounts Receivable / Payable (only their journal lines reach a contact's ledger). */
  ledgerAccounts?: LedgerAccounts;
  accountTypeStats?: AccountTypeStats;
  /** TDS still withheld on the unused part of advance vendor payments (payment_id -> rupees). */
  vendorPaymentTds?: Record<string, number>;
  paymentTdsStats?: PaymentTdsStats;
  /** Zoho's vendor balance report as of the day of the read (vendor id -> balance): it counts TDS like the Statement does, unlike the contact record. */
  vendorLedgerToday?: Record<string, number>;
  /** Opening balances carried over from the old books, for contacts that have one. */
  openingBalances?: OpeningBalances;
  openingBalanceStats?: OpeningBalanceStats;
  /** What the automatic re-check of flagged contacts found at the end of the sync (timing noise cleared vs gaps that persist). */
  settleStats?: SettleStats;
}

/**
 * Pulls everything both calculators need, org-wide. The cheap parts
 * (contacts, invoices, bills, payments, credit notes, vendor credits) are
 * always fetched fresh here. Journals go through the incremental,
 * persistently-cached path in journal-job.ts -- pass already-fetched ones
 * from the chunked cron job when calling this from production; omit to
 * fall back to syncJournalsToCompletion(), which (after the very first
 * run ever) is normally fast, since it only fetches what's actually new
 * or changed since last time.
 */
export async function fetchAllRawData(precomputedJournals?: TrimmedJournal[]): Promise<RawZohoData> {
  // Stamped when the read BEGINS: the contact balances (the ledger) are read
  // first, and "is the requested date today?" is decided from this moment.
  const readStartedAt = new Date().toISOString();
  const [
    activeCustomers,
    activeVendors,
    invoices,
    customerPayments,
    creditNotes,
    bills,
    vendorPayments,
    vendorCredits,
  ] = await Promise.all([
    listActiveContacts('customer'),
    listActiveContacts('vendor'),
    listAllInvoices(),
    listAllCustomerPayments(),
    listAllCreditNotes(),
    listAllBills(),
    listAllVendorPayments(),
    listAllVendorCredits(),
  ]);

  const journals =
    precomputedJournals ??
    (await syncJournalsToCompletion((fetched, total) => {
      console.log(`[journals] ${fetched}/${total} fetched this run`);
    }));

  assertJournalLinkage(journals);

  // JN-Clean journals: net per contact + what their credit was spent on.
  // On the scheduled (serverless) path a time budget keeps this from running
  // past the function limit; anything left over is picked up on the next run.
  const jn = await syncJNClean({
    timeBudgetMs: precomputedJournals ? 30_000 : undefined,
    onProgress: (fetched, total) => console.log(`[jn-clean] ${fetched}/${total} fetched this run`),
  });

  // Which accounts reach a customer's / vendor's ledger: look up each account that
  // appears on a journal line tagged to a contact (once each, then remembered).
  const accountIds = new Set<string>();
  for (const j of journals) for (const l of j.line_items) if (l.contact_id && l.account_id) accountIds.add(l.account_id);
  for (const e of jn.entries) for (const l of e.lines) if (l.account_id) accountIds.add(l.account_id);
  const acc = await syncAccountTypes([...accountIds], {
    timeBudgetMs: precomputedJournals ? 20_000 : undefined,
    onProgress: (done, total) => console.log(`[account-types] ${done}/${total} looked up`),
  });
  const ledgerAccounts = acc.ledgerAccounts;

  // TDS withheld on advance payments (in the payment's own record, not in the list)
  const ptds = await syncPaymentTds(vendorPayments, {
    timeBudgetMs: precomputedJournals ? 20_000 : undefined,
    onProgress: (done, total) => console.log(`[payment-tds] ${done}/${total} looked up`),
  });

  const base: RawZohoData = {
    fetchedAt: readStartedAt,
    activeCustomers,
    activeVendors,
    invoices,
    customerPayments,
    creditNotes,
    bills,
    vendorPayments,
    vendorCredits,
    journals,
    jnClean: jn.entries,
    jnCleanStats: jn.stats,
    ledgerAccounts,
    accountTypeStats: acc.stats,
    vendorPaymentTds: ptds.tds,
    paymentTdsStats: ptds.stats,
  };

  // Vendors' ledger for today comes from Zoho's vendor balance report, which (like the Statement)
  // counts TDS on advances. It is used only if it agrees with the contact records for nearly everyone.
  const contactVendors = ledgerFromContacts(base).vendors;
  const vrep = await fetchBalanceReport('vendor', cacheDay(readStartedAt), nameIndex(activeVendors));
  if (vrep.ok && calibrate(vrep.balances, contactVendors).agreement >= 0.9 && calibrate(vrep.balances, contactVendors).sign === 1) {
    base.vendorLedgerToday = Object.fromEntries(vrep.balances);
  } else {
    console.warn('[vendor-report] vendor balance report unavailable or not matching the contact records; contact records are used as the vendor ledger.');
  }

  // Opening balances are not in any list. Look up only the contacts whose
  // documents do not already add up to Zoho's ledger (plus those already known
  // to carry one, whose outstanding amount changes as it is paid).
  const day = cacheDay(readStartedAt);
  const ledger = ledgerFromContacts(base);
  const flagged = [
    ...computeARDetail(base, day, { ledger }).filter((r) => r.gap !== 0).map((r) => r.customerId),
    ...computeAPDetail(base, day, { ledger }).filter((r) => r.gap !== 0).map((r) => r.vendorId),
  ];
  const ob = await syncOpeningBalances(flagged, {
    timeBudgetMs: precomputedJournals ? 20_000 : undefined,
    onProgress: (done, total) => console.log(`[opening-balances] ${done}/${total} looked up`),
  });

  // Last step: every contact still flagged is read again from Zoho, all at once. A gap that vanishes
  // was timing (staff posting during the sync) and the flag is cleared; one that remains is real.
  const settled = await settleFlagged(
    { ...base, openingBalances: ob.balances, openingBalanceStats: ob.stats },
    {
      // on the serverless path the whole run must fit in the function limit, so this step is kept small
      limit: precomputedJournals ? 15 : 80,
      timeBudgetMs: precomputedJournals ? 12_000 : undefined,
      resyncJournals: precomputedJournals ? undefined : () => syncJournalsToCompletion(),
      onProgress: (done, total) => console.log(`[settle] ${done}/${total} flagged contacts re-read`),
    }
  );
  return { ...settled.raw, settleStats: settled.stats };
}

import { differenceInCalendarDays, parseISO } from 'date-fns';
import {
  listActiveContacts,
  listInvoicesForCustomer,
  listCustomerPayments,
  listCreditNotesForCustomer,
  type ZohoContact,
} from './zoho-client';

export interface CustomerAR {
  customerId: string;
  customerName: string;
  less180: number;
  more180: number;
  agedTotal: number; // less180 + more180 — the sum of open invoice balances
  unappliedCredits: number; // excess payments / unused credit notes, not tied to a dated invoice
  netTotal: number; // agedTotal - unappliedCredits — this is the figure to report
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
}

/**
 * Computes one customer's AR position.
 *
 * Why this design, instead of re-deriving Zoho's own aggregate fields:
 * - `invoice.balance` is maintained by Zoho per invoice as payments/credit notes
 *   are applied to it. Journal entries (including JN-Clean reclassifications)
 *   never touch this field, so summing open invoice balances is immune to the
 *   JN-Clean contamination we found in the AR Aging Summary report's
 *   `unused_credits_receivable_amount` field — there's nothing to filter here.
 * - The one thing invoice balances can't capture is a payment or credit note
 *   that hasn't been matched to any invoice yet (an "excess"/unapplied amount
 *   sitting on the customer's account). We net that out as its own transparent
 *   line rather than guessing which aging bucket it should reduce.
 */
async function computeCustomerAR(
  contact: ZohoContact,
  asOfDate: Date,
  sinceDate?: string
): Promise<CustomerAR> {
  const [invoices, payments, creditNotes] = await Promise.all([
    listInvoicesForCustomer(contact.contact_id, sinceDate),
    listCustomerPayments(contact.contact_id, sinceDate),
    listCreditNotesForCustomer(contact.contact_id, sinceDate),
  ]);

  let less180 = 0;
  let more180 = 0;
  for (const inv of invoices) {
    if (!inv.balance || inv.balance <= 0) continue;
    const days = differenceInCalendarDays(asOfDate, parseISO(inv.due_date));
    if (days > 180) more180 += inv.balance;
    else less180 += inv.balance;
  }

  // `unused_amount` is Zoho's field for the portion of a payment not yet
  // applied to any invoice. Confirm this field name against a live response
  // once credentials are connected — noted in README as a first-run check.
  const unappliedFromPayments = payments.reduce(
    (sum, p) => sum + ((p as unknown as { unused_amount?: number }).unused_amount ?? 0),
    0
  );
  const unappliedFromCredits = creditNotes.reduce((sum, cn) => sum + (cn.balance ?? 0), 0);
  const unappliedCredits = unappliedFromPayments + unappliedFromCredits;

  const agedTotal = less180 + more180;
  return {
    customerId: contact.contact_id,
    customerName: contact.contact_name,
    less180,
    more180,
    agedTotal,
    unappliedCredits,
    netTotal: agedTotal - unappliedCredits,
  };
}

export async function computeARSummary(sinceDate?: string): Promise<ARSummary> {
  const asOfDate = new Date();
  const activeCustomers = await listActiveContacts('customer');

  const customers = await Promise.all(
    activeCustomers.map((c) => computeCustomerAR(c, asOfDate, sinceDate))
  );

  // Drop customers with a negligible/zero net position, matching the
  // established bank-statement convention (exclude if <= Re. 1).
  const included = customers.filter((c) => c.netTotal > 1);
  included.sort((a, b) => b.netTotal - a.netTotal);

  const grandTotal = included.reduce(
    (acc, c) => ({
      less180: acc.less180 + c.less180,
      more180: acc.more180 + c.more180,
      agedTotal: acc.agedTotal + c.agedTotal,
      unappliedCredits: acc.unappliedCredits + c.unappliedCredits,
      netTotal: acc.netTotal + c.netTotal,
    }),
    { less180: 0, more180: 0, agedTotal: 0, unappliedCredits: 0, netTotal: 0 }
  );

  return { asOfDate: asOfDate.toISOString(), customers: included, grandTotal };
}

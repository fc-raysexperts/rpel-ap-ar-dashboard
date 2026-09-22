import {
  listActiveContacts,
  listBillsForVendor,
  listVendorPayments,
  listVendorCreditsForVendor,
  type ZohoContact,
} from './zoho-client';

export interface VendorAP {
  vendorId: string;
  vendorName: string;
  billedTotal: number; // sum of open bill balances
  unappliedCredits: number; // excess payments / unused vendor credits
  netTotal: number; // billedTotal - unappliedCredits
}

export interface APSummary {
  asOfDate: string;
  vendors: VendorAP[];
  grandTotal: {
    billedTotal: number;
    unappliedCredits: number;
    netTotal: number;
  };
}

/** Mirrors computeCustomerAR — see the comment there for why this approach
 *  sidesteps the JN-Clean contamination issue by construction. */
async function computeVendorAP(contact: ZohoContact, sinceDate?: string): Promise<VendorAP> {
  const [bills, payments, credits] = await Promise.all([
    listBillsForVendor(contact.contact_id, sinceDate),
    listVendorPayments(contact.contact_id, sinceDate),
    listVendorCreditsForVendor(contact.contact_id, sinceDate),
  ]);

  const billedTotal = bills.reduce((sum, b) => sum + (b.balance > 0 ? b.balance : 0), 0);

  const unappliedFromPayments = payments.reduce(
    (sum, p) => sum + ((p as unknown as { unused_amount?: number }).unused_amount ?? 0),
    0
  );
  const unappliedFromCredits = credits.reduce((sum, c) => sum + (c.balance ?? 0), 0);
  const unappliedCredits = unappliedFromPayments + unappliedFromCredits;

  return {
    vendorId: contact.contact_id,
    vendorName: contact.contact_name,
    billedTotal,
    unappliedCredits,
    netTotal: billedTotal - unappliedCredits,
  };
}

export async function computeAPSummary(sinceDate?: string): Promise<APSummary> {
  const asOfDate = new Date();
  const activeVendors = await listActiveContacts('vendor');

  const vendors = await Promise.all(activeVendors.map((v) => computeVendorAP(v, sinceDate)));

  const included = vendors.filter((v) => v.netTotal > 1);
  included.sort((a, b) => b.netTotal - a.netTotal);

  const grandTotal = included.reduce(
    (acc, v) => ({
      billedTotal: acc.billedTotal + v.billedTotal,
      unappliedCredits: acc.unappliedCredits + v.unappliedCredits,
      netTotal: acc.netTotal + v.netTotal,
    }),
    { billedTotal: 0, unappliedCredits: 0, netTotal: 0 }
  );

  return { asOfDate: asOfDate.toISOString(), vendors: included, grandTotal };
}

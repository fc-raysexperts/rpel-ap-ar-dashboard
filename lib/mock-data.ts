// Mock data for local development without live Zoho credentials.
// The Wonder Cement and Abhishek Enterprises figures below are taken from the
// real customer/vendor statements we validated by hand — SUM(Amount) -
// SUM(Payments) matched Zoho's own "Balance Due" to the rupee for both. The
// other entries are illustrative filler so the dashboard has a realistic
// number of rows to render.

import type { ARSummary, CustomerAR } from './ar-calculator';
import type { APSummary, VendorAP } from './ap-calculator';

function ar(
  customerName: string,
  less180: number,
  more180: number,
  unappliedCredits: number
): CustomerAR {
  const agedTotal = less180 + more180;
  return {
    customerId: `mock-${customerName.replace(/\s+/g, '-').toLowerCase()}`,
    customerName,
    less180,
    more180,
    agedTotal,
    unappliedCredits,
    netTotal: agedTotal - unappliedCredits,
    gap: 0,
  };
}

function ap(vendorName: string, billedTotal: number, unappliedCredits: number): VendorAP {
  return {
    vendorId: `mock-${vendorName.replace(/\s+/g, '-').toLowerCase()}`,
    vendorName,
    billedTotal,
    unappliedCredits,
    netTotal: billedTotal - unappliedCredits,
    gap: 0,
  };
}

const mockCustomers: CustomerAR[] = [
  ar('Wonder Cement Limited ( Phase 2)', 46498061, 0, 0), // validated exact figure
  ar('JSW Green Energy Fifteen Ltd.', 9800000, 1755069, 0),
  ar('Soltown Infra Private Limited', 7638968, 0, 0),
  ar('Balkrishna Industries Limited', 3200000, 358511, 250000),
  ar('Rays Rooftop SPV Private Limited', 3435102, 0, 0),
  ar('ASK Automobiles Private Limited', 2900000, 218037, 0),
  ar('Wonder Cement Limited', 3199738, 0, 0),
  ar('Kamdhenu Limited', 1153927, 0, 400000),
].sort((a, b) => b.netTotal - a.netTotal);

const mockVendors: VendorAP[] = [
  ap('Abhishek Enterprises', 30430156, 0), // validated exact figure
  ap('Mecpower Infrastructure Private Limited', 22869488, 0),
  ap('Cyrun-Infra Projects LLP', 14692068, 0),
  ap('Maa Naganarai Infra', 12654568, 0),
  ap('Surendra Trading Company', 8550288, 0),
  ap('Jai Bhawani Contractor', 8517600, 150000),
  ap('Metal S & Metal (Electric) Pvt.Ltd.', 7639796, 0),
  ap('Brothers Enterprises', 5177600, 0),
].sort((a, b) => b.netTotal - a.netTotal);

export function getMockARSummary(): ARSummary {
  const grandTotal = mockCustomers.reduce(
    (acc, c) => ({
      less180: acc.less180 + c.less180,
      more180: acc.more180 + c.more180,
      agedTotal: acc.agedTotal + c.agedTotal,
      unappliedCredits: acc.unappliedCredits + c.unappliedCredits,
      netTotal: acc.netTotal + c.netTotal,
    }),
    { less180: 0, more180: 0, agedTotal: 0, unappliedCredits: 0, netTotal: 0 }
  );
  return { asOfDate: new Date().toISOString(), customers: mockCustomers, grandTotal, unreconciledCount: 0 };
}

export function getMockAPSummary(): APSummary {
  const grandTotal = mockVendors.reduce(
    (acc, v) => ({
      billedTotal: acc.billedTotal + v.billedTotal,
      unappliedCredits: acc.unappliedCredits + v.unappliedCredits,
      netTotal: acc.netTotal + v.netTotal,
    }),
    { billedTotal: 0, unappliedCredits: 0, netTotal: 0 }
  );
  return { asOfDate: new Date().toISOString(), vendors: mockVendors, grandTotal, unreconciledCount: 0 };
}

export function isMockMode(): boolean {
  return process.env.ZOHO_MOCK_MODE === 'true' || !process.env.ZOHO_CLIENT_ID;
}

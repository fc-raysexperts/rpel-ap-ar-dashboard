// Shared across both calculators: any transaction (Bill, Invoice, Credit
// Note, Vendor Credit, Journal, Payment) that has NOT actually posted to the
// ledger must never count toward a real AP/AR figure:
//
//   draft, rejected, void   -- not finalized, or explicitly cancelled
//   pending_approval        -- submitted but not yet approved. Zoho leaves
//                              these out of a contact's outstanding balance
//                              and its Statement until approved. Confirmed on
//                              Abhishek Enterprises: five bills awaiting
//                              approval, Rs 1,09,46,636.80 in all, were the
//                              whole difference between our documents and
//                              Zoho's ledger.
//   submitted               -- the same state as it is named on journals
//
// Confirmed necessary in practice: a single draft bill (never approved,
// invisible in Zoho's own Statement view) was exactly what inflated Indian
// Customs EDI Gateway to Rs 8.37cr before this check existed.
//
// Applied wherever a fetched record HAS a status field. Records that don't
// carry one at all (e.g. this org's Customer/Vendor Payments, which don't
// appear to expose a draft/reject/void workflow) are left alone -- this is a
// filter, not an assumption that every object type has these states.
const EXCLUDED_STATUSES = new Set(['draft', 'rejected', 'void', 'pending_approval', 'submitted']);

export function isExcludedStatus(status: string | undefined): boolean {
  if (!status) return false;
  return EXCLUDED_STATUSES.has(status.trim().toLowerCase().replace(/[\s-]+/g, '_'));
}

// A contact's balance in Zoho (its Statement, its "outstanding" and "unused
// credits") is built ONLY from journal lines posted to Accounts Receivable /
// Accounts Payable type accounts. A journal line can still carry a customer
// or vendor tag on some other account -- e.g. JN-Clean-210 credits an account
// named "Abhilasha Goswami" (type Other Current Asset) and debits "Sundry
// Creditors- Others" (type Accounts Payable); only the debit reaches her
// ledger. Counting both made her JN-Clean pair look like it cancels when, in
// her ledger, it does not.

export interface LedgerAccounts {
  receivable: string[];
  payable: string[];
  /** accounts whose type could not be looked up: treated as reaching the ledger (never silently dropped) */
  unknown?: string[];
}

export interface AccountSets {
  receivable: Set<string>;
  payable: Set<string>;
}

export function accountSets(la: LedgerAccounts | undefined): AccountSets | null {
  if (!la || la.receivable.length === 0 || la.payable.length === 0) return null; // incomplete knowledge = unknown, never a partial filter
  const unknown = la.unknown ?? [];
  return { receivable: new Set([...la.receivable, ...unknown]), payable: new Set([...la.payable, ...unknown]) };
}

/**
 * True when a line belongs in a customer's (side 'receivable') or vendor's
 * (side 'payable') ledger. If the account types are not known, or the line
 * does not say which account it is on, the line is counted (the previous
 * behaviour) rather than silently dropped.
 */
export function lineHitsLedger(sets: AccountSets | null, side: 'receivable' | 'payable', accountId: string | undefined): boolean {
  if (!sets || !accountId) return true;
  return sets[side].has(accountId);
}

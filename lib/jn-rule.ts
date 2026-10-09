// How JN-Clean rows are treated for a contact where they do NOT cancel on its ledger.
//
//   'cancelling-only' (default)  JN-Clean rows are excluded only where they cancel (net ~0 on the contact's
//                                Accounts Receivable / Payable ledger -- the usual case, 570-odd contacts). Where one
//                                leg sits on another kind of account (e.g. a group loan account), the single leg that
//                                reaches the ledger is a real balance, so it is KEPT and the dashboard equals the
//                                Zoho Statement for that contact.
//   'literal'                    Every JN-Clean row is excluded, cancelling or not (the earlier behaviour). The
//                                dashboard then differs from the Statement by the JN net for the non-cancelling contacts.
//
// Switch back with  JN_CLEAN_RULE=literal  (in .env.local and on Vercel).
export type JNRule = 'cancelling-only' | 'literal';

export function jnRule(): JNRule {
  return String(process.env.JN_CLEAN_RULE ?? 'cancelling-only').trim().toLowerCase() === 'literal' ? 'literal' : 'cancelling-only';
}

import { parseISO } from 'date-fns';
import type { RawZohoData } from './zoho-raw-fetch';
import { computeARDetail } from './ar-calculator';
import { computeAPDetail } from './ap-calculator';
import { buildJNIndex, keptJNContacts } from './jn-clean';
import { jnRule } from './jn-rule';
import { cacheDay, type LedgerBalances } from './ledger';
import { isExcludedStatus } from './status-filter';
import { accountSets, lineHitsLedger } from './accounts';
import { foreignContacts, foreignBreakdown, foreignSummary } from './foreign';
import { readContactFresh, readVendorReport, evaluateFresh, idOf, nameOf, type Row, type FreshContact } from './settle';

// The proof layer. Totals come from the documents (invoices, bills, journals,
// credits); Zoho's ledger is an independent second route to the same number.
// For every contact the two must agree. Where they don't, the row is flagged
// with both figures and the gap, so nothing is silently absorbed:
//
//   - a gap that disappears when the contact is re-read from Zoho was timing
//     (staff were posting while the cache was being read). The sync now does
//     this re-read itself at the end (lib/settle.ts), so a flag that survives
//     into the cache has already been through it;
//   - a gap that persists points at something the documents don't cover
//     (an item type we don't fetch, or JN-Clean applications we couldn't read).

const TOL = 1;
const rd = (n: number) => Math.round(n);

function flaggedRows(r: Row[]) {
  return r
    .filter((x) => x.gap !== 0)
    .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap))
    .map((x) => ({
      contactId: idOf(x),
      name: nameOf(x),
      documentsTotal: rd(x.netTotal),
      zohoLedger: x.ledgerTotal === undefined ? null : rd(x.ledgerTotal),
      gap: rd(x.gap),
    }));
}

function summarize(rows: Row[]) {
  const withBalance = rows.filter((r) => Math.abs(r.netTotal) > TOL || Math.abs(r.ledgerTotal ?? 0) > TOL);
  const flagged = flaggedRows(withBalance);
  return {
    activeContacts: rows.length,
    contactsWithABalance: withBalance.length,
    reconciled: withBalance.length - flagged.length,
    flagged: flagged.length,
    documentsTotalPositive: rd(rows.filter((r) => r.netTotal > TOL).reduce((s, r) => s + r.netTotal, 0)),
    zohoLedgerTotalPositive: rd(rows.filter((r) => (r.ledgerTotal ?? 0) > TOL).reduce((s, r) => s + (r.ledgerTotal ?? 0), 0)),
    biggestGaps: flagged.slice(0, 25),
  };
}

function jnChecks(raw: RawZohoData, asOf: string, ledger: LedgerBalances | null, listAll: boolean) {
  const idx = buildJNIndex(raw.jnClean, asOf, raw.ledgerAccounts);
  const names = new Map<string, string>();
  for (const c of raw.activeCustomers) names.set(c.contact_id, c.contact_name + ' (customer)');
  for (const v of raw.activeVendors) names.set(v.contact_id, v.contact_name + ' (vendor)');
  // Only lines on Receivable / Payable accounts reach a contact's ledger, so that
  // is where JN-Clean has to cancel.
  const onLedger: { id: string; side: 'customer' | 'vendor'; net: number }[] = [
    ...raw.activeCustomers.map((c) => ({ id: c.contact_id, side: 'customer' as const, net: idx.netOnReceivable.get(c.contact_id) ?? 0 })),
    ...raw.activeVendors.map((v) => ({ id: v.contact_id, side: 'vendor' as const, net: idx.netOnPayable.get(v.contact_id) ?? 0 })),
  ];
  const nonZeroRaw = onLedger.filter((x) => Math.abs(x.net) > TOL).sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
  // What the Statement shows (Zoho's ledger), what the LITERAL rule (every JN-Clean row excluded) would show,
  // and what the dashboard shows under the rule in force (default: JN-Clean rows kept where they do not cancel).
  const keptSet = { customer: keptJNContacts(idx, 'receivable'), vendor: keptJNContacts(idx, 'payable') };
  const withBalances = nonZeroRaw.map((x) => {
    const statement = ledger ? (x.side === 'customer' ? ledger.customers : ledger.vendors).get(x.id) ?? 0 : undefined;
    const literal = statement === undefined ? undefined : x.side === 'customer' ? statement - x.net : statement + x.net;
    const dashboard = statement === undefined || literal === undefined ? undefined : keptSet[x.side].has(x.id) ? statement : literal;
    return { ...x, statement, literal, dashboard };
  });
  const nonZero = withBalances.map((x) => ({
    contactId: x.id,
    name: names.get(x.id) ?? '(inactive or unknown contact)',
    debitMinusCredit: rd(x.net),
    ...(x.statement === undefined || x.literal === undefined || x.dashboard === undefined
      ? {}
      : { statementBalance: rd(x.statement), literalRuleBalance: rd(x.literal), dashboardBalance: rd(x.dashboard), changesSide: x.statement > TOL !== x.literal > TOL }),
  }));

  // How much the LITERAL rule would move the headline totals against the Statements: only balances above zero count towards Debtors / Creditors.
  const effectFor = (side: 'customer' | 'vendor') => {
    const rows = withBalances.filter((x) => x.side === side && x.statement !== undefined && x.literal !== undefined);
    const pos = (n: number | undefined) => ((n ?? 0) > TOL ? (n as number) : 0);
    const literal = rows.reduce((a, x) => a + pos(x.literal), 0);
    const asStatement = rows.reduce((a, x) => a + pos(x.statement), 0);
    return {
      contactsWhereJNDoesNotCancel: rows.length,
      contactsWhoseBalanceWouldChangeSide: rows.filter((x) => (x.statement as number) > TOL !== (x.literal as number) > TOL).length,
      positiveBalancesLiteralRule: rd(literal),
      positiveBalancesAsStatement: rd(asStatement),
      literalRuleWouldAdd: rd(literal - asStatement),
    };
  };

  const invIds = new Set(raw.invoices.map((i) => i.invoice_id));
  const billIds = new Set(raw.bills.map((b) => b.bill_id));
  let unmatched = 0;
  let unmatchedAmount = 0;
  for (const [id, amt] of idx.appliedByInvoice) if (!invIds.has(id)) { unmatched += 1; unmatchedAmount += amt; }
  for (const [id, amt] of idx.appliedByBill) if (!billIds.has(id)) { unmatched += 1; unmatchedAmount += amt; }

  return {
    loaded: raw.jnClean !== undefined,
    accountTypes: raw.accountTypeStats ?? null,
    openingBalances: raw.openingBalanceStats ?? null,
    contactsWithJNLines: idx.contactCount,
    contactsWhereJNDoesNotCancel: nonZero.length,
    nonCancelling: listAll ? nonZero : nonZero.slice(0, 10),
    rule: jnRule(),
    ruleMeaning: jnRule() === 'literal'
      ? 'literal: every JN-Clean row is excluded, so contacts where it does not cancel differ from their Statement by the JN net.'
      : 'cancelling-only: JN-Clean rows are excluded only where they cancel; where they do not, the row is kept and the dashboard equals the Statement for that contact.',
    ...(ledger ? { headlineEffectOfTheRule: { customers: effectFor('customer'), vendors: effectFor('vendor'), meaning: 'For contacts where JN-Clean does not cancel on the receivable/payable ledger: the total of their positive balances under the LITERAL rule (every JN-Clean row excluded) against the same contacts as Zoho\'s Statement shows them. literalRuleWouldAdd is how much higher (+) or lower (-) the Debtors / Creditors headline would be under the literal rule. Under the default rule (cancelling-only) the dashboard equals the Statement for these contacts, so this is the difference you avoided.' } } : {}),
    applicationsRead: idx.applicationCount,
    applicationsTotal: rd(idx.applicationTotal),
    applicationsOnDocumentsWeDoNotHold: unmatched,
    applicationsOnDocumentsWeDoNotHoldAmount: rd(unmatchedAmount),
    syncStats: raw.jnCleanStats ?? null,
  };
}

function foreignCurrencyChecks(raw: RawZohoData) {
  const foreign = raw.journals.filter((j) => j.currency_code || j.line_items.some((l) => l.face_amount !== undefined));
  // Self-check: the debit side of a converted journal must add up to the rupee total Zoho itself shows for it.
  const offTotal = foreign
    .filter((j) => j.bcy_total !== undefined)
    .map((j) => ({ j, debits: j.line_items.filter((l) => l.debit_or_credit === 'debit').reduce((s, l) => s + l.amount, 0) }))
    .filter(({ j, debits }) => Math.abs(debits - (j.bcy_total as number)) > 1);
  const views = foreignContacts(raw);
  return {
    contacts: {
      howToRead:
        'Contacts with a foreign-currency side, from Zoho\'s own figures: its balance in each currency, the exchange rate on each open foreign document, and its rupee balance. ' +
        'A Statement is compared with these column by column (npm run check-statement), so no rate is ever worked out or guessed. ' +
        'openDocumentsAgree = the open bills/payments/credits/journals add up to Zoho\'s balance in that currency. problems must be empty.',
      count: views.length,
      withAForeignBalance: views.filter((v) => v.status === 'open').length,
      withOnlyARupeeResidual: views.filter((v) => v.status === 'residual').length,
      withProblems: views.filter((v) => v.problems.length > 0).length,
      perCurrencyBalancesInCache: views.every((v) => v.hasContactCurrencies) ? 'yes' : 'NO -- some were cached before this was kept: run npm run sync-cache',
      list: views.filter((v) => v.status === 'open' || v.status === 'residual' || v.problems.length > 0).map(foreignSummary),
      settledOrUntouched: views.filter((v) => v.status === 'settled' || v.status === 'tag').map((v) => `${v.name} (${v.status})`),
    },
    journalsInForeignCurrency: foreign.length,
    journalsWhoseRupeeTotalDiffersFromZoho: offTotal.length,
    offTotalExamples: offTotal.slice(0, 5).map(({ j, debits }) => ({ journal: j.entry_number, currency: j.currency_code ?? null, ourRupeeDebits: rd(debits), zohoRupeeTotal: rd(j.bcy_total as number) })),
    note: 'Lines of these journals are counted at their rupee value (Zoho\'s bcy_amount), not at the face amount in the foreign currency.',
    examples: foreign.slice(0, 5).map((j) => ({
      journal: j.entry_number,
      date: j.journal_date,
      currency: j.currency_code ?? null,
      rate: j.exchange_rate ?? null,
      lines: j.line_items.filter((l) => l.contact_id).map((l) => ({ side: l.debit_or_credit, faceAmount: l.face_amount ?? null, rupees: l.amount })),
    })),
  };
}

export function reconcile(raw: RawZohoData, asOf: string, ledger: LedgerBalances | null, opts: { jnAll?: boolean } = {}) {
  return {
    ledgerSource: ledger ? ledger.source : 'none (documents only)',
    autoRecheckAtEndOfSync: raw.settleStats ?? 'not run (cache written before this feature)',
    foreignCurrency: foreignCurrencyChecks(raw),
    customers: summarize(computeARDetail(raw, asOf, { ledger })),
    vendors: summarize(computeAPDetail(raw, asOf, { ledger })),
    jnClean: jnChecks(raw, asOf, ledger, opts.jnAll ?? false),
    howToRead:
      'reconciled = the documents (invoices/bills + journals, JN-Clean spend added back, less credits) add up to Zoho\'s ledger balance within Re. 1. ' +
      'flagged = they do not; add &reread=1 to re-read the biggest flagged contacts from Zoho and separate timing noise from real gaps. ' +
      'Add ?name=<part of a contact name> to see everything behind one contact.',
  };
}

// ------------------------------------------------ re-read flagged contacts

export async function rereadFlagged(raw: RawZohoData, asOf: string, ledger: LedgerBalances | null, limit = 15) {
  const picks = [
    ...computeARDetail(raw, asOf, { ledger }).filter((r) => r.gap !== 0).map((r) => ({ side: 'customer' as const, r })),
    ...computeAPDetail(raw, asOf, { ledger }).filter((r) => r.gap !== 0).map((r) => ({ side: 'vendor' as const, r })),
  ]
    .sort((a, b) => Math.abs(b.r.gap) - Math.abs(a.r.gap))
    .slice(0, limit);

  // Same picture the sync's own re-check builds: contact + all its documents, then the vendor report
  // read AFTER them (never the stale report from the cache).
  const fresh: FreshContact[] = [];
  const failed = new Map<string, string>();
  for (const { side, r } of picks) {
    try {
      fresh.push(await readContactFresh(side, idOf(r), (side === 'customer' ? raw.activeCustomers : raw.activeVendors).find((c) => c.contact_id === idOf(r))));
    } catch (e) {
      failed.set(idOf(r), e instanceof Error ? e.message : String(e));
    }
  }
  const vendorReport = fresh.some((f) => f.side === 'vendor') ? await readVendorReport(raw, cacheDay(raw.fetchedAt), new Set(fresh.filter((f) => f.side === 'vendor').map((f) => f.id))) : null;
  const now = new Date().toISOString();

  return picks.map(({ side, r }) => {
    const err = failed.get(idOf(r));
    if (err) return { name: nameOf(r), side, error: err };
    const f = fresh.find((x) => x.id === idOf(r))!;
    const after = evaluateFresh(raw, asOf, f, vendorReport, now);
    return {
      name: nameOf(r),
      side,
      gapBefore: rd(r.gap),
      gapAfter: rd(after.gap),
      verdict: after.gap === 0 ? 'timing noise (gone on re-read)' : 'persists: the documents do not add up to Zoho ledger',
      documentsNow: rd(after.netTotal),
      zohoLedgerNow: after.ledgerTotal === undefined ? null : rd(after.ledgerTotal),
      vendorLedgerFrom: side === 'vendor' ? (vendorReport?.has(idOf(r)) ? 'fresh vendor balance report' : 'fresh contact record less TDS') : 'fresh contact record',
    };
  });
}

// ------------------------------------------------ one-contact breakdown

const cap = <T,>(arr: T[], n = 40) => ({ count: arr.length, shown: arr.slice(0, n) });

export function contactBreakdown(raw: RawZohoData, asOf: string, ledger: LedgerBalances | null, nameFragment: string, limit = 40) {
  // how the code classified an account: does a line on it reach a customer's / vendor's ledger?
  const la = raw.ledgerAccounts;
  const accountKind = (id?: string) =>
    !id ? 'no account id' : la?.receivable.includes(id) ? 'RECEIVABLE' : la?.payable.includes(id) ? 'PAYABLE' : la?.unknown?.includes(id) ? 'unknown (counted)' : la ? 'other (does not reach ledger)' : 'types not loaded (counted)';
  const asOfDate = parseISO(asOf);
  const needle = nameFragment.toLowerCase();
  const jn = buildJNIndex(raw.jnClean, asOf, raw.ledgerAccounts);
  const sets = accountSets(raw.ledgerAccounts);
  const arRows = computeARDetail(raw, asOf, { ledger });
  const apRows = computeAPDetail(raw, asOf, { ledger });

  const matches = [
    ...raw.activeCustomers.filter((c) => c.contact_name.toLowerCase().includes(needle)).map((c) => ({ side: 'customer' as const, c })),
    ...raw.activeVendors.filter((c) => c.contact_name.toLowerCase().includes(needle)).map((c) => ({ side: 'vendor' as const, c })),
  ].slice(0, 5);

  return matches.map(({ side, c }) => {
    const id = c.contact_id;
    const result = (side === 'customer' ? arRows : apRows).find((r) => idOf(r) === id)!;

    const docs =
      side === 'customer'
        ? raw.invoices.filter((d) => d.customer_id === id).map((d) => ({ kind: 'invoice', id: d.invoice_id, date: d.date, due: d.due_date, status: d.status, total: d.total, balance: d.balance, jnSpent: jn.appliedByInvoice.get(d.invoice_id) ?? 0 }))
        : raw.bills.filter((d) => d.vendor_id === id).map((d) => ({ kind: 'bill', id: d.bill_id, date: d.date, due: d.due_date, status: d.status, total: d.total, balance: d.balance, jnSpent: jn.appliedByBill.get(d.bill_id) ?? 0 }));

    const counted = docs
      .filter((d) => d.balance + d.jnSpent > 0 && !isExcludedStatus(d.status) && parseISO(d.date) <= asOfDate)
      .map((d) => ({ ...d, openIncludingJNSpend: d.balance + d.jnSpent }));
    const notCounted = docs
      .filter((d) => d.balance + d.jnSpent > 0 && (isExcludedStatus(d.status) || parseISO(d.date) > asOfDate))
      .map((d) => ({ ...d, whyNotCounted: isExcludedStatus(d.status) ? `status is ${d.status}` : 'dated after the as-of date' }));

    const lines = raw.journals
      .filter((j) => parseISO(j.journal_date) <= asOfDate)
      .flatMap((j) => j.line_items.filter((l) => l.contact_id === id).map((l) => ({ journal: j.entry_number, date: j.journal_date, side: l.debit_or_credit, amount: l.amount, account: l.account_name, ...(l.face_amount !== undefined ? { faceAmount: l.face_amount, currency: j.currency_code ?? null, rate: j.exchange_rate ?? null, rupees: l.amount } : {}), availableCreditOnJournal: side === 'customer' ? (j.available_receivables_credits ?? null) : (j.available_payables_credits ?? null), accountKind: accountKind(l.account_id), reachesLedger: lineHitsLedger(sets, side === 'customer' ? 'receivable' : 'payable', l.account_id) })));

    const jnLines = (raw.jnClean ?? []).flatMap((e) =>
      e.lines.filter((l) => l.contact_id === id).map((l) => ({ journal: e.entry_number, date: e.journal_date, side: l.debit_or_credit, amount: l.amount, accountId: l.account_id ?? null, accountKind: accountKind(l.account_id) }))
    );

    const payments =
      side === 'customer'
        ? raw.customerPayments.filter((p) => p.customer_id === id && (p.unused_amount ?? 0) > 0).map((p) => ({ id: p.payment_id, date: p.date, status: p.status, amount: p.amount, unapplied: p.unused_amount }))
        : raw.vendorPayments.filter((p) => p.vendor_id === id && (p.unused_amount ?? 0) > 0).map((p) => ({ id: p.payment_id, date: p.date, status: p.status, amount: p.amount, unapplied: p.unused_amount, tdsWithheldOnUnused: raw.vendorPaymentTds?.[p.payment_id] ?? 0 }));

    const credits =
      side === 'customer'
        ? raw.creditNotes.filter((x) => x.customer_id === id && x.balance > 0).map((x) => ({ id: x.creditnote_id, date: x.date, status: x.status, balance: x.balance }))
        : raw.vendorCredits.filter((x) => x.vendor_id === id && x.balance > 0).map((x) => ({ id: x.vendor_credit_id, date: x.date, status: x.status, balance: x.balance }));

    const outstanding = side === 'customer' ? c.outstanding_receivable_amount : c.outstanding_payable_amount;
    const unused = side === 'customer' ? c.unused_credits_receivable_amount : c.unused_credits_payable_amount;

    return {
      contact: c.contact_name,
      side,
      result: { ...result, netTotal: rd(result.netTotal), ledgerTotal: result.ledgerTotal === undefined ? null : rd(result.ledgerTotal), gap: rd(result.gap) },
      zohoContactRecord: { outstanding, unusedCredits: unused, ledgerBalance: outstanding === undefined ? null : rd(outstanding - (unused ?? 0)) },
      jnClean: {
        rule: jnRule(),
        rowsKept: (side === 'customer' ? keptJNContacts(jn, 'receivable') : keptJNContacts(jn, 'payable')).has(id),
        netDebitMinusCreditOnLedger: rd((side === 'customer' ? jn.netOnReceivable : jn.netOnPayable).get(id) ?? 0),
        lines: jnLines,
        spentOnDocuments: rd(docs.reduce((s, d) => s + d.jnSpent, 0)),
      },
      openingBalance: raw.openingBalances?.[id] ?? null,
      foreignCurrency: (() => {
        const f = foreignBreakdown(raw, c);
        return f ? foreignSummary(f) : null;
      })(),
      openDocumentsCounted: { ...cap(counted, limit), total: rd(counted.reduce((s, d) => s + d.openIncludingJNSpend, 0)) },
      openDocumentsNotCounted: cap(notCounted, limit),
      ordinaryJournalLines: cap(lines, limit),
      unappliedPayments: { ...cap(payments, limit), total: rd(payments.reduce((s, p) => s + (p.unapplied ?? 0), 0)) },
      creditNotesOrVendorCredits: { ...cap(credits, limit), total: rd(credits.reduce((s, x) => s + x.balance, 0)) },
    };
  });
}

// Offline self-test (no credentials, no network). Run: npm run selftest
//
// Part A rebuilds three REAL contacts from their official Statements and
// checks the calculators reproduce each Statement balance to the rupee.
// Part B runs the real fetch -> trim -> store -> calculate pipeline against
// faked Zoho responses shaped like the real ones.

process.env.ZOHO_CLIENT_ID = 'x';
process.env.ZOHO_CLIENT_SECRET = 'x';
process.env.ZOHO_REFRESH_TOKEN = 'x';
process.env.ZOHO_ORGANIZATION_ID = '1';
process.env.ZOHO_ACCOUNTS_BASE = 'https://accounts.test';
process.env.ZOHO_API_BASE = 'https://zoho.test/books/v3';
process.env.ZOHO_RETRY_BASE_MS = '1'; // keep the retry test fast
process.env.ZOHO_MAX_PER_MIN = '100000'; // the pacing test below lowers this temporarily
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.JN_CLEAN_RULE; // the tests choose the rule themselves; a value in your shell must not leak in

import { fetchAllRawData, type RawZohoData } from '../lib/zoho-raw-fetch';
import { computeARDetail, computeARSummary } from '../lib/ar-calculator';
import { computeAPDetail, computeAPSummary } from '../lib/ap-calculator';
import { ZB_EARLIEST_DATE, clampISO, isISODate, rangeFrom } from '../lib/period';
import { ledgerFromContacts, getLedgerFor, cacheDay, calibrate, parseReportRows } from '../lib/ledger';
import { buildJNIndex, extractJNEntry, type JNCleanEntry } from '../lib/jn-clean';
import { splitAtEdge, type OpenItem } from '../lib/open-items';
import { isExcludedStatus } from '../lib/status-filter';
import { parseAgingRows, splitRow, fetchArAging, type AgingRecord } from '../lib/aging';
import { chooseAgingOpeningBasis } from '../lib/ar-calculator';
import { reconcile, contactBreakdown } from '../lib/reconcile';
import { auditVendors } from '../lib/audit';
import { isForeignJournal, journalLineInBase, selectContacts, trimContact, type ZohoContact } from '../lib/zoho-client';
import { currencyCodeMap, contactCurrencies, foreignDoc, type ContactCurrencyBalance } from '../lib/currency';
import { foreignBreakdown, foreignContacts, compareColumns, statementVerdict, describeForeign } from '../lib/foreign';
import { expectedJNLines, findJNRows, type StmtRow } from '../lib/jn-locate';
import * as XLSX from 'xlsx';
import * as nodeOs from 'os';
import * as nodePath from 'path';

let failures = 0;
function check(label: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  -> ' + extra : ''}`);
  if (!ok) failures += 1;
}
const inr = (n: number) => Math.round(n).toLocaleString('en-IN');
const near = (a: number, b: number) => Math.abs(a - b) <= 0.5;

function emptyRaw(fetchedAt: string): RawZohoData {
  return {
    fetchedAt, activeCustomers: [], activeVendors: [], invoices: [], customerPayments: [], creditNotes: [],
    bills: [], vendorPayments: [], vendorCredits: [], journals: [], jnClean: [],
  };
}
const jline = (contact: string, side: 'debit' | 'credit', amount: number, account?: string) => ({ contact_id: contact, account_id: account, debit_or_credit: side, amount });
const jrnl = (id: string, date: string, entry: string, lines: ReturnType<typeof jline>[]) => ({ journal_id: id, journal_date: date, entry_number: entry, line_items: lines });

// =====================================================================
// PART A - real contacts rebuilt from their official Statements
// =====================================================================
console.log('--- Part A: official Statements ---');

// ---- A1. Wonder Cement (Phase 2), Statement balance 31 Aug 2026 = 4,64,98,061
{
  const W = 'W1';
  const raw = emptyRaw('2026-08-31T10:00:00Z');
  const ordinary = [['2026-05-26', 5000], ['2026-06-02', 1240000], ['2026-06-08', 140], ['2026-06-08', 2100], ['2026-06-08', 75], ['2026-06-08', 140], ['2026-06-08', 140000], ['2026-06-09', 83000], ['2026-07-13', 5000]] as const;
  raw.journals = ordinary.map(([d, a], i) => jrnl('OJ' + i, d, 'SJ-' + i, [jline(W, 'debit', a)]));
  raw.activeCustomers = [{
    contact_id: W, contact_name: 'Wonder Cement Limited ( Phase 2)', contact_type: 'customer', status: 'active',
    outstanding_receivable_amount: 7641216 + 1475455 + 120817868, // open invoice + ordinary journals + JN-Clean debit leg
    unused_credits_receivable_amount: 83436478, // JN-Clean credit leg left unspent
  }];
  raw.invoices = [{ invoice_id: 'INV627', customer_id: W, date: '2026-03-14', due_date: '2026-03-29', total: 81400176, balance: 7641216, status: 'overdue' }];
  const jn: JNCleanEntry = {
    journal_id: 'JN1', entry_number: 'JN-Clean-1', journal_date: '2026-03-31',
    lines: [{ contact_id: W, debit_or_credit: 'credit', amount: 120817868 }, { contact_id: W, debit_or_credit: 'debit', amount: 120817868 }],
    applications: [{ kind: 'invoice', doc_id: 'INV627', amount: 37381390, date: '2026-03-31' }],
  };
  raw.jnClean = [jn];

  const ledger = ledgerFromContacts(raw);
  const full = computeARDetail(raw, '2026-08-31', { ledger })[0];
  check('Wonder: total (sum of invoice 627 with JN spend added back + journals) = Statement Balance Due Rs 4,64,98,061', near(full.netTotal, 46498061), inr(full.netTotal));
  check('Wonder: Zoho ledger agrees, so nothing is flagged', near(full.ledgerTotal ?? NaN, 46498061) && full.gap === 0, `ledger ${inr(full.ledgerTotal ?? NaN)}, gap ${full.gap}`);
  check('Wonder: invoice 627 aged on Rs 4,50,22,606, not the Rs 76,41,216 Zoho shows', near(full.less180, 45022606 + 1475455) && full.more180 === 0, `<180 ${inr(full.less180)}`);

  const noApps = computeARDetail({ ...raw, jnClean: [{ ...jn, applications: [] }] }, '2026-08-31', { ledger })[0];
  check('Wonder: if JN-Clean spend cannot be read, the documents fall short by Rs 3,73,81,390 and it is FLAGGED against the ledger', near(noApps.netTotal, 9116671) && near(noApps.ledgerTotal ?? NaN, 46498061) && near(noApps.gap, 37381390), `documents ${inr(noApps.netTotal)}, ledger ${inr(noApps.ledgerTotal ?? NaN)}, gap ${inr(noApps.gap)}`);

  const jnIdx = buildJNIndex([jn], '2026-08-31');
  check('Wonder: JN-Clean pair cancels (net 0)', jnIdx.netDrMinusCr.get(W) === 0);
  check('Wonder: no JN-Clean effect before 31 Mar', buildJNIndex([jn], '2026-03-30').netDrMinusCr.size === 0);
}

// ---- A1b. Wonder today (5 Oct): invoice 627 fully settled in the Zoho view, JN spend must age as >180 days
{
  const W = 'W1';
  const raw = emptyRaw('2026-10-05T08:21:00Z');
  const open = [['I496', 960458], ['I497', 31307760], ['I500', 1469395], ['I501', 1469395], ['I502', 1469395]] as const;
  raw.invoices = [
    { invoice_id: 'INV627', customer_id: W, date: '2026-03-14', due_date: '2026-03-29', total: 81400176, balance: 0, status: 'paid' },
    ...open.map(([id, bal]) => ({ invoice_id: id, customer_id: W, date: '2026-09-25', due_date: '2026-10-10', total: bal, balance: bal, status: 'sent' })),
  ];
  raw.journals = [jrnl('OJ', '2026-06-02', 'SJ-1', [jline(W, 'debit', 1475455)])];
  raw.activeCustomers = [{ contact_id: W, contact_name: 'Wonder Cement Limited ( Phase 2)', contact_type: 'customer', status: 'active', outstanding_receivable_amount: 158969726, unused_credits_receivable_amount: 83436478 }];
  raw.jnClean = [{ journal_id: 'JN1', entry_number: 'JN-Clean-1', journal_date: '2026-03-31', lines: [jline(W, 'credit', 120817868), jline(W, 'debit', 120817868)], applications: [{ kind: 'invoice', doc_id: 'INV627', amount: 37381390 }] }];
  const r = computeARDetail(raw, '2026-10-05', { ledger: ledgerFromContacts(raw) })[0];
  check('Wonder today: total Rs 7,55,33,248, equal to Zoho ledger', near(r.netTotal, 75533248) && near(r.ledgerTotal ?? NaN, 75533248), inr(r.netTotal));
  check('Wonder today: Rs 3,73,81,390 lands in ">180 days" (invoice 627 is 190 days past due)', near(r.more180, 37381390) && near(r.less180, 38151858) && r.gap === 0, `<180 ${inr(r.less180)}  >180 ${inr(r.more180)}`);
}

// ---- A2. Abhishek Enterprises, Statement balance 31 Aug 2026 = 3,04,30,156
{
  const A = 'A1';
  const raw = emptyRaw('2026-08-31T10:00:00Z');
  raw.activeVendors = [{ contact_id: A, contact_name: 'Abhishek Enterprises', contact_type: 'vendor', status: 'active', outstanding_payable_amount: 24115356 + 2450000 + 3864800, unused_credits_payable_amount: 0 }];
  const open = [['B30', 953268], ['B31', 599200], ['B33', 13024481], ['B35', 5112000], ['B41', 4426407]] as const;
  const spent = [['B053', 666000], ['B054', 748800], ['B07', 593550], ['B08', 465450], ['B09', 770400], ['B10', 620600]] as const;
  raw.bills = [
    ...open.map(([id, bal]) => ({ bill_id: id, vendor_id: A, date: '2026-07-20', due_date: '2026-08-20', total: bal, balance: bal, status: 'open' })),
    ...spent.map(([id, a]) => ({ bill_id: id, vendor_id: A, date: '2026-04-01', due_date: '2026-04-15', total: a, balance: 0, status: 'paid' })),
  ];
  raw.journals = [jrnl('OJ', '2026-02-19', 'SJ-1', [jline(A, 'credit', 2450000)])];
  raw.jnClean = [{ journal_id: 'JN301', entry_number: 'JN-Clean-301', journal_date: '2026-03-31', lines: [jline(A, 'debit', 3864800), jline(A, 'credit', 3864800)], applications: spent.map(([id, amount]) => ({ kind: 'bill' as const, doc_id: id, amount })) }];
  const ledger = ledgerFromContacts(raw);
  const r = computeAPDetail(raw, '2026-08-31', { ledger })[0];
  check('Abhishek: total (bills + journal + JN-Clean spend) = Statement Balance Due Rs 3,04,30,156', near(r.netTotal, 30430156), inr(r.netTotal));
  check('Abhishek: Zoho ledger agrees, nothing flagged', near(r.ledgerTotal ?? NaN, 30430156) && r.gap === 0);
  const noApps = computeAPDetail({ ...raw, jnClean: [{ ...raw.jnClean![0], applications: [] }] }, '2026-08-31', { ledger })[0];
  check('Abhishek: without applications the documents fall short and Rs 38,64,800 is flagged', near(noApps.netTotal, 26565356) && near(noApps.gap, 3864800), inr(noApps.gap));
}

// ---- A3. Indian Customs, Statement balance = -50,766 (a draft bill must not count; no JN-Clean)
{
  const V = 'V1';
  const raw = emptyRaw('2026-08-31T10:00:00Z');
  raw.activeVendors = [{ contact_id: V, contact_name: 'Indian Customs EDI Gateway', contact_type: 'vendor', status: 'active', outstanding_payable_amount: 104118265, unused_credits_payable_amount: 104169031 }];
  raw.bills = [{ bill_id: 'DRAFT', vendor_id: V, date: '2026-06-19', due_date: '2026-06-19', total: 83695404, balance: 83695404, status: 'draft' }];
  raw.vendorPayments = [['P1', 6835757], ['P2', 35517772], ['P3', 61815502]].map(([id, a]) => ({ payment_id: String(id), vendor_id: V, date: '2026-03-09', amount: Number(a), unused_amount: Number(a), status: 'paid' }));
  raw.journals = [[6832949, '2026-03-31'], [35372406, '2026-03-31'], [148174, '2026-03-31'], [61764736, '2026-05-30']].map(([a, d], i) => jrnl('J' + i, String(d), 'SJ-' + i, [jline(V, 'credit', Number(a))]));
  const r = computeAPDetail(raw, '2026-08-31', { ledger: ledgerFromContacts(raw) })[0];
  check('Indian Customs: total = Statement Balance Due -Rs 50,766', near(r.netTotal, -50766), inr(r.netTotal));
  check('Indian Customs: documents agree with the ledger (draft bill ignored, excess payments offset the journals)', r.gap === 0 && near(r.ledgerTotal ?? NaN, -50766));
  check('Indian Customs: not listed as a creditor (balance is a small credit)', !computeAPSummary(raw, '2026-08-31', { ledger: ledgerFromContacts(raw) }).vendors.some((v) => v.vendorId === V));
}

// ---- A4. Legacy customer carried in as an OPENING BALANCE (RE0047 Shreya Petrochem, Rs 2,20,98,612)
{
  const S = 'S1';
  const raw = emptyRaw('2026-10-05T08:00:00Z');
  raw.ledgerAccounts = { receivable: ['AR1'], payable: ['AP1'] };
  raw.activeCustomers = [{ contact_id: S, contact_name: 'RE0047 Shreya Petrochem', contact_type: 'customer', status: 'active', outstanding_receivable_amount: 44197224, unused_credits_receivable_amount: 22098612 }];
  raw.jnClean = [{ journal_id: 'JNS', entry_number: 'JN-Clean-9', journal_date: '2026-03-31', lines: [jline(S, 'credit', 22098612, 'AR1'), jline(S, 'debit', 22098612, 'AR1')], applications: [] }];
  const l = ledgerFromContacts(raw);
  const noOB = computeARDetail(raw, '2026-10-05', { ledger: l })[0];
  check('Shreya, opening balance not known: documents 0 vs Zoho Rs 2,20,98,612 -> flagged', noOB.netTotal === 0 && near(noOB.gap, 22098612), inr(noOB.gap));
  raw.openingBalances = { [S]: { receivable: 22098612, payable: 0, docId: 'OB1', checkedAt: 'x' } };
  const withOB = computeARDetail(raw, '2026-10-05', { ledger: l })[0];
  check('Shreya with her opening balance: total Rs 2,20,98,612, reconciled, aged >180 days', near(withOB.netTotal, 22098612) && withOB.gap === 0 && near(withOB.more180, 22098612), `${inr(withOB.netTotal)} >180 ${inr(withOB.more180)}`);
  raw.jnClean = [{ ...raw.jnClean[0], applications: [{ kind: 'invoice', doc_id: 'OB1', amount: 1000 }] }];
  raw.openingBalances = { [S]: { receivable: 22097612, payable: 0, docId: 'OB1', checkedAt: 'x' } };
  const spent = computeARDetail(raw, '2026-10-05', { ledger: l })[0];
  check('JN-Clean spend on an opening-balance invoice is added back too (22,097,612 + 1,000)', near(spent.netTotal, 22098612), inr(spent.netTotal));
}

// ---- A5. Abhilasha Goswami: JN-Clean-210 credits a LOAN account and debits Sundry Creditors; only the debit reaches her ledger
{
  const G = 'G1';
  const raw = emptyRaw('2026-10-05T08:00:00Z');
  raw.ledgerAccounts = { receivable: ['AR1'], payable: ['AP1'] };
  raw.activeVendors = [{ contact_id: G, contact_name: 'Abhilasha Goswami', contact_type: 'vendor', status: 'active', outstanding_payable_amount: 0, unused_credits_payable_amount: 12500000 }];
  raw.jnClean = [{ journal_id: 'JNG', entry_number: 'JN-Clean-210', journal_date: '2026-03-31', lines: [jline(G, 'credit', 12500000, 'LOAN1'), jline(G, 'debit', 12500000, 'AP1')], applications: [] }];
  const l = ledgerFromContacts(raw);
  const typed = computeAPDetail(raw, '2026-10-05', { ledger: l })[0];
  check('Abhilasha (default rule): her JN-Clean debit is the only trace of the Rs 1,25,00,000 and does not cancel, so it is KEPT: dashboard = Statement = -1,25,00,000, not flagged', near(typed.netTotal, -12500000) && near(typed.ledgerTotal ?? NaN, -12500000) && typed.gap === 0, `docs ${inr(typed.netTotal)} / ledger ${inr(typed.ledgerTotal ?? NaN)}`);
  process.env.JN_CLEAN_RULE = 'literal';
  const typedLit = computeAPDetail(raw, '2026-10-05', { ledger: l })[0];
  check('Abhilasha (JN_CLEAN_RULE=literal): with account types, excluding JN-Clean rows gives Rs 0, matching the documents (not flagged)', near(typedLit.ledgerTotal ?? NaN, 0) && typedLit.gap === 0, `ledger ${inr(typedLit.ledgerTotal ?? NaN)}`);
  delete process.env.JN_CLEAN_RULE;
  const untyped = computeAPDetail({ ...raw, ledgerAccounts: undefined }, '2026-10-05', { ledger: l })[0];
  check('Abhilasha: without account types she was flagged for -Rs 1,25,00,000 (the old behaviour)', near(untyped.gap, -12500000), inr(untyped.gap));
  const empty = computeAPDetail({ ...raw, ledgerAccounts: { receivable: [], payable: [] } }, '2026-10-05', { ledger: l })[0];
  check('an EMPTY chart of accounts is treated as "unknown", never as "no line reaches a ledger"', near(empty.gap, -12500000));
}

// ---- A6. ordinary journal lines tagged to a contact but on a non-ledger account are not counted
{
  const raw = emptyRaw('2026-10-05T08:00:00Z');
  raw.ledgerAccounts = { receivable: ['AR1'], payable: ['AP1'] };
  raw.activeVendors = [{ contact_id: 'G2', contact_name: 'Tagged on a loan account', contact_type: 'vendor', status: 'active', outstanding_payable_amount: 1000, unused_credits_payable_amount: 0 }];
  raw.journals = [jrnl('J', '2026-09-01', 'SJ-1', [jline('G2', 'credit', 1000, 'AP1'), jline('G2', 'debit', 1000, 'LOAN1')])];
  const l = ledgerFromContacts(raw);
  const typed = computeAPDetail(raw, '2026-10-05', { ledger: l })[0];
  const untyped = computeAPDetail({ ...raw, ledgerAccounts: undefined }, '2026-10-05', { ledger: l })[0];
  check('journal line on a non-Payable account is ignored: total Rs 1,000, matches Zoho', near(typed.netTotal, 1000) && typed.gap === 0);
  check('...whereas counting every tagged line (old way) gave Rs 0 and a flag', near(untyped.netTotal, 0) && near(untyped.gap, 1000));
}

// ---- A7. Abhishek today: bills awaiting approval are not in Zoho's ledger (Rs 1,09,46,636.80 of them)
{
  const A = 'A7';
  const raw = emptyRaw('2026-10-06T10:00:00Z');
  const open = [['Bo1', 9671913.5, 'overdue'], ['Bo2', 4958800, 'open'], ['Bo3', 1184396, 'partially_paid']] as const;
  const pending = [2321233.8, 1560355, 3471048, 1605000, 1989000];
  raw.activeVendors = [{ contact_id: A, contact_name: 'Abhishek Enterprises', contact_type: 'vendor', status: 'active', outstanding_payable_amount: 22129909.5, unused_credits_payable_amount: 0 }];
  raw.bills = [
    ...open.map(([id, bal, st]) => ({ bill_id: id, vendor_id: A, date: '2026-09-01', due_date: '2026-09-16', total: bal, balance: bal, status: st })),
    ...pending.map((bal, i) => ({ bill_id: 'P' + i, vendor_id: A, date: '2026-09-10', due_date: '2026-10-09', total: bal, balance: bal, status: 'pending_approval' })),
    { bill_id: 'R1', vendor_id: A, date: '2026-05-01', due_date: '2026-05-31', total: 246402, balance: 225342, status: 'rejected' },
  ];
  raw.journals = [jrnl('J409', '2026-02-19', 'SJ-409', [jline(A, 'credit', 2450000)])];
  raw.jnClean = [{ journal_id: 'JN301', entry_number: 'JN-Clean-301', journal_date: '2026-03-31', lines: [jline(A, 'debit', 3864800), jline(A, 'credit', 3864800)], applications: [{ kind: 'bill', doc_id: 'S1', amount: 3864800 }] }];
  raw.bills.push({ bill_id: 'S1', vendor_id: A, date: '2026-03-13', due_date: '2026-04-12', total: 3864800, balance: 0, status: 'paid' });
  const r = computeAPDetail(raw, '2026-10-06', { ledger: ledgerFromContacts(raw) })[0];
  check('Abhishek today: bills awaiting approval and the rejected bill are left out; total Rs 2,21,29,909.50 = Zoho', near(r.netTotal, 22129909.5) && r.gap === 0, `${inr(r.netTotal)}, gap ${r.gap}`);
  check('status filter: "pending_approval", "Pending Approval" and "submitted" are all excluded', isExcludedStatus('pending_approval') && isExcludedStatus('Pending Approval') && isExcludedStatus('submitted') && !isExcludedStatus('partially_paid') && !isExcludedStatus('overdue'));
}

// ---- A7b. POWERGRID SIWANI: an invoice that is APPROVED but not yet SENT is not in Zoho's ledger (17 Oct 2026)
{
  const P = 'PG1';
  const mk = (status: string) => {
    const raw = emptyRaw('2026-10-17T01:50:00Z');
    raw.activeCustomers = [{ contact_id: P, contact_name: 'POWERGRID SIWANI TRANSMISSION LIMITED', contact_type: 'customer', status: 'active', outstanding_receivable_amount: status === 'sent' ? 288770 : 0, unused_credits_receivable_amount: 0 }];
    raw.invoices = [{ invoice_id: 'RPE577', customer_id: P, date: '2026-10-14', due_date: '2026-10-29', total: 288770, balance: 288770, status }];
    return raw;
  };
  const approved = mk('approved');
  const r = computeARDetail(approved, '2026-10-17', { ledger: ledgerFromContacts(approved) })[0];
  check('Powergrid Siwani: invoice approved but not sent is left out, so documents (0) = Zoho ledger (0) and nothing is flagged', r.netTotal === 0 && r.ledgerTotal === 0 && r.gap === 0, `documents ${inr(r.netTotal)}, ledger ${inr(r.ledgerTotal ?? NaN)}, gap ${r.gap}`);
  check('Powergrid Siwani: it is not listed and the "to review" count is 0', computeARSummary(approved, '2026-10-17', { ledger: ledgerFromContacts(approved) }).unreconciledCount === 0 && computeARSummary(approved, '2026-10-17', { ledger: ledgerFromContacts(approved) }).customers.length === 0);
  const sent = mk('sent');
  const s2 = computeARDetail(sent, '2026-10-17', { ledger: ledgerFromContacts(sent) })[0];
  check('Powergrid Siwani: once the same invoice is marked Sent, Zoho posts it and the dashboard counts Rs 2,88,770 with no flag', near(s2.netTotal, 288770) && near(s2.ledgerTotal ?? NaN, 288770) && s2.gap === 0, `documents ${inr(s2.netTotal)}, ledger ${inr(s2.ledgerTotal ?? NaN)}, gap ${s2.gap}`);
  check('status filter: "approved" and "Approved" are excluded; "sent", "open", "overdue" are not', isExcludedStatus('approved') && isExcludedStatus('Approved') && !isExcludedStatus('sent') && !isExcludedStatus('open') && !isExcludedStatus('overdue'));
}

// ---- A8. Sangam Solar One: a Rs 10.15 cr debit journal, Rs 1.02 cr of it already applied to bills, plus a Rs 60 lakh advance
{
  const raw = emptyRaw('2026-10-06T10:00:00Z');
  raw.ledgerAccounts = { receivable: ['AR1'], payable: ['AP1'] };
  raw.activeVendors = [{ contact_id: 'SG', contact_name: 'SANGAM SOLAR ONE', contact_type: 'vendor', status: 'active', outstanding_payable_amount: 0, unused_credits_payable_amount: 97292190 }];
  raw.journals = [{ ...jrnl('J1237', '2026-09-03', 'SJ-1237', [jline('SG', 'debit', 101478676, 'AP1')]), available_payables_credits: 91292190 }];
  raw.vendorPayments = [{ payment_id: 'P', vendor_id: 'SG', date: '2026-10-01', amount: 6000000, unused_amount: 6000000, status: 'paid' }];
  const r = computeAPDetail(raw, '2026-10-06', { ledger: ledgerFromContacts(raw) })[0];
  check('Sangam: only the UNUSED part of the debit journal counts (Rs 9,12,92,190) + the Rs 60 lakh advance = Zoho -Rs 9,72,92,190', near(r.netTotal, -97292190) && r.gap === 0, `${inr(r.netTotal)}, gap ${r.gap}`);
}

// ---- A9. Soltown Infra: two credit journals already applied to invoices must not be subtracted a second time (their sum was its whole gap)
{
  const S = 'SO';
  const raw = emptyRaw('2026-10-06T10:00:00Z');
  raw.ledgerAccounts = { receivable: ['AR1'], payable: ['AP1'] };
  raw.activeCustomers = [{ contact_id: S, contact_name: 'SOLTOWN INFRA', contact_type: 'customer', status: 'active', outstanding_receivable_amount: 56847890, unused_credits_receivable_amount: 458201 }];
  raw.invoices = [['IA', 21979753], ['IB', 13263729], ['IC', 21604408]].map(([id, a]) => ({ invoice_id: String(id), customer_id: S, date: '2026-02-01', due_date: '2026-03-01', total: Number(a), balance: 0, status: 'paid' }));
  raw.journals = [
    { ...jrnl('J1002', '2026-03-31', 'SJ-1002', [jline(S, 'credit', 1613119, 'AR1')]), available_receivables_credits: 0 },
    { ...jrnl('J314', '2025-12-18', 'SJ-314', [jline(S, 'credit', 1064773, 'AR1')]), available_receivables_credits: 0 },
  ];
  raw.customerPayments = [{ payment_id: 'PP', customer_id: S, date: '2026-09-30', amount: 10000000, unused_amount: 458201, status: 'paid' }];
  raw.jnClean = [{ journal_id: 'JNS', entry_number: 'JN-Clean-1', journal_date: '2026-03-31', lines: [jline(S, 'credit', 56847890, 'AR1'), jline(S, 'debit', 56847890, 'AR1')], applications: [{ kind: 'invoice', doc_id: 'IA', amount: 21979753 }, { kind: 'invoice', doc_id: 'IB', amount: 13263729 }, { kind: 'invoice', doc_id: 'IC', amount: 21604408 }] }];
  const r = computeARDetail(raw, '2026-10-06', { ledger: ledgerFromContacts(raw) })[0];
  check('Soltown: credit journals already applied to invoices are not subtracted again; total Rs 5,63,89,689 = Zoho', near(r.netTotal, 56389689) && r.gap === 0, `${inr(r.netTotal)}, gap ${r.gap}`);
}

// ---- A10. one journal crediting two vendors: the unused part is shared in proportion
{
  const raw = emptyRaw('2026-10-06T10:00:00Z');
  raw.ledgerAccounts = { receivable: ['AR1'], payable: ['AP1'] };
  raw.activeVendors = ['X', 'Y'].map((id) => ({ contact_id: id, contact_name: 'Vendor ' + id, contact_type: 'vendor' as const, status: 'active' }));
  raw.journals = [{ ...jrnl('JJ', '2026-09-03', 'SJ-5', [jline('X', 'debit', 100, 'AP1'), jline('Y', 'debit', 50, 'AP1')]), available_payables_credits: 90 }];
  const rows = computeAPDetail(raw, '2026-10-06', { ledger: null });
  check('journal spread over two vendors: Rs 90 unused shared 60 / 30', near(rows[0].unappliedCredits, 60) && near(rows[1].unappliedCredits, 30), `${rows[0].unappliedCredits} / ${rows[1].unappliedCredits}`);
}

// ---- A11-A15. EXACT age buckets for a past date: Zoho's aging report for that day + what it cannot see
{
  const ag = (rows: [string, number, Record<string, number>][], includesOpening = false): AgingRecord => ({
    asOf: '2026-08-31', includesOpening, rows: new Map(rows.map(([id, current, intervals]) => [id, { current, intervals, total: current + Object.values(intervals).reduce((a, b) => a + b, 0) }])),
  });
  const snap = (m: [string, number][]) => ({ asOf: '2026-08-31', source: 'report-snapshot' as const, customers: new Map(m), vendors: new Map<string, number>() });

  // Wonder Cement (Phase 2) on 31 Aug: Zoho's aging shows only the Rs 76,41,216 left on invoice 627;
  // JN-Clean's Rs 3,73,81,390 spend (31 Mar) and the Rs 14,75,455 journal debit are added back by age
  const W = 'W1';
  const raw = emptyRaw('2026-10-07T10:00:00Z');
  raw.activeCustomers = [{ contact_id: W, contact_name: 'Wonder Cement Limited ( Phase 2)', contact_type: 'customer', status: 'active' }];
  raw.invoices = [{ invoice_id: 'INV627', customer_id: W, date: '2026-03-14', due_date: '2026-03-29', total: 81400176, balance: 0, status: 'paid' }];
  raw.journals = [jrnl('J1', '2026-06-02', 'SJ-1', [jline(W, 'debit', 1475455)])];
  raw.jnClean = [{ journal_id: 'JN1', entry_number: 'JN-Clean-1', journal_date: '2026-03-31', lines: [jline(W, 'credit', 120817868), jline(W, 'debit', 120817868)], applications: [{ kind: 'invoice', doc_id: 'INV627', amount: 37381390, date: '2026-03-31' }] }];
  const w = computeARDetail(raw, '2026-08-31', { ledger: snap([[W, 46498061]]), historical: true, aging: ag([[W, 0, { 'days_151-180': 7641216 }]]) })[0];
  check('exact buckets, Wonder on 31 Aug: Rs 4,64,98,061 all within 180 days (invoice 627 was 156 days past due), nothing unexplained', near(w.netTotal, 46498061) && near(w.less180, 46498061) && w.more180 === 0 && w.gap === 0 && w.unappliedCredits === 0, `<180 ${inr(w.less180)} >180 ${inr(w.more180)} gap ${w.gap}`);
  const early = computeARDetail(raw, '2026-03-30', { ledger: snap([[W, 7641216]]), historical: true, aging: ag([[W, 0, { 'days_above-180': 0, 'days_1-30': 7641216 }]]) })[0];
  check('JN-Clean spend dated after the day is NOT added back (30 Mar, before the 31 Mar transfer)', near(early.agedTotal, 7641216), inr(early.agedTotal));

  // aging overshoots the ledger -> the surplus is credits; falls short -> flagged
  const cr = computeARDetail({ ...emptyRaw('x'), activeCustomers: [{ contact_id: 'X', contact_name: 'X', contact_type: 'customer', status: 'active' }] }, '2026-08-31', { ledger: snap([['X', 70]]), historical: true, aging: ag([['X', 100, {}]]) })[0];
  check('buckets exceed the ledger by Rs 30: shown as Rs 30 of credits, net = ledger, not flagged', cr.unappliedCredits === 30 && cr.netTotal === 70 && cr.gap === 0);
  const sh = computeARDetail({ ...emptyRaw('x'), activeCustomers: [{ contact_id: 'X', contact_name: 'X', contact_type: 'customer', status: 'active' }] }, '2026-08-31', { ledger: snap([['X', 150]]), historical: true, aging: ag([['X', 100, {}]]) })[0];
  check('buckets fall Rs 50 short of the ledger: flagged with gap Rs 50', sh.gap === 50 && sh.netTotal === 150);

  // opening balance (Shreya, Rs 2,20,98,612): added as old if the report lacks it, left alone if the report has it
  const S = 'S1';
  const raw2 = emptyRaw('2026-10-07T10:00:00Z');
  raw2.activeCustomers = [{ contact_id: S, contact_name: 'Shreya', contact_type: 'customer', status: 'active' }];
  raw2.openingBalances = { [S]: { receivable: 22098612, payable: 0, docId: 'OB1', checkedAt: 'x' } };
  const notIn = ag([], false);
  const a1 = computeARDetail(raw2, '2026-08-31', { ledger: snap([[S, 22098612]]), historical: true, aging: notIn })[0];
  check('opening balance not in the report: added as >180, nothing unexplained', near(a1.more180, 22098612) && a1.gap === 0);
  const inRep = ag([[S, 0, { 'days_above-180': 22098612 }]], true);
  const a2 = computeARDetail(raw2, '2026-08-31', { ledger: snap([[S, 22098612]]), historical: true, aging: inRep })[0];
  check('opening balance already in the report: not added twice', near(a2.more180, 22098612) && a2.unappliedCredits === 0 && a2.gap === 0);
  const pick1 = chooseAgingOpeningBasis(raw2, '2026-08-31', snap([[S, 22098612]]), new Map());
  const pick2 = chooseAgingOpeningBasis(raw2, '2026-08-31', snap([[S, 22098612]]), inRep.rows);
  check('self-check decides from the data whether the report holds opening balances (both cases)', pick1.includesOpening === false && pick2.includesOpening === true, `${pick1.includesOpening} / ${pick2.includesOpening}`);
}

// the report exactly as Zoho returned it (customers sit two groups deep; "sent" is the not-yet-due column)
{
  const body = { code: 0, message: 'success', invoice: { total: 100, intervals: [], group_list: [{ total: 100, intervals: [], name: 'none', group_list: [
    { total: 9245749, intervals: [{ amount: 0, interval: 'days_1-30' }, { amount: 4543000, interval: 'days_31-60' }, { amount: 1457749, interval: 'days_91-120' }, { amount: 3245000, interval: 'days_above-180' }], overdue: 9245749, account_name: 'Sundry Debtors Project', name: 'ALLIANCE POLYSACKS', id: '2346113000024197144', sent: 0, entity: 'contact' },
    { total: 6914502, intervals: [{ amount: 6914502, interval: 'days_91-120' }], overdue: 6914502, account_name: 'Trade Receivables-Domestic', name: 'Aman Hospitality', id: '2346113000006903334', sent: 0, entity: 'contact' },
    { total: 500, intervals: [{ amount: 0, interval: 'days_1-30' }], overdue: 0, account_name: 'Accounts Receivable', name: 'Not yet due customer', id: '9', sent: 500, entity: 'contact' },
  ] }] }, page_context: { has_more_page: false } };
  const rows = parseAgingRows(body);
  const al = rows.get('2346113000024197144')!;
  check('aging report in its real shape is read: 3 customers; Alliance <=180 Rs 55,43,000+14,57,749, >180 Rs 32,45,000; not-yet-due counts as <=180', rows.size === 3 && splitRow(al).more === 3245000 && splitRow(al).less === 4543000 + 1457749 && splitRow(rows.get('9')!).less === 500);
}

// ---- A16/A17. TDS withheld on advance payments: the Statement counts the gross, the payment's own balance only the net
{
  const raw = emptyRaw('2026-10-07T10:00:00Z');
  // ITCOT: advance of Rs 94,500 paid + Rs 10,500 TDS = Rs 1,05,000; Statement and report say -1,05,000, the contact record -94,500
  raw.activeVendors = [{ contact_id: 'IT', contact_name: 'ITCOT Limited,', contact_type: 'vendor', status: 'active', outstanding_payable_amount: 0, unused_credits_payable_amount: 94500 }];
  raw.vendorPayments = [{ payment_id: 'PIT', vendor_id: 'IT', date: '2025-10-10', amount: 94500, unused_amount: 94500, status: 'paid' }];
  raw.vendorLedgerToday = { IT: -105000 };
  const l = ledgerFromContacts(raw);
  check("vendors' ledger for today is Zoho's vendor balance report (it counts the TDS), not the contact record", near(l.vendors.get('IT') ?? NaN, -105000), inr(l.vendors.get('IT') ?? NaN));
  const without = computeAPDetail(raw, '2026-10-07', { ledger: l })[0];
  check('ITCOT without the TDS lookup: documents -94,500 vs Statement -1,05,000, flagged', near(without.netTotal, -94500) && near(without.gap, -10500), `${inr(without.netTotal)} gap ${inr(without.gap)}`);
  raw.vendorPaymentTds = { PIT: 10500 };
  const withTds = computeAPDetail(raw, '2026-10-07', { ledger: l })[0];
  check('ITCOT with the TDS counted: -Rs 1,05,000 = the Statement, no gap', near(withTds.netTotal, -105000) && withTds.gap === 0, inr(withTds.netTotal));

  // Lal Singh: Statement Rs 0. His contact record says Rs 93,298 payable because it leaves out the TDS on his advance.
  const L = 'LS';
  const raw2 = emptyRaw('2026-10-07T10:00:00Z');
  raw2.activeVendors = [{ contact_id: L, contact_name: 'Lal Singh S/o Ajit Singh', contact_type: 'vendor', status: 'active', outstanding_payable_amount: 933000, unused_credits_payable_amount: 839702 }];
  raw2.bills = [{ bill_id: 'LB', vendor_id: L, date: '2026-03-01', due_date: '2026-03-15', total: 933000, balance: 0, status: 'paid' }];
  raw2.jnClean = [{ journal_id: 'JNL', entry_number: 'JN-Clean-9', journal_date: '2026-03-31', lines: [jline(L, 'credit', 933000), jline(L, 'debit', 933000)], applications: [{ kind: 'bill', doc_id: 'LB', amount: 933000 }] }];
  raw2.vendorPayments = [{ payment_id: 'PL', vendor_id: L, date: '2026-04-10', amount: 839702, unused_amount: 839702, status: 'paid' }];
  raw2.vendorLedgerToday = { [L]: 0 };
  const l2 = ledgerFromContacts(raw2);
  const a = computeAPDetail(raw2, '2026-10-07', { ledger: l2 })[0];
  check('Lal Singh without the TDS: documents Rs 93,298 payable vs Statement Rs 0 (the real discrepancy)', near(a.netTotal, 93298) && near(a.gap, -93298), `${inr(a.netTotal)} gap ${inr(a.gap)}`);
  raw2.vendorPaymentTds = { PL: 93298 };
  const b = computeAPDetail(raw2, '2026-10-07', { ledger: l2 })[0];
  check('Lal Singh with the TDS counted (8,39,702 + 93,298 = 9,33,000): Rs 0 = the Statement, no gap', near(b.netTotal, 0) && b.gap === 0, `${inr(b.netTotal)} gap ${b.gap}`);
}

// ---- A18. Xiamen Ampace: a journal posted in USD must count at its RUPEE value, not at its face amount
{
  const X = 'XM';
  const raw = emptyRaw('2026-10-08T10:00:00Z');
  // Zoho: ledger Rs 0.00. Journal 296 owes Xiamen USD 1,398.47 @ 93.48465 = Rs 1,30,735.48; advance paid Rs 1,26,302.89; SJ-1289 debits Rs 4,432.59
  raw.activeVendors = [{ contact_id: X, contact_name: 'Xiamen Ampace Technology Limited', contact_type: 'vendor', status: 'active', outstanding_payable_amount: 126302.89, unused_credits_payable_amount: 126302.89 }];
  raw.vendorPayments = [{ payment_id: 'PX', vendor_id: X, date: '2026-08-01', amount: 126302.89, unused_amount: 126302.89, status: 'paid' }];
  raw.vendorLedgerToday = { [X]: 0 };
  const sj = { ...jrnl('SJ1289', '2026-09-20', 'SJ-1289', [jline(X, 'debit', 4432.59)]), available_payables_credits: 4432.59 };
  const asFace = { ...jrnl('J296', '2026-09-14', '296', [jline(X, 'credit', 1398.47)]) };
  const asRupees = { ...jrnl('J296', '2026-09-14', '296', [jline(X, 'credit', 130735.48)]), currency_code: 'USD', exchange_rate: 93.48465 };
  const l = ledgerFromContacts(raw);
  raw.journals = [asFace, sj];
  const bug = computeAPDetail(raw, '2026-10-08', { ledger: l })[0];
  check('Xiamen as it was: the USD journal counted at its face amount (1,398.47) leaves a false credit of Rs 1,29,337 and a flag', near(bug.netTotal, -129337.01) && bug.gap !== 0, `${inr(bug.netTotal)} gap ${inr(bug.gap)}`);
  raw.journals = [asRupees, sj];
  const fixed = computeAPDetail(raw, '2026-10-08', { ledger: l })[0];
  check('Xiamen with the journal at its rupee value (1,30,735.48 - 4,432.59 - 1,26,302.89): Rs 0.00 = the Statement, no gap', Math.abs(fixed.netTotal) < 0.01 && fixed.gap === 0, `${fixed.netTotal.toFixed(2)} gap ${fixed.gap}`);
  check('foreign-journal detection from the list row: totals differ -> foreign; equal -> not', isForeignJournal({ total: 1398.47, bcy_total: 130735.48 }) && !isForeignJournal({ total: 500, bcy_total: 500 }) && !isForeignJournal({ total: 500 }));
  check('line in rupees: Zoho\'s bcy_amount wins; otherwise face x rate; otherwise face', journalLineInBase({ amount: 1398.47, bcy_amount: 130735.48 }) === 130735.48 && journalLineInBase({ amount: 1398.47 }, 93.48465) === 130735.48 && journalLineInBase({ amount: 100 }) === 100);
  const jn = extractJNEntry({ journal_id: 'JX', entry_number: 'JN-Clean-X', journal_date: '2026-03-31', exchange_rate: 90, line_items: [
    { customer_id: 'C9', account_id: 'A', debit_or_credit: 'credit', amount: 100, bcy_amount: 9000 },
    { customer_id: 'C9', account_id: 'A', debit_or_credit: 'debit', amount: 100 },
  ] });
  check('JN-Clean lines in a foreign currency are read in rupees too (bcy_amount, else face x rate)', jn?.lines[0].amount === 9000 && jn?.lines[1].amount === 9000);
}

// ---- A19. Two-source audit of EVERY vendor: balance report vs contact record + TDS
{
  const raw = emptyRaw('2026-10-08T10:00:00Z');
  const v = (id: string, name: string, out: number, unused: number) => ({ contact_id: id, contact_name: name, contact_type: 'vendor' as const, status: 'active', outstanding_payable_amount: out, unused_credits_payable_amount: unused });
  raw.activeVendors = [v('IT', 'ITCOT Limited,', 0, 94500), v('PL', 'Plain Vendor', 200000, 0), v('BAD', 'Mismatch Vendor', 300000, 0), v('LS', 'Lal Singh', 933000, 839702), v('IG', 'Report Ignores TDS', 0, 50000), v('ZZ', 'Nothing Here', 0, 0)];
  raw.vendorPayments = [
    { payment_id: 'PIT', vendor_id: 'IT', date: '2026-01-01', amount: 94500, unused_amount: 94500, status: 'paid' },
    { payment_id: 'PLS', vendor_id: 'LS', date: '2026-01-01', amount: 839702, unused_amount: 839702, status: 'paid' },
    { payment_id: 'PIG', vendor_id: 'IG', date: '2026-01-01', amount: 50000, unused_amount: 50000, status: 'paid' },
  ];
  raw.vendorPaymentTds = { PIT: 10500, PLS: 93298, PIG: 5000 };
  raw.vendorLedgerToday = { IT: -105000, PL: 200000, BAD: 310000, LS: 0, IG: -50000 };
  const a = auditVendors(raw);
  check('audit: 5 vendors with a balance compared; 1 matches exactly, 2 match once TDS is taken off, 2 are NOT explained', a.vendorsCompared === 5 && a.reportEqualsContactRecord === 1 && a.reportEqualsContactRecordLessTds === 2 && a.unexplained === 2, JSON.stringify([a.vendorsCompared, a.reportEqualsContactRecord, a.reportEqualsContactRecordLessTds, a.unexplained]));
  const reasons = Object.fromEntries(a.unexplainedList.map((u) => [u.name, u.reason]));
  check('audit: names why - a report that ignores TDS the payment shows, and a plain difference with no TDS', /ignores TDS/.test(reasons['Report Ignores TDS'] ?? '') && /no TDS is involved/.test(reasons['Mismatch Vendor'] ?? ''));
  check('audit: every vendor carrying TDS is listed with its status (ITCOT ok, Lal Singh ok, the ignoring one MISMATCH)', a.vendorsWithTds === 3 && a.tdsVendors.find((t) => t.name === 'Lal Singh')?.status === 'ok' && a.tdsVendors.find((t) => t.name === 'Report Ignores TDS')?.status === 'MISMATCH');
  const noReport = auditVendors({ ...raw, vendorLedgerToday: undefined });
  check('audit: no vendor report read -> says so, compares nothing', noReport.reportAvailable === false && noReport.vendorsCompared === 0);
  // independence: the contact-record route never looks at the report
  const withReport = ledgerFromContacts(raw);
  const independent = ledgerFromContacts(raw, { contactRecordsOnly: true });
  check('ledger from contact records only: ignores the report (BAD = 3,00,000, not the report\'s 3,10,000) but still corrects for TDS (ITCOT -1,05,000)', independent.vendors.get('BAD') === 300000 && independent.vendors.get('IT') === -105000 && withReport.vendors.get('BAD') === 310000);
  check('ledger source is labelled honestly: report in use vs contact records only', withReport.source === 'contact-record + vendor-report' && independent.source === 'contact-record');
  check('a vendor missing from the report falls back to its contact record LESS TDS (not the TDS-blind figure)', ledgerFromContacts({ ...raw, vendorLedgerToday: { PL: 200000 } }).vendors.get('IT') === -105000);
}

// ---- A20. Harish Chauhan: an INACTIVE vendor whose balance lives only in a manual journal (entry 240, Rs 5,911)
{
  const row = (id: string, type: 'customer' | 'vendor', status: string, rOut: number, rCr: number, pOut: number, pCr: number) => ({
    contact_id: id, contact_name: id, contact_type: type, status,
    outstanding_receivable_amount_bcy: rOut, unused_credits_receivable_amount_bcy: rCr,
    outstanding_payable_amount_bcy: pOut, unused_credits_payable_amount_bcy: pCr,
  });
  const rows = [
    row('ACTIVE-V', 'vendor', 'active', 0, 0, 100, 0),
    row('HARISH', 'vendor', 'inactive', 0, 0, 5911, 0), // balance only from a journal
    row('GOOGLE', 'vendor', 'inactive', 0, 0, 1885.37, 1885.37), // outstanding = credits -> nets to zero
    row('RAJU', 'vendor', 'inactive', 0, 0, 6356, 6356),
    row('DORMANT', 'vendor', 'inactive', 0, 0, 0, 0),
    row('OLD-CUST', 'customer', 'inactive', 2500, 0, 0, 0),
    row('DORMANT-C', 'customer', 'inactive', 0, 0, 0, 0),
    row('TINY', 'vendor', 'inactive', 0, 0, 0.4, 0), // under Rs 1 -> ignored
  ];
  const ids = (xs: { contact_id: string }[]) => xs.map((x) => x.contact_id).sort().join(',');
  check('inactive vendor with a real balance is kept; inactive at zero / netting to zero / under Rs 1 stay out', ids(selectContacts(rows, 'vendor')) === 'ACTIVE-V,HARISH', ids(selectContacts(rows, 'vendor')));
  check('same rule for customers (inactive customer with Rs 2,500 kept, dormant one out)', ids(selectContacts(rows, 'customer')) === 'OLD-CUST', ids(selectContacts(rows, 'customer')));
  check('switch off (INCLUDE_INACTIVE_WITH_BALANCE=false) -> Active only, as before', ids(selectContacts(rows, 'vendor', { includeInactiveWithBalance: false })) === 'ACTIVE-V');
  check('the contact keeps its real status, so the sync can list it as an inactive contact included', selectContacts(rows, 'vendor').find((c) => c.contact_id === 'HARISH')?.status === 'inactive');

  const raw = emptyRaw('2026-10-08T10:00:00Z');
  raw.ledgerAccounts = { receivable: ['AR1'], payable: ['AP1'] };
  raw.activeVendors = selectContacts(rows, 'vendor');
  raw.journals = [jrnl('J240', '2026-05-13', '240', [jline('HARISH', 'credit', 5911, 'AP1')])];
  const without = computeAPSummary({ ...raw, activeVendors: raw.activeVendors.filter((c) => c.contact_id !== 'HARISH') }, '2026-10-08', { ledger: null });
  const withH = computeAPSummary(raw, '2026-10-08', { ledger: null });
  const harish = computeAPDetail(raw, '2026-10-08', { ledger: null }).find((v) => v.vendorId === 'HARISH');
  check('Harish journal-only balance is Rs 5,911 once he is in the list; the Creditors total rises by exactly that', harish !== undefined && near(harish.netTotal, 5911) && near(withH.grandTotal.netTotal - without.grandTotal.netTotal, 5911), `${harish?.netTotal} / +${withH.grandTotal.netTotal - without.grandTotal.netTotal}`);
}

// ---- A21. Coverage read from Zoho's side: a vendor with a balance on the report that the dashboard does not hold is reported
{
  const raw = emptyRaw('2026-10-08T10:00:00Z');
  const v = (id: string, out: number) => ({ contact_id: id, contact_name: id, contact_type: 'vendor' as const, status: 'active', outstanding_payable_amount: out, unused_credits_payable_amount: 0 });
  raw.activeVendors = [v('HELD', 100)];
  raw.vendorLedgerToday = { HELD: 100, MISSING: 5911, MISSING_CREDIT: -2500, DUST: 0.4, ZERO: 0 };
  const a = auditVendors(raw);
  check('coverage: report vendors with a balance that the dashboard does not hold are listed (5,911 and the -2,500 credit); dust and zero are not', a.reportVendorsNotHeldCount === 2 && a.reportVendorsNotHeld[0].id === 'MISSING' && a.reportVendorsNotHeld[0].balance === 5911, JSON.stringify(a.reportVendorsNotHeld));
  raw.vendorLedgerToday = { HELD: 100, ZERO: 0 };
  check('coverage: nothing missing -> count is 0', auditVendors(raw).reportVendorsNotHeldCount === 0);
}

// ---- A22. check-statement finds a JN-Clean journal that does NOT cancel (one leg on a non-AR/AP account, e.g. a group loan account)
{
  // Real shape: "RPE Energy Reserve (Loans and Advances Assets)": the Statement shows -23,49,35,000, the documents say -21,19,00,000;
  // the difference is ONE unlabelled journal row of 2,30,35,000 (debit on Sundry Creditors, credit on an Other Current Asset account).
  const accts = { receivable: ['AR1'], payable: ['AP1'] };
  const entries: JNCleanEntry[] = [
    { journal_id: 'J1', entry_number: 'JN-Clean-210', journal_date: '2026-03-31', lines: [jline('LOAN', 'credit', 23035000, 'OCA'), jline('LOAN', 'debit', 23035000, 'AP1')], applications: [] },
    { journal_id: 'J2', entry_number: 'JN-Clean-300', journal_date: '2026-11-30', lines: [jline('LOAN', 'debit', 777, 'AP1')], applications: [] }, // after the Statement's To date
  ];
  const exp = expectedJNLines(entries, 'LOAN', 'vendor', '2026-10-08', accts);
  check('expected JN lines: only the leg on the payable account counts, later-dated journals do not (vendor debit = -2,30,35,000 on the Statement)', exp.length === 1 && exp[0].effect === -23035000 && exp[0].journal === 'JN-Clean-210', JSON.stringify(exp));
  check('same journal for a CUSTOMER keeps the opposite sign convention (debit +)', expectedJNLines([{ ...entries[0], lines: [jline('C', 'debit', 500, 'AR1'), jline('C', 'credit', 200, 'AR1')] }], 'C', 'customer', '2026-10-08', accts).map((l) => l.effect).sort((a, b) => a - b).join() === '-200,500');

  const R = (date: string, type: string, details: string, amount: number, payments: number): StmtRow => ({ date, type, details, amount, payments });
  const rows: StmtRow[] = [
    R('10/04/2025', 'Payment Made', 'advance', 0, 211900000),
    R('15/05/2026', 'Journal', '', 0, 23035000), // same amount, WRONG date: an ordinary journal, must not be taken for the JN-Clean row
    R('31/03/2026', 'Journal', '', 5000, 0), // right date, other amount
    R('31/03/2026', 'Journal', '', 0, 23035000), // the JN-Clean row: no label, no pair
  ];
  const f = findJNRows(rows, exp);
  check('unlabelled single JN-Clean row located by date and amount (3rd row), not the same-amount row on another date', f.located.length === 1 && f.located[0].row === 3 && f.located[0].by === 'date and amount' && f.missing.length === 0 && f.rowIdx.size === 1, JSON.stringify(f.located));
  const recomputed = 0 + 0 - (211900000 + 23035000 + 23035000) + 5000;
  check('Statement less the located JN-Clean row = dashboard figure to the rupee (the ordinary same-amount journal stays in)', Math.abs(recomputed - f.net - (-211900000 - 23035000 + 5000)) <= 1 && f.net === -23035000, String(f.net));

  const byNumber = findJNRows([R('02/02/2026', 'Journal', 'JN-Clean-210\n', 0, 23035000)], exp);
  check('when the Statement prints the journal number, it is located by number (any date)', byNumber.located.length === 1 && byNumber.located[0].by === 'journal number');
  const near210 = findJNRows([R('02/02/2026', 'Journal', 'JN-Clean-2100\n', 0, 23035000)], exp);
  check('journal number must match whole: "JN-Clean-2100" is not "JN-Clean-210"', near210.located.length === 0 && near210.missing.length === 1);
  const gone = findJNRows([R('10/04/2025', 'Payment Made', 'advance', 0, 211900000)], exp);
  check('a JN-Clean line the dashboard removed but the Statement does not show is reported as missing, never ignored', gone.missing.length === 1 && gone.net === 0 && gone.expectedNet === -23035000);
  const twice = findJNRows([R('31/03/2026', 'Journal', '', 0, 100)], [{ journal: 'A', date: '2026-03-31', effect: -100 }, { journal: 'B', date: '2026-03-31', effect: -100 }]);
  check('one Statement row is never used for two lines', twice.located.length === 1 && twice.missing.length === 1);
  const merged = findJNRows([R('31/03/2026', 'Journal', '', 500, 0)], [{ journal: 'M', date: '2026-03-31', effect: 300 }, { journal: 'M', date: '2026-03-31', effect: 200 }]);
  check('two lines of one journal printed as a single row (their total) are still located, and the row is counted once', merged.located.length === 2 && merged.missing.length === 0 && merged.rowIdx.size === 1 && merged.net === 500 && merged.located[0].by === 'journal total');
  const pair = findJNRows([R('31/03/2026', 'Journal', '\n₹6,66,000.00 for payment of AE/25-26/053', -3864800, 0), R('31/03/2026', 'Journal', '', 3864800, 0)], []);
  check('the old rules still work with no cache: a same-day cancelling pair is recognised and nets to zero', pair.rowIdx.size === 2 && pair.net === 0);

  // the whole path: a real .xls file -> parseStatement -> locate
  const { parseStatement } = require('./check-statement') as typeof import('./check-statement');
  const grid: unknown[][] = [
    ['Rays Power Experts Ltd.\n            RPE LOAN TEST\n            Vendor Statement\n                From 01/04/2025 To 08/10/2026', null, null, null, null, null],
    ['', '', 'Account Summary', '', '', ''],
    ['Opening Balance', '₹ 0.00', null, null, null, null],
    ['Balance Due', '₹ -23,49,35,000.00', null, null, null, null],
    [null, null, null, null, null, null],
    ['Date', 'Transactions', 'Details', 'Amount', 'Payments', 'Balance'],
    ['', 'Opening Balance', '', 0, '', 0],
    ['10/04/2025', 'Payment Made', 'advance', null, 211900000, -211900000],
    ['31/03/2026', 'Journal', '', null, 23035000, -234935000],
  ];
  const file = nodePath.join(nodeOs.tmpdir(), `selftest-loan-${process.pid}.xls`);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(grid), 'Statement');
  XLSX.writeFile(wb, file, { bookType: 'biff8' });
  const st = parseStatement(file);
  const fileExp = expectedJNLines(entries, 'LOAN', st.kind, '2026-10-08', accts);
  const ff = findJNRows(st.rows, fileExp);
  const sumNet = st.opening + st.rows.reduce((a, r) => a + r.amount - r.payments, 0);
  check('end to end from a real .xls: printed -23,49,35,000, JN-Clean row found, balance without it = -21,19,00,000', st.kind === 'vendor' && st.printedBalance === -234935000 && ff.located.length === 1 && Math.abs(sumNet - ff.net - -211900000) <= 1, `${st.printedBalance} / ${sumNet - ff.net}`);
  try { require('fs').unlinkSync(file); } catch { /* temp file: fine if it is already gone */ }
}

// ---- A24. foreign-currency vendor Statements (rupee section + USD section), in the layouts of the real Guangdong and Xiamen exports
{
  const cs = require('./check-statement') as typeof import('./check-statement');
  const write = (grid: unknown[][], tag: string) => {
    const file = nodePath.join(nodeOs.tmpdir(), `selftest-fx-${tag}-${process.pid}.xls`);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(grid), 'vendor_statement');
    XLSX.writeFile(wb, file, { bookType: 'biff8' });
    return file;
  };
  const H = ['Date', 'Transactions', 'Details', 'Amount', 'Payments', 'Balance'];
  // Guangdong: summary columns INR, USD (rupees first)
  const gd = write([
    ['Rays Power Experts Ltd.\n Guangdong Test Co\n Vendor Statement\n From 01/04/2025 To 09/10/2026'],
    [],
    ['Account Summary', 'INR', 'USD'], ['Opening Balance', '₹ 0.00', '$ 0.000'], ['Billed Amount', '₹ 12,276.00', '$ 240,000.000'], ['Amount Paid', '₹ 0.00', '$ 216,000.000'], ['Balance Due', '₹ 12,276.00', '$ 24,000.000'],
    [],
    ['₹ INR - Indian Rupee', '', '', '', '', ''], H, ['', 'Opening Balance', '', 0, '', 0],
    ['31/03/2026', 'Journal', '', -22082124, null, -22082124], ['31/03/2026', 'Journal', '', 22082124, null, 0],
    ['31/03/2026', 'Journal', '', -12276, null, -12276], ['31/03/2026', 'Journal', '', 12276, null, 0], ['31/03/2026', 'Journal', '', 12276, null, 12276],
    ['01/04/2026', 'Journal', '', 12276, null, 24552], ['01/04/2026', 'Journal', '', -12276, null, 12276],
    ['', '', '', '', 'Balance Due', '₹ 12,276.00'],
    [],
    ['$ USD - United States Dollar', '', '', '', '', ''], H, ['', 'Opening Balance', '', 0, '', 0],
    ['15/06/2026', 'Credits Applied', '1685\n$192,000.000 for payment of X', null, null, 0], ['15/06/2026', 'Credits Applied', '1684\n$24,000.000 for payment of X', null, null, 0],
    ['12/12/2025', 'Payment Made', '1684', null, 24000, -24000], ['23/01/2026', 'Payment Made', '1685', null, 192000, -216000],
    ['20/03/2026', 'Bill', 'RefPO/25-26/00458', 240000, null, 24000],
    ['', '', '', '', 'Balance Due', '$ 24,000.000'],
  ], 'gd');
  const g = cs.parseStatement(gd);
  const gdBase = g.opening + g.rows.reduce((a, r) => a + r.amount - r.payments, 0);
  check('foreign Statement (rupees listed first): rupee section is only the rupee rows (7), printed Rs 12,276, rows add up to it', g.rows.length === 7 && g.printedBalance === 12276 && Math.abs(gdBase - 12276) < 0.01, `${g.rows.length} / ${g.printedBalance} / ${gdBase}`);
  const gdUsd = g.foreign[0];
  check('foreign Statement: USD section kept apart, USD 24,000 due, its rows add up to it, header rows not mistaken for transactions', g.foreign.length === 1 && gdUsd.currency === 'USD' && gdUsd.printed === 24000 && gdUsd.rows.length === 5 && Math.abs(gdUsd.opening + gdUsd.rows.reduce((a, r) => a + r.amount - r.payments, 0) - 24000) < 0.001, JSON.stringify({ n: gdUsd.rows.length, p: gdUsd.printed }));
  const ev = cs.rateEvidence(g.rows, gdUsd, 92.00883);
  check('the rate is read off the Statement itself: Rs 2,20,82,124 in the rupee section / USD 240,000 bill = 92.00885', !!ev && Math.abs(ev.rate - 92.00885) < 1e-6 && ev.rupees === 22082124 && ev.foreignAmount === 240000, JSON.stringify(ev));
  check('a rate that nothing on the Statement supports is not "confirmed" (expected 80 -> none within 1%)', cs.rateEvidence(g.rows, gdUsd, 80) === null);
  check('USD 24,000 at 92.00885 = Rs 22,08,212 and with the rupee part Rs 22,20,488', Math.round(24000 * 92.00885) === 2208212 && Math.round(12276 + 24000 * 92.00885) === 2220488);

  // Xiamen: summary columns USD, INR (dollars first) -- the printed rupee figure is in the SECOND column
  const xm = write([
    ['Rays Power Experts Ltd.\n Xiamen Test Ltd\n Vendor Statement\n From 01/04/2025 To 09/10/2026'],
    [],
    ['Account Summary', 'USD', 'INR'], ['Opening Balance', '$ 0.000', '₹ 0.00'], ['Billed Amount', '$ 1,000.000', '₹ -4,432.59'], ['Amount Paid', '$ 1,000.000', '₹ 0.00'], ['Balance Due', '$ 0.000', '₹ -4,432.59'],
    [],
    ['$ USD - United States Dollar', '', '', '', '', ''], H, ['', 'Opening Balance', '', 0, '', 0],
    ['21/11/2025', 'Payment Made', '1286', null, 1000, -1000],
    ['31/03/2026', 'Bill', 'RefPO', 1000, null, 0],
    ['31/03/2026', 'Journal', '', 1164679.35, null, 1164679.35], ['31/03/2026', 'Journal', '', -1164679.35, null, 0], ['31/03/2026', 'Journal', '', 1398.47, null, 1398.47],
    ['', '', '', '', 'Balance Due', '$ 0.000'],
    [],
    ['₹ INR - Indian Rupee', '', '', '', '', ''], H, ['', 'Opening Balance', '', 0, '', 0],
    ['31/03/2026', 'Journal', '', -108879641.3, null, -108879641.3], ['31/03/2026', 'Journal', '', 108879641.3, null, 0], ['31/03/2026', 'Journal', '', -4432.59, null, -4432.59],
    ['', '', '', '', 'Balance Due', '₹ -4,432.59'],
  ], 'xm');
  const x = cs.parseStatement(xm);
  check('foreign Statement (dollars listed first): the RUPEE Balance Due (-4,432.59) is read, not the dollar one; rupee rows = 3', x.printedBalance === -4432.59 && x.rows.length === 3 && x.foreign[0].currency === 'USD' && x.foreign[0].printed === 0, `${x.printedBalance} / ${x.rows.length}`);
  const jm = cs.findForeignJournal(x.foreign, { journal: '296', date: '2026-03-31', effect: 130735.48 });
  check('a foreign-currency JN-Clean journal known to the dashboard in rupees is found in the USD section (USD 1,398.47 = Rs 1,30,735.48 at 93.48465), not mistaken for the USD 11,64,679 pair', !!jm && jm.amt === 1398.47 && Math.abs(jm.rate - 93.48465) < 1e-4, JSON.stringify(jm));
  check('single-currency Statements are read exactly as before (no foreign sections)', cs.parseStatement(write([
    ['Rays Power Experts Ltd.\n One Currency Co\n Vendor Statement\n From 01/04/2025 To 09/10/2026'], ['', '', 'Account Summary', '', '', ''], ['Opening Balance', '₹ 0.00'], ['Balance Due', '₹ 500.00'], [], H, ['', 'Opening Balance', '', 0, '', 0], ['01/05/2025', 'Bill', 'b', 500, null, 500],
  ], 'one')).foreign.length === 0);
  // a folder stands for the .xls / .xlsx files in it (one command for a whole folder; no shell wildcards needed)
  const dir = require('fs').mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'selftest-folder-'));
  for (const n of ['B & C (x).xls', 'a.xlsx', '~$a.xlsx', 'notes.txt']) require('fs').writeFileSync(nodePath.join(dir, n), 'x');
  const expanded = cs.expandFiles([dir, 'nowhere-gone.xls']).map((f: string) => nodePath.basename(f));
  check('a folder argument expands to its .xls/.xlsx files only (temp "~$" files and .txt skipped, a name with & and brackets kept intact); a missing path is left alone', expanded.length === 3 && expanded.includes('a.xlsx') && expanded.includes('B & C (x).xls') && expanded.includes('nowhere-gone.xls') && !expanded.some((f: string) => f.startsWith('~$') || f.endsWith('.txt')), expanded.join('|'));
  try { require('fs').rmSync(dir, { recursive: true, force: true }); } catch { /* temp folder */ }
  for (const f of [gd, xm, nodePath.join(nodeOs.tmpdir(), `selftest-fx-one-${process.pid}.xls`)]) { try { require('fs').unlinkSync(f); } catch { /* temp file */ } }
}

// ---- A25. Foreign-currency contacts proven against Zoho's OWN figures: its balance in each currency and the rate on each document. No rate is worked out or guessed.
{
  const bal = (currency: string, outstanding: number, unused = 0): ContactCurrencyBalance => ({ currency, outstanding, unused, net: outstanding - unused });
  const vend = (id: string, name: string, rupees: number, by?: ContactCurrencyBalance[]): ZohoContact => ({ contact_id: id, contact_name: name, contact_type: 'vendor', status: 'active', outstanding_payable_amount: rupees, unused_credits_payable_amount: 0, ...(by ? { by_currency: by } : {}) });
  const cust = (id: string, name: string, rupees: number, by?: ContactCurrencyBalance[]): ZohoContact => ({ contact_id: id, contact_name: name, contact_type: 'customer', status: 'active', outstanding_receivable_amount: rupees, unused_credits_receivable_amount: 0, ...(by ? { by_currency: by } : {}) });
  const fbill = (id: string, vendor: string, currency: string, rate: number, total: number, open: number, status = 'open', date = '2026-03-20') => ({ bill_id: id, vendor_id: vendor, date, due_date: date, total: Math.round(total * rate * 100) / 100, balance: Math.round(open * rate * 100) / 100, status, foreign: { currency, rate, total, open } });
  const fpay = (id: string, vendor: string, currency: string, rate: number, amount: number, unused: number, date = '2026-04-01') => ({ payment_id: id, vendor_id: vendor, date, amount: Math.round(amount * rate * 100) / 100, unused_amount: Math.round(unused * rate * 100) / 100, status: 'paid', foreign: { currency, rate, total: amount, open: unused } });
  const AS = '2026-10-09T10:00:00Z';

  // ---- how the contact's per-currency balances are read, in the shapes Zoho sends
  const gdRow = { contact_id: 'GD', contact_name: 'Guangdong', contact_type: 'vendor', status: 'active', currency_id: 'CUR_USD', currency_code: 'USD', outstanding_payable_amount: 24000, unused_credits_payable_amount: 0, outstanding_payable_amount_bcy: 2220488.4, unused_credits_payable_amount_bcy: 0, non_default_currency_values: [{ currency_id: 'CUR_INR', outstanding_payable_amount: 12276, unused_credits_payable_amount: 0 }] };
  const inrRow = { contact_id: 'PLAIN', contact_name: 'Plain Rupee Vendor', contact_type: 'vendor', status: 'active', currency_id: 'CUR_INR', currency_code: 'INR', outstanding_payable_amount: 500, unused_credits_payable_amount: 0 };
  const xmRow = { contact_id: 'XM', contact_name: 'Xiamen', contact_type: 'vendor', status: 'active', currency_id: 'CUR_USD', currency_code: 'USD', outstanding_payable_amount: 0, unused_credits_payable_amount: 0, outstanding_payable_amount_bcy: 0, unused_credits_payable_amount_bcy: 0, non_default_currency_values: [{ currency_id: 'CUR_INR', outstanding_payable_amount: 0, unused_credits_payable_amount: 4432.59 }] };
  const sel = selectContacts([gdRow, inrRow, xmRow], 'vendor');
  const g = sel.find((c) => c.contact_id === 'GD');
  const x = sel.find((c) => c.contact_id === 'XM');
  const p = sel.find((c) => c.contact_id === 'PLAIN');
  check('contact list row, foreign vendor: USD (the contact\'s own currency) and INR (named only by id in non_default_currency_values) both read: USD 24,000 and INR 12,276', !!g && g.by_currency?.length === 2 && g.by_currency.find((e) => e.currency === 'USD')?.net === 24000 && g.by_currency.find((e) => e.currency === 'INR')?.net === 12276, JSON.stringify(g?.by_currency));
  check('the contact\'s rupee balance is still the _bcy figure (Rs 22,20,488.40), as before', g?.outstanding_payable_amount === 2220488.4);
  check('Xiamen\'s row: USD nil, INR -4,432.59 (a credit of 4,432.59 and nothing outstanding)', !!x && x.by_currency?.find((e) => e.currency === 'USD')?.net === 0 && x.by_currency?.find((e) => e.currency === 'INR')?.net === -4432.59, JSON.stringify(x?.by_currency));
  check('a rupee-only vendor carries no per-currency data at all (the cache stays as small as before)', !!p && !('by_currency' in p));
  check('a currency id that cannot be named is shown as CUR#id, never dropped or taken for rupees', contactCurrencies({ contact_type: 'vendor', currency_code: 'INR', outstanding_payable_amount: 1, non_default_currency_values: [{ currency_id: '999', outstanding_payable_amount: 50, unused_credits_payable_amount: 0 }] }, new Map())?.some((e) => e.currency === 'CUR#999' && e.net === 50) === true);
  check('currency ids are learnt from the rows that name both', currencyCodeMap([gdRow, inrRow]).get('CUR_USD') === 'USD' && currencyCodeMap([gdRow, inrRow]).get('CUR_INR') === 'INR');
  const one = trimContact({ contact_id: 'GD', contact_name: 'Guangdong', contact_type: 'vendor', status: 'active', outstanding_payable_amount_bcy: 2220488.4, unused_credits_payable_amount_bcy: 0, vendor_currency_summaries: [{ currency_code: 'USD', outstanding_payable_amount: 24000, unused_credits_payable_amount: 0 }, { currency_code: 'INR', outstanding_payable_amount: 12276, unused_credits_payable_amount: 0 }] });
  check('a single-contact read (vendor_currency_summaries, codes included) gives the same per-currency balances', one.by_currency?.find((e) => e.currency === 'USD')?.net === 24000 && one.by_currency?.find((e) => e.currency === 'INR')?.net === 12276);
  const cOne = trimContact({ contact_id: 'EC', contact_name: 'Euro Customer', contact_type: 'customer', status: 'active', currency_code: 'EUR', outstanding_receivable_amount: 800, unused_credits_receivable_amount: 0, outstanding_receivable_amount_bcy: 80000, non_default_currency_values: [] });
  check('a customer is read on the receivable side (EUR 800)', cOne.by_currency?.length === 1 && cOne.by_currency[0].currency === 'EUR' && cOne.by_currency[0].net === 800);
  check('a document in the base currency has no foreign side; a foreign one keeps Zoho\'s rate and face amounts', foreignDoc({ currency_code: 'INR', exchange_rate: 1 }, { total: 5, open: 5 }) === undefined && JSON.stringify(foreignDoc({ currency_code: 'usd', exchange_rate: 92.00885 }, { total: 240000, open: '24000' })) === JSON.stringify({ currency: 'USD', rate: 92.00885, total: 240000, open: 24000 }));

  // ---- Guangdong: USD 24,000 open on a bill booked at 92.00885, plus Rs 12,276 in the rupee column
  const raw = emptyRaw(AS);
  raw.activeVendors = [vend('GD', 'Guangdong Test Co', 2220488.4, [bal('INR', 12276), bal('USD', 24000)])];
  raw.bills = [fbill('GB1', 'GD', 'USD', 92.00885, 240000, 24000)];
  const v = foreignBreakdown(raw, raw.activeVendors[0])!;
  const usd = v.currencies[0];
  check('Guangdong: USD 24,000 at Zoho\'s rate 92.00885 = Rs 22,08,212.40; the rate comes from Zoho\'s own figures (not from the Statement)', v.status === 'open' && usd.currency === 'USD' && usd.zohoFace === 24000 && v.foreignRupees === 2208212.4 && usd.zohoRate !== null && usd.zohoRate.toFixed(5) === '92.00885', JSON.stringify({ s: v.status, f: v.foreignRupees, r: usd.zohoRate }));
  check('Guangdong: the open bill carries the same rate and the open documents agree with Zoho\'s balance; nothing unexplained', usd.documentsAgree === true && usd.documentsRate !== null && usd.documentsRate.toFixed(5) === '92.00885' && v.exchangeDifference === 0 && v.problems.length === 0, JSON.stringify(v.problems));
  const gdCols = [{ currency: 'INR', printed: 12276 }, { currency: 'USD', printed: 24000 }];
  const gv = statementVerdict(v, gdCols, 12276, 2220488.4)!;
  check('Guangdong Statement (INR 12,276 and USD 24,000) MATCHES, with no rate given or guessed: columns equal Zoho\'s, dashboard = rupee section + Zoho\'s foreign part', gv.match && gv.columnsMatch && Math.abs(gv.target - 2220488.4) < 0.01 && gv.columns.every((c) => c.ok), JSON.stringify(gv));
  const noUsd = statementVerdict(v, [{ currency: 'INR', printed: 12276 }], 12276, 2220488.4)!;
  check('a Statement without its USD section is NOT a match (USD 24,000 in Zoho, none printed)', !noUsd.match && !noUsd.columnsMatch && noUsd.columns.find((c) => c.currency === 'USD')?.diff === -24000);
  const usdOff = statementVerdict(v, [{ currency: 'INR', printed: 12276 }, { currency: 'USD', printed: 24001 }], 12276, 2220488.4)!;
  check('a USD column that is USD 1 off is caught', !usdOff.match && usdOff.columns.find((c) => c.currency === 'USD')?.ok === false);
  const dashOff = statementVerdict(v, gdCols, 12276, 2220400)!;
  check('columns right but the dashboard Rs 88 short of the Statement\'s rupee value: DIFFERS by that amount', !dashOff.match && dashOff.columnsMatch && Math.round(dashOff.diff) === -88);
  const lines = describeForeign(v).join('\n');
  check('the description names the rate and the bill it comes from', /92\.00885/.test(lines) && /Bill\s+GB1/.test(lines) && /Zoho's rate/.test(lines));

  // ---- Xiamen: nil dollar balance, a rupee residual. Explained by the two documents' own rates (advance 90.31505, journal 93.48465)
  const xr = emptyRaw(AS);
  xr.ledgerAccounts = { receivable: ['AR1'], payable: ['AP1'] };
  xr.activeVendors = [vend('XM', 'Xiamen Test Ampace', 0, [bal('USD', 0), bal('INR', 0, 4432.59)])];
  xr.vendorPayments = [fpay('XP1', 'XM', 'USD', 90.31505, 1398.47, 1398.47)];
  xr.journals = [{ journal_id: 'J296', journal_date: '2026-09-14', entry_number: '296', currency_code: 'USD', exchange_rate: 93.48465, available_payables_credits: 0, line_items: [{ account_id: 'EXP1', debit_or_credit: 'debit', amount: 130735.48, face_amount: 1398.47 }, { contact_id: 'XM', account_id: 'AP1', debit_or_credit: 'credit', amount: 130735.48, face_amount: 1398.47 }] }];
  const xv = foreignBreakdown(xr, xr.activeVendors[0])!;
  check('Xiamen: foreign balance nil, Zoho still carries Rs 4,432.59 on the foreign side -> status "residual"', xv.status === 'residual' && xv.currencies[0].zohoFace === 0 && xv.baseFace === -4432.59 && xv.foreignRupees === 4432.59, JSON.stringify({ s: xv.status, b: xv.baseFace, f: xv.foreignRupees }));
  check('Xiamen: the two documents explain it exactly -- journal USD 1,398.47 at 93.48465 (Rs 1,30,735.48) against the advance at 90.31505 (Rs 1,26,302.89); nothing unexplained', xv.currencies[0].documents.length === 2 && xv.currencies[0].documentsFace === 0 && xv.currencies[0].documentsRupees === 4432.59 && xv.exchangeDifference === 0 && xv.problems.length === 0 && xv.currencies[0].documents.some((d) => d.kind === 'journal' && d.rate === 93.48465) && xv.currencies[0].documents.some((d) => d.kind === 'payment' && d.rate === 90.31505), JSON.stringify(xv.currencies[0].documents));
  const xvd = statementVerdict(xv, [{ currency: 'USD', printed: 0 }, { currency: 'INR', printed: -4432.59 }], -4432.59, 0)!;
  check('Xiamen Statement (USD 0, INR -4,432.59) MATCHES the dashboard\'s Rs 0: -4,432.59 + Zoho\'s foreign part 4,432.59', xvd.match && xvd.target === 0, JSON.stringify(xvd));

  // ---- constructed cases (no more live foreign vendors exist, so the rule is proven on scenarios)
  const mr = emptyRaw(AS);
  mr.activeVendors = [vend('MX', 'Many Rates Pvt', 1292000, [bal('INR', 5000), bal('USD', 15000, 3000), bal('EUR', 2000)])];
  mr.bills = [fbill('M1', 'MX', 'USD', 90, 10000, 10000), fbill('M2', 'MX', 'USD', 92, 5000, 5000), fbill('M3', 'MX', 'EUR', 100, 2000, 2000), fbill('M4', 'MX', 'USD', 95, 700, 700, 'draft'), fbill('M5', 'MX', 'USD', 95, 800, 0)];
  mr.vendorPayments = [fpay('MP1', 'MX', 'USD', 91, 3000, 3000)];
  const mv = foreignBreakdown(mr, mr.activeVendors[0])!;
  const musd = mv.currencies.find((c) => c.currency === 'USD')!;
  const meur = mv.currencies.find((c) => c.currency === 'EUR')!;
  check('two bills at different rates (USD 10,000 at 90 and 5,000 at 92) less an unapplied USD 3,000 advance at 91: USD 12,000 = Rs 10,87,000, the documents\' own rate 90.58333', musd.documentsFace === 12000 && musd.documentsRupees === 1087000 && musd.documentsAgree === true && musd.documentsRate !== null && musd.documentsRate.toFixed(5) === '90.58333', JSON.stringify({ f: musd.documentsFace, r: musd.documentsRupees }));
  check('a draft bill and a fully paid bill are not counted', musd.documents.length === 3 && !musd.documents.some((d) => d.id === 'M4' || d.id === 'M5'));
  check('two foreign currencies at once: EUR 2,000 at 100 as well; together Rs 12,87,000 = what Zoho\'s rupee balance leaves after the rupee column; nothing unexplained', meur.documentsFace === 2000 && mv.foreignRupees === 1287000 && mv.exchangeDifference === 0 && mv.problems.length === 0, JSON.stringify({ f: mv.foreignRupees, d: mv.exchangeDifference, p: mv.problems }));
  check('with several foreign currencies the rate is not attributed to one of them (the combined rupee value is what is checked)', musd.zohoRate === null && meur.zohoRate === null);
  const mcols = statementVerdict(mv, [{ currency: 'INR', printed: 5000 }, { currency: 'USD', printed: 12000 }, { currency: 'EUR', printed: 2000 }], 5000, 1292000)!;
  check('all three currency columns of that Statement match Zoho\'s, and so does the rupee total', mcols.match && mcols.columns.length === 3);

  const dr = emptyRaw(AS);
  dr.activeVendors = [vend('DX', 'Disagreeing Vendor', 2300000 + 500, [bal('INR', 500), bal('USD', 25000)])];
  dr.bills = [fbill('D1', 'DX', 'USD', 92, 24000, 24000)];
  const dv = foreignBreakdown(dr, dr.activeVendors[0])!;
  check('if Zoho\'s balance (USD 25,000) and the open documents (USD 24,000) disagree it is reported, not smoothed over', dv.currencies[0].documentsAgree === false && dv.problems.some((t) => /25000/.test(t) && /24000/.test(t)) && dv.exchangeDifference === 92000, JSON.stringify(dv.problems));

  const nr = emptyRaw(AS);
  nr.activeVendors = [vend('NR', 'No Rate Vendor', 90000, [bal('INR', 0), bal('USD', 1000)])];
  nr.bills = [fbill('N1', 'NR', 'USD', 0, 1000, 1000)];
  check('a foreign document that came without a rate is flagged', foreignBreakdown(nr, nr.activeVendors[0])!.problems.some((t) => /without an exchange rate/.test(t)));

  const cr = emptyRaw(AS);
  cr.activeCustomers = [cust('EC', 'Euro Customer', 80000, [bal('EUR', 800)])];
  cr.invoices = [{ invoice_id: 'EI1', customer_id: 'EC', date: '2026-08-01', due_date: '2026-09-01', total: 100000, balance: 100000, status: 'sent', foreign: { currency: 'EUR', rate: 100, total: 1000, open: 1000 } }];
  cr.creditNotes = [{ creditnote_id: 'ECN1', customer_id: 'EC', date: '2026-08-15', total: 20000, balance: 20000, status: 'open', foreign: { currency: 'EUR', rate: 100, total: 200, open: 200 } }];
  const cv = foreignBreakdown(cr, cr.activeCustomers[0])!;
  check('a foreign CUSTOMER works the same way: EUR 1,000 invoice less a EUR 200 credit note = EUR 800 = Rs 80,000 at 100', cv.side === 'customer' && cv.currencies[0].documentsFace === 800 && cv.currencies[0].zohoRate === 100 && cv.problems.length === 0, JSON.stringify(cv.problems));

  // ---- a cache written before per-currency balances were kept
  const old = emptyRaw(AS);
  old.activeVendors = [vend('GD', 'Guangdong Test Co', 2220488.4)];
  old.bills = [fbill('GB1', 'GD', 'USD', 92.00885, 240000, 24000)];
  const ov = foreignBreakdown(old, old.activeVendors[0])!;
  check('an old cache (no per-currency balances) still shows the foreign documents, says so, and makes no column verdict', ov.hasContactCurrencies === false && ov.currencies[0].documentsRate?.toFixed(5) === '92.00885' && compareColumns(ov, gdCols) === null && statementVerdict(ov, gdCols, 12276, 2220488.4) === null && /sync-cache/.test(describeForeign(ov).join('\n')));

  // ---- who counts as a foreign contact
  const fr = emptyRaw(AS);
  fr.activeVendors = [vend('PL', 'Rupee Only', 500), vend('TG', 'Tagged Only', 0, [bal('USD', 0)]), vend('ST', 'Settled Vendor', 0, [bal('USD', 0)]), ...raw.activeVendors];
  fr.bills = [...raw.bills, fbill('S1', 'ST', 'USD', 90, 100, 0)];
  const fc = foreignContacts(fr);
  check('only contacts with something foreign are listed; "settled" and "tag" are kept apart from those with a balance', fc.length === 3 && fc[0].name === 'Guangdong Test Co' && fc.find((c) => c.name === 'Settled Vendor')?.status === 'settled' && fc.find((c) => c.name === 'Tagged Only')?.status === 'tag' && !fc.some((c) => c.name === 'Rupee Only'), fc.map((c) => c.name + ':' + c.status).join(', '));
}

// ---- A23. JN-Clean rows are kept where they do NOT cancel (default rule): dashboard = Statement, documents and ledger agree
{
  const AS_OF = '2026-10-05';
  const acc = { receivable: ['AR1'], payable: ['AP1'] };
  const vend = (id: string, out: number, cred: number) => ({ contact_id: id, contact_name: id, contact_type: 'vendor' as const, status: 'active', outstanding_payable_amount: out, unused_credits_payable_amount: cred });
  const cust = (id: string, out: number, cred: number) => ({ contact_id: id, contact_name: id, contact_type: 'customer' as const, status: 'active', outstanding_receivable_amount: out, unused_credits_receivable_amount: cred });
  const mk = (): RawZohoData => ({ ...emptyRaw('2026-10-05T08:00:00Z'), ledgerAccounts: acc });
  const both = (raw: RawZohoData) => {
    const l = ledgerFromContacts(raw);
    process.env.JN_CLEAN_RULE = 'literal';
    const lit = { ar: computeARDetail(raw, AS_OF, { ledger: l }), ap: computeAPDetail(raw, AS_OF, { ledger: l }) };
    delete process.env.JN_CLEAN_RULE;
    const def = { ar: computeARDetail(raw, AS_OF, { ledger: l }), ap: computeAPDetail(raw, AS_OF, { ledger: l }) };
    return { lit, def };
  };

  // (1) a lone JN-Clean debit on a vendor, nothing else (Manish Singhal, Kainer, Abhilasha): Statement -75,00,000
  {
    const raw = mk();
    raw.activeVendors = [vend('MS', 0, 7500000)];
    raw.jnClean = [{ journal_id: 'M1', entry_number: 'JN-Clean-1', journal_date: '2026-03-31', lines: [jline('MS', 'credit', 7500000, 'OCA'), jline('MS', 'debit', 7500000, 'AP1')], applications: [] }];
    const { lit, def } = both(raw);
    check('lone JN-Clean debit on a vendor: default rule shows -75,00,000 = the Statement, no gap; the literal rule shows 0 (and its ledger 0)', near(def.ap[0].netTotal, -7500000) && near(def.ap[0].ledgerTotal ?? NaN, -7500000) && def.ap[0].gap === 0 && near(lit.ap[0].netTotal, 0) && near(lit.ap[0].ledgerTotal ?? NaN, 0), `${inr(def.ap[0].netTotal)} / literal ${inr(lit.ap[0].netTotal)}`);
  }
  // (2) the JN debit was spent on a bill: the bill stays at Zoho's balance, nothing is counted twice
  {
    const raw = mk();
    raw.activeVendors = [vend('BP', 40, 0)];
    raw.bills = [{ bill_id: 'B1', vendor_id: 'BP', date: '2026-01-10', due_date: '2026-02-10', status: 'open', total: 100, balance: 40 }] as typeof raw.bills;
    raw.jnClean = [{ journal_id: 'M2', entry_number: 'JN-Clean-2', journal_date: '2026-03-31', lines: [jline('BP', 'credit', 60, 'OCA'), jline('BP', 'debit', 60, 'AP1')], applications: [{ kind: 'bill', doc_id: 'B1', amount: 60 }] }];
    const { lit, def } = both(raw);
    check('JN debit spent on a bill: default = bill at Zoho\'s balance 40, no extra item, equals the Statement 40; literal adds the 60 back (100) and removes it from the ledger (100): both agree with their ledger', near(def.ap[0].netTotal, 40) && near(def.ap[0].ledgerTotal ?? NaN, 40) && def.ap[0].gap === 0 && near(lit.ap[0].netTotal, 100) && near(lit.ap[0].ledgerTotal ?? NaN, 100) && lit.ap[0].gap === 0, `${def.ap[0].netTotal} / literal ${lit.ap[0].netTotal}`);
  }
  // (3) customer: JN credit spent on an invoice. The invoice keeps Zoho's balance and ages as Zoho ages it
  {
    const raw = mk();
    raw.activeCustomers = [cust('CC', 400000, 0)];
    raw.invoices = [{ invoice_id: 'I1', customer_id: 'CC', date: '2026-01-10', due_date: '2026-03-01', status: 'sent', total: 1000000, balance: 400000 }] as typeof raw.invoices;
    raw.jnClean = [{ journal_id: 'M3', entry_number: 'JN-Clean-3', journal_date: '2026-03-31', lines: [jline('CC', 'debit', 600000, 'OCA'), jline('CC', 'credit', 600000, 'AR1')], applications: [{ kind: 'invoice', doc_id: 'I1', amount: 600000 }] }];
    const { lit, def } = both(raw);
    check('customer, JN credit spent on an invoice (does not cancel): default = 4,00,000 = Statement, aged on the invoice as Zoho has it (>180 days), no gap; literal = 10,00,000 with its ledger 10,00,000', near(def.ar[0].netTotal, 400000) && def.ar[0].gap === 0 && near(def.ar[0].more180, 400000) && near(lit.ar[0].netTotal, 1000000) && lit.ar[0].gap === 0, `${def.ar[0].netTotal} more180 ${def.ar[0].more180} / literal ${lit.ar[0].netTotal}`);
  }
  // (4) customer owes through a lone JN-Clean debit: it is an owed item, aged by the JN date
  {
    const raw = mk();
    raw.activeCustomers = [cust('CD', 250000, 0)];
    raw.jnClean = [{ journal_id: 'M4', entry_number: 'JN-Clean-4', journal_date: '2026-03-31', lines: [jline('CD', 'credit', 250000, 'OCA'), jline('CD', 'debit', 250000, 'AR1')], applications: [] }];
    const { lit, def } = both(raw);
    check('customer with a lone JN-Clean debit: default = 2,50,000 owed (>180 days by the JN date) = Statement, no gap; literal = 0', near(def.ar[0].netTotal, 250000) && def.ar[0].gap === 0 && near(def.ar[0].more180, 250000) && near(lit.ar[0].netTotal, 0), `${def.ar[0].netTotal} / literal ${lit.ar[0].netTotal}`);
  }
  // (5) a contact where JN-Clean cancels is exactly as before under both rules
  {
    const raw = mk();
    raw.activeCustomers = [cust('CE', 1000, 0)];
    raw.invoices = [{ invoice_id: 'I5', customer_id: 'CE', date: '2026-01-10', due_date: '2026-02-10', status: 'sent', total: 1000, balance: 400 }] as typeof raw.invoices;
    raw.jnClean = [{ journal_id: 'M5', entry_number: 'JN-Clean-5', journal_date: '2026-03-31', lines: [jline('CE', 'credit', 600, 'AR1'), jline('CE', 'debit', 600, 'AR1')], applications: [{ kind: 'invoice', doc_id: 'I5', amount: 600 }] }];
    const { lit, def } = both(raw);
    check('JN-Clean that cancels: the invoice still gets its spend added back (1,000) under both rules, identical results', near(def.ar[0].netTotal, 1000) && near(lit.ar[0].netTotal, 1000) && def.ar[0].gap === 0 && lit.ar[0].gap === 0);
  }
  // (6) past-date snapshot: kept contacts get no add-back and the ledger is the Statement
  {
    const raw = mk();
    raw.activeCustomers = [cust('CC', 400000, 0)];
    raw.invoices = [{ invoice_id: 'I1', customer_id: 'CC', date: '2026-01-10', due_date: '2026-03-01', status: 'sent', total: 1000000, balance: 400000 }] as typeof raw.invoices;
    raw.jnClean = [{ journal_id: 'M3', entry_number: 'JN-Clean-3', journal_date: '2026-03-31', lines: [jline('CC', 'debit', 600000, 'OCA'), jline('CC', 'credit', 600000, 'AR1')], applications: [{ kind: 'invoice', doc_id: 'I1', amount: 600000 }] }];
    const snap = { asOf: '2026-08-31', source: 'report-snapshot' as const, customers: new Map([['CC', 700000]]), vendors: new Map<string, number>() };
    const hist = computeARDetail(raw, '2026-08-31', { ledger: snap, historical: true })[0];
    check('past-date snapshot: kept contact\'s ledger for that day is the Statement figure (7,00,000), not reduced by the JN net', near(hist.netTotal, 700000) && near(hist.ledgerTotal ?? NaN, 700000), `${hist.netTotal}`);
  }
}

// =====================================================================
// Edge cases of the JN-Clean rule
// =====================================================================
console.log('\n--- JN-Clean rule edge cases ---');
{
  const raw = emptyRaw('2026-10-05T08:00:00Z');
  raw.activeCustomers = [{ contact_id: 'C9', contact_name: 'Customer with uneven JN', contact_type: 'customer', status: 'active', outstanding_receivable_amount: 1000000, unused_credits_receivable_amount: 0 }];
  raw.activeVendors = [{ contact_id: 'V9', contact_name: 'Vendor with uneven JN', contact_type: 'vendor', status: 'active', outstanding_payable_amount: 500000, unused_credits_payable_amount: 0 }];
  raw.jnClean = [
    { journal_id: 'X1', entry_number: 'JN-Clean-9', journal_date: '2026-03-31', lines: [jline('C9', 'debit', 39810), jline('C9', 'credit', 108800)], applications: [] },
    { journal_id: 'X2', entry_number: 'JN-Clean-10', journal_date: '2026-03-31', lines: [jline('V9', 'debit', 108800), jline('V9', 'credit', 39810)], applications: [] },
  ];
  const l = ledgerFromContacts(raw);
  process.env.JN_CLEAN_RULE = 'literal';
  const c = computeARDetail(raw, '2026-10-05', { ledger: l })[0];
  const v = computeAPDetail(raw, '2026-10-05', { ledger: l })[0];
  delete process.env.JN_CLEAN_RULE;
  check('Customer where JN-Clean does NOT cancel (JN_CLEAN_RULE=literal): ledger with its rows excluded literally = 1,000,000 + 68,990, and it is flagged', near(c.ledgerTotal ?? NaN, 1068990) && c.gap !== 0, inr(c.ledgerTotal ?? NaN));
  check('Vendor where JN-Clean does NOT cancel (JN_CLEAN_RULE=literal): excluded with the opposite sign = 500,000 + 68,990, and it is flagged', near(v.ledgerTotal ?? NaN, 568990) && v.gap !== 0, inr(v.ledgerTotal ?? NaN));
  const cKeep = computeARDetail(raw, '2026-10-05', { ledger: l })[0];
  const vKeep = computeAPDetail(raw, '2026-10-05', { ledger: l })[0];
  check('same two contacts under the default rule: the ledger is the Statement as it is (1,000,000 and 500,000)', near(cKeep.ledgerTotal ?? NaN, 1000000) && near(vKeep.ledgerTotal ?? NaN, 500000), `${inr(cKeep.ledgerTotal ?? NaN)} / ${inr(vKeep.ledgerTotal ?? NaN)}`);
  check('A contact the documents say is ~0 but the ledger says is not still appears in the listing (cannot hide)', computeARSummary(raw, '2026-10-05', { ledger: l }).customers.some((x) => x.customerId === 'C9'));
  const rec = reconcile(raw, '2026-10-05', l);
  check('reconcile reports the 2 non-cancelling contacts', rec.jnClean.contactsWhereJNDoesNotCancel === 2, String(rec.jnClean.contactsWhereJNDoesNotCancel));
  const he = rec.jnClean.headlineEffectOfTheRule;
  check('headline effect: both uneven contacts stay positive, so the literal rule would add Rs 68,990 to each of Debtors and Creditors against the raw Statements', !!he && he.customers.literalRuleWouldAdd === 68990 && he.vendors.literalRuleWouldAdd === 68990 && he.customers.contactsWhoseBalanceWouldChangeSide === 0, JSON.stringify(he));
  // a contact like "Rays Rooftop SPV (inv)": Statement -49,50,000 (an advance), one lone JN-Clean debit of 64,44,000 -> the rule makes it a Rs 14,94,000 creditor
  const rawFlip = emptyRaw('2026-10-05T08:00:00Z');
  rawFlip.activeVendors = [{ contact_id: 'RS', contact_name: 'Rooftop-like', contact_type: 'vendor', status: 'active', outstanding_payable_amount: 0, unused_credits_payable_amount: 4950000 }];
  rawFlip.jnClean = [{ journal_id: 'F1', entry_number: 'JN-Clean-77', journal_date: '2026-03-31', lines: [jline('RS', 'debit', 6444000)], applications: [] }];
  const lf = ledgerFromContacts(rawFlip);
  const recFlip = reconcile(rawFlip, '2026-10-05', lf, { jnAll: true });
  const nc = recFlip.jnClean.nonCancelling[0] as { statementBalance?: number; literalRuleBalance?: number; dashboardBalance?: number; changesSide?: boolean };
  check('contact whose balance would change side: Statement -49,50,000, literal rule +14,94,000, dashboard (default rule) -49,50,000 = the Statement; counted in the headline effect (the literal rule would add +14,94,000 to Creditors)', nc?.statementBalance === -4950000 && nc.literalRuleBalance === 1494000 && nc.dashboardBalance === -4950000 && nc.changesSide === true && recFlip.jnClean.headlineEffectOfTheRule?.vendors.literalRuleWouldAdd === 1494000 && recFlip.jnClean.headlineEffectOfTheRule.vendors.contactsWhoseBalanceWouldChangeSide === 1, JSON.stringify(nc));
  check('?jn=1 lists every non-cancelling contact (default lists the top 10)', recFlip.jnClean.nonCancelling.length === 1 && reconcile(rawFlip, '2026-10-05', lf).jnClean.nonCancelling.length === 1 && reconcile(raw, '2026-10-05', l, { jnAll: true }).jnClean.nonCancelling.length === 2);
}
{
  const raw = emptyRaw('2026-10-05T08:00:00Z');
  raw.activeCustomers = [{ contact_id: 'C8', contact_name: 'No ledger fields', contact_type: 'customer', status: 'active' }];
  raw.invoices = [{ invoice_id: 'I8', customer_id: 'C8', date: '2026-09-01', due_date: '2026-09-15', total: 500, balance: 500, status: 'sent' }];
  const r = computeARDetail(raw, '2026-10-05', { ledger: ledgerFromContacts(raw) })[0];
  check('Contact without ledger fields: total is the documents, no ledger figure, not flagged', r.ledgerTotal === undefined && r.netTotal === 500 && r.gap === 0);
}
check('IST cache day: 20:00 UTC on 5 Oct is already 6 Oct in India', cacheDay('2026-10-05T20:00:00Z') === '2026-10-06');

// =====================================================================
// PART B - the full pipeline against faked Zoho responses
// =====================================================================
console.log('\n--- Part B: fetch -> store -> calculate pipeline ---');
// Part B talks to a FAKED Zoho and a FAKED store. Make sure no real Redis keys are in the environment, whatever a script loaded earlier
// (a developer's .env.local holds the real ones) -- the test must never be able to reach the real cache.
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const junk = 'x'.repeat(40);
const contacts = [
  { contact_id: 'C1', contact_name: 'Wonder Test Cement', contact_type: 'customer', status: 'active', outstanding_receivable_amount: 46498061, unused_credits_receivable_amount: 0, junk },
  // C5: legacy contact whose whole balance is an opening balance (no invoice, bill or journal shows it)
  { contact_id: 'C5', contact_name: 'Legacy Opening Customer', contact_type: 'customer', status: 'active', outstanding_receivable_amount: 5000000, unused_credits_receivable_amount: 0, junk },
  { contact_id: 'C2', contact_name: 'Inactive Customer', contact_type: 'customer', status: 'inactive', junk },
  // C3: invoice I2 originally 12,00,000 (JN-Clean spent 2,00,000 so Zoho shows 10,00,000), TDS journal credit 17,978 unspent.
  // ledger = 10,00,000 (invoice) + 5,00,000 (JN debit leg) - (3,00,000 JN unspent + 17,978) = 11,82,022
  { contact_id: 'C3', contact_name: 'Jagdamba Test Mills', contact_type: 'customer', status: 'active', outstanding_receivable_amount: 1500000, unused_credits_receivable_amount: 317978, junk },
  { contact_id: 'V1', contact_name: 'Indian Customs EDI Gateway', contact_type: 'vendor', status: 'active', outstanding_payable_amount: 104118265, unused_credits_payable_amount: 104169031, junk },
  // V2 also has a USD 400 bill (rate 90 = Rs 36,000) and a USD 100 advance (rate 91 = Rs 9,100): the plain figures
  // cover rupee items only, the _bcy figures are the whole rupee balance
  // Its USD balance (400 bill - 100 advance = 300) sits in non_default_currency_values, which names the currency by id only.
  { contact_id: 'V2', contact_name: 'Abhishek Test Enterprises', contact_type: 'vendor', status: 'active', currency_id: 'CUR_INR', currency_code: 'INR', outstanding_payable_amount: 5000000, outstanding_payable_amount_bcy: 5036000, unused_credits_payable_amount: 0, unused_credits_payable_amount_bcy: 9100, non_default_currency_values: [{ currency_id: 'CUR_USD', outstanding_payable_amount: 400, unused_credits_payable_amount: 100 }], junk },
  { contact_id: 'V3', contact_name: 'Old Vendor', contact_type: 'vendor', status: 'inactive', junk },
  // V4: Xiamen. A USD journal (296) owes it Rs 1,30,735.48; it holds a Rs 1,26,302.89 advance and a Rs 4,432.59 debit journal: Statement Rs 0
  // Its own currency is USD (nothing owed in dollars); the rupee column holds the 4,432.59 SJ-1289 credit. Rupee balance Rs 0.
  { contact_id: 'V4', contact_name: 'Xiamen Test Ampace Ltd', contact_type: 'vendor', status: 'active', currency_id: 'CUR_USD', currency_code: 'USD', outstanding_payable_amount: 0, unused_credits_payable_amount: 0, outstanding_payable_amount_bcy: 126302.89, unused_credits_payable_amount_bcy: 126302.89, non_default_currency_values: [{ currency_id: 'CUR_INR', outstanding_payable_amount: 0, unused_credits_payable_amount: 4432.59 }], junk },
];
// scenario switched on near the end: contacts whose Zoho figures are read at different moments
let timing = false;
let vendorReportReads = 0;
const timingContacts = () => [
  // C6: the list shows a stale balance (Rs 1,00,000) but the invoice has moved to Rs 1,50,000 -- on a fresh read they agree
  { contact_id: 'C6', contact_name: 'Timing Noise Traders', contact_type: 'customer', status: 'active', outstanding_receivable_amount: 100000, unused_credits_receivable_amount: 0 },
  // C7: contact record says Rs 5,00,000, the invoice only Rs 4,00,000, and a fresh read says the same: a real gap
  { contact_id: 'C7', contact_name: 'Real Gap Industries', contact_type: 'customer', status: 'active', outstanding_receivable_amount: 500000, unused_credits_receivable_amount: 0 },
  // V5: contact record stale (Rs 50,000) while the bill is Rs 80,000; the vendor report only catches up on its second reading
  { contact_id: 'V5', contact_name: 'Timing Vendor Pvt', contact_type: 'vendor', status: 'active', outstanding_payable_amount: 50000, unused_credits_payable_amount: 0 },
];
const timingFresh: Record<string, Record<string, unknown>> = {
  C6: { contact_id: 'C6', contact_name: 'Timing Noise Traders', contact_type: 'customer', status: 'active', outstanding_receivable_amount: 150000, unused_credits_receivable_amount: 0, outstanding_ob_receivable_amount: 0, outstanding_ob_payable_amount: 0, opening_balances: [] },
  C7: { contact_id: 'C7', contact_name: 'Real Gap Industries', contact_type: 'customer', status: 'active', outstanding_receivable_amount: 500000, unused_credits_receivable_amount: 0, outstanding_ob_receivable_amount: 0, outstanding_ob_payable_amount: 0, opening_balances: [] },
  V5: { contact_id: 'V5', contact_name: 'Timing Vendor Pvt', contact_type: 'vendor', status: 'active', outstanding_payable_amount: 80000, unused_credits_payable_amount: 0, outstanding_ob_receivable_amount: 0, outstanding_ob_payable_amount: 0, opening_balances: [] },
};
const bills = [
  { bill_id: 'B1', vendor_id: 'V1', date: '2026-06-19', due_date: '2026-06-19', status: 'draft', total: 83695404, balance: 83695404, junk },
  { bill_id: 'B2', vendor_id: 'V2', date: '2026-07-20', due_date: '2026-07-20', status: 'open', total: 5000000, balance: 5000000, junk },
  { bill_id: 'B3', vendor_id: 'V2', date: '2026-08-01', due_date: '2026-08-01', status: 'open', currency_code: 'USD', exchange_rate: 90, total: 1000, balance: 400, junk },
];
const vendorpayments = [
  { payment_id: 'P1', vendor_id: 'V1', status: 'paid', date: '2026-03-09', amount: 6835757, balance: 6835757, junk },
  { payment_id: 'P2', vendor_id: 'V1', status: 'paid', date: '2026-03-23', amount: 35517772, balance: 35517772, junk },
  { payment_id: 'P3', vendor_id: 'V1', status: 'paid', date: '2026-05-25', amount: 61815502, balance: 61815502, junk },
  { payment_id: 'P4', vendor_id: 'V2', status: 'paid', date: '2026-09-01', currency_code: 'USD', exchange_rate: 91, amount: 100, balance: 100, bcy_amount: 9100, bcy_balance: 9100, junk },
  // the advance was paid in dollars: USD 1,398.47 at 90.31505 = Rs 1,26,302.89
  { payment_id: 'P5', vendor_id: 'V4', status: 'paid', date: '2026-08-01', currency_code: 'USD', exchange_rate: 90.31505, amount: 1398.47, balance: 1398.47, bcy_amount: 126302.89, bcy_balance: 126302.89, junk },
];
const invoices = [
  { invoice_id: 'I1', customer_id: 'C1', date: '2026-07-01', due_date: '2026-08-01', status: 'sent', total: 46498061, balance: 46498061, junk },
  { invoice_id: 'I2', customer_id: 'C3', date: '2026-08-01', due_date: '2026-09-01', status: 'sent', total: 1200000, balance: 1000000, junk },
];
const summaries = [
  ['J1', '2026-03-31', 'SJ-1', 'published', 6832949], ['J2', '2026-03-31', 'SJ-2', 'published', 35372406], ['J3', '2026-03-31', 'SJ-3', 'published', 148174],
  ['J4', '2026-05-30', 'SJ-4', 'published', 61764736], ['J5', '2026-09-21', 'SJ-1406', 'published', 17978],
  ['J6', '2026-03-31', 'JN-Clean-1', 'published', 500000], ['J7', '2026-09-01', 'SJ-9', 'draft', 999999], ['J8', '2026-03-31', 'JN-Clean-2', 'published', 0],
].map(([journal_id, journal_date, entry_number, status, total]) => ({ journal_id, journal_date, entry_number, reference_number: '', status, total, last_modified_time: 'a' }));
// Xiamen: journal 296 in USD (list row: face total vs rupee total differ) and the rupee journal SJ-1289
summaries.push(
  { journal_id: 'J9', journal_date: '2026-09-14', entry_number: '296', reference_number: '', status: 'published', total: 1398.47, bcy_total: 130735.48, currency_id: 'USD', last_modified_time: 'a' } as (typeof summaries)[number],
  { journal_id: 'J10', journal_date: '2026-09-20', entry_number: 'SJ-1289', reference_number: '', status: 'published', total: 4432.59, bcy_total: 4432.59, last_modified_time: 'a' } as (typeof summaries)[number]
);

const acctId = (name: string) => (/Receivable/i.test(name) ? 'AR1' : /Payable|Creditors/i.test(name) ? 'AP1' : 'EXP1');
const li = (id: string, contact: string, name: string, side: string, amount: number) => ({ line_id: id, account_id: acctId(name), customer_id: contact, account_name: name, debit_or_credit: side, amount });
const vendorJ = (id: string, amount: number, entry: string, date: string) => ({ journal_id: id, entry_number: entry, journal_date: date, status: 'published', line_items: [li(id + 'a', '', 'Expense', 'debit', amount), li(id + 'b', 'V1', 'Trade Payables', 'credit', amount)] });
const details: Record<string, unknown> = {
  J1: vendorJ('J1', 6832949, 'SJ-1', '2026-03-31'), J2: vendorJ('J2', 35372406, 'SJ-2', '2026-03-31'), J3: vendorJ('J3', 148174, 'SJ-3', '2026-03-31'), J4: vendorJ('J4', 61764736, 'SJ-4', '2026-05-30'),
  J5: { journal_id: 'J5', entry_number: 'SJ-1406', journal_date: '2026-09-21', status: 'published', available_receivables_credits: 17978, line_items: [li('J5a', '', 'TDS Receivable', 'debit', 17978), li('J5b', 'C3', 'Trade Receivables-Domestic', 'credit', 17978)] },
  // JN-Clean-1: credit on the old account, debit on the new one, 2,00,000 of the credit spent on invoice I2
  J6: {
    journal_id: 'J6', entry_number: 'JN-Clean-1', journal_date: '2026-03-31', status: 'published',
    line_items: [li('J6a', 'C3', 'Accounts Receivable', 'credit', 500000), li('J6b', 'C3', 'Trade Receivables-Domestic', 'debit', 500000)],
    invoices_credited: [{ invoice_id: 'I2', invoice_number: 'RPE/26-27/2', amount_applied: 200000, date: '2026-03-31' }],
    bills_credited: [],
  },
  J9: {
    journal_id: 'J9', entry_number: '296', journal_date: '2026-09-14', status: 'published', currency_code: 'USD', exchange_rate: 93.48465,
    available_payables_credits: 0,
    line_items: [
      { line_id: 'J9a', account_id: 'EXP1', customer_id: '', account_name: 'Expense', debit_or_credit: 'debit', amount: 1398.47, bcy_amount: 130735.48 },
      { line_id: 'J9b', account_id: 'AP1', customer_id: 'V4', account_name: 'Trade Payables', debit_or_credit: 'credit', amount: 1398.47, bcy_amount: 130735.48 },
    ],
  },
  J10: {
    journal_id: 'J10', entry_number: 'SJ-1289', journal_date: '2026-09-20', status: 'published', available_payables_credits: 4432.59,
    line_items: [li('J10a', 'V4', 'Trade Payables', 'debit', 4432.59), li('J10b', '', 'Expense', 'credit', 4432.59)],
  },
  J8: { journal_id: 'J8', entry_number: 'JN-Clean-2', journal_date: '2026-03-31', status: 'published', line_items: [li('J8a', '', 'Retained Earnings', 'debit', 10), li('J8b', '', 'Reserves', 'credit', 10)] },
};
const fetchedDetails: string[] = [];
const fetchedContacts: string[] = [];
let throttleCalls = 0;
let agingShape = true;
let reportMode: 'ids' | 'rejectSelect' | 'unmatched' | 'real' = 'ids';
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
const page = { has_more_page: false };
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname === 'accounts.test') return json({ access_token: 't', expires_in: 3600 });
  const path = url.pathname.replace('/books/v3', '');
  const q = url.searchParams;
  if (path === '/contacts') {
    let rows: Record<string, unknown>[] = contacts;
    // Real Zoho: filter_by=Status.Active makes it IGNORE contact_type
    if (q.get('filter_by') === 'Status.Active') rows = rows.filter((c) => c.status === 'active');
    else if (q.get('contact_type')) rows = rows.filter((c) => c.contact_type === q.get('contact_type'));
    if (timing) rows = [...rows, ...timingContacts().filter((c) => c.contact_type === q.get('contact_type'))];
    return json({ contacts: rows, page_context: page });
  }
  if (path === '/ok-probe') return json({ ok: 1 });
  const vpm = path.match(/^\/vendorpayments\/(\w+)$/);
  if (vpm) return json({ vendorpayment: { payment_id: vpm[1], exchange_rate: 1, balance_tax_amount_withheld: vpm[1] === 'PT' ? 10500 : 0 } });
  if (path === '/reports/aragingsummary') {
    if (!agingShape) return json({ code: 0, message: 'success', invoice: { group_list: [] }, page_context: { has_more_page: false } });
    return json({ code: 0, message: 'success', invoice: { group_list: [{ name: 'none', group_list: [
      { id: 'C1', total: 700, sent: 200, overdue: 500, entity: 'contact', intervals: [{ amount: 500, interval: 'days_1-30' }, { amount: 0, interval: 'days_above-180' }] },
      { id: 'C3', total: 90, sent: 0, overdue: 90, entity: 'contact', intervals: [{ amount: 0, interval: 'days_1-30' }, { amount: 90, interval: 'days_above-180' }] },
    ] }] }, page_context: { has_more_page: false } });
  }
  if (path === '/reports/customerbalancesummary') {
    return json({ code: 0, customerbalancesummary: [
      { customer_name: 'Timing Noise Traders', customer_id: 'C6', closing_balance: 150000 },
      { customer_name: 'Real Gap Industries', customer_id: 'C7', closing_balance: 500000 },
    ], page_context: { has_more_page: false } });
  }
  if (path === '/reports/vendorbalancesummary') {
    if (timing) {
      vendorReportReads += 1;
      // first reading (during the sync) is stale for V5; the re-check's reading sees the Rs 80,000
      return json({ code: 0, vendorbalancesummary: [
        { vendor_name: 'Abhishek Test Enterprises', vendor_id: 'V2', closing_balance: 5026900 },
        { vendor_name: 'Indian Customs EDI Gateway', vendor_id: 'V1', closing_balance: -50766 },
        { vendor_name: 'Timing Vendor Pvt', vendor_id: 'V5', closing_balance: vendorReportReads === 1 ? 50000 : 80000 },
      ], page_context: { has_more_page: false } });
    }
    // the real vendor report: default columns carry the NAME but no vendor id; the id only comes if asked for
    const sel = q.get('select_columns');
    if (reportMode === 'real') {
      // the shape Zoho really returned (from /api/debug/probe): ids present, but the rows sit inside an EXTRA wrapper array
      return json({ code: 0, message: 'success', vendorbalancesummary: [{ vendorbalancesummary: [
        { vendor_name: 'Abhishek Test Enterprises', vendor_id: 'V2', currency_id: '1', billed_amount: 1, amount_paid: 0, closing_balance: 5026900, non_default_currency_values: [], vendor: {} },
        { vendor_name: 'Indian Customs EDI Gateway', vendor_id: 'V1', currency_id: '1', billed_amount: 1, amount_paid: 0, closing_balance: -50766, non_default_currency_values: [], vendor: {} },
      ] }], page_context: { page: 1, per_page: 500, total: 2, has_more_page: false } });
    }
    if (sel && reportMode === 'rejectSelect') return new Response('{"code":4,"message":"Invalid value passed for select_columns"}', { status: 400 });
    const withId = Boolean(sel) && reportMode === 'ids';
    const nm = reportMode === 'unmatched' ? ['Nobody Known', 'Also Unknown'] : ['Abhishek Test Enterprises', 'Indian Customs EDI Gateway'];
    return json({ code: 0, vendorbalancesummary: [
      { vendor_name: nm[0], billed_amount: 1, amount_paid: 0, closing_balance: 5026900, ...(withId ? { vendor_id: 'V2' } : {}) },
      { vendor_name: nm[1], billed_amount: 1, amount_paid: 0, closing_balance: -50766, ...(withId ? { vendor_id: 'V1' } : {}) },
    ], page_context: { has_more_page: false } });
  }
  if (path === '/throttle-probe') {
    throttleCalls += 1;
    return throttleCalls < 3 ? new Response('{"code":45,"message":"You have made too many requests continuously. Please try after some time."}', { status: 429 }) : json({ ok: 1 });
  }
  if (path === '/chartofaccounts') {
    const want = q.get('account_id');
    if (want === 'BAD1') return new Response('boom', { status: 500 });
    const all = [{ account_id: 'AR1', account_name: 'Trade Receivables-Domestic', account_type: 'accounts_receivable' }, { account_id: 'AP1', account_name: 'Sundry Creditors- Others', account_type: 'accounts_payable' }, { account_id: 'EXP1', account_name: 'Expense', account_type: 'expense' }, { account_id: 'LOAN1', account_name: 'A Loan Account', account_type: 'other_current_asset' }];
    return json({ chartofaccounts: want ? all.filter((a) => a.account_id === want) : [], page_context: page });
  }
  const cm = path.match(/^\/contacts\/(\w+)$/);
  if (cm) {
    fetchedContacts.push(cm[1]);
    if (timing && timingFresh[cm[1]]) return json({ contact: timingFresh[cm[1]] });
    return json({ contact: cm[1] === 'C5' ? { contact_id: 'C5', outstanding_ob_receivable_amount: 5000000, outstanding_ob_payable_amount: 0, opening_balances: [{ ob_invoice_id: 'OB5' }] } : { contact_id: cm[1], outstanding_ob_receivable_amount: 0, outstanding_ob_payable_amount: 0, opening_balances: [] } });
  }
  if (path === '/invoices') {
    const all = timing ? [...invoices, { invoice_id: 'I3', customer_id: 'C6', date: '2026-09-01', due_date: '2026-10-01', status: 'sent', total: 150000, balance: 150000 }, { invoice_id: 'I4', customer_id: 'C7', date: '2026-09-01', due_date: '2026-10-01', status: 'sent', total: 400000, balance: 400000 }] : invoices;
    return json({ invoices: q.get('customer_id') ? all.filter((i) => i.customer_id === q.get('customer_id')) : all, page_context: page });
  }
  if (path === '/customerpayments') return json({ customerpayments: [], page_context: page });
  if (path === '/creditnotes') return json({ creditnotes: [], page_context: page });
  if (path === '/bills') {
    const all = timing ? [...bills, { bill_id: 'B5', vendor_id: 'V5', date: '2026-09-05', due_date: '2026-10-05', status: 'open', total: 80000, balance: 80000 }] : bills;
    return json({ bills: q.get('vendor_id') ? all.filter((b) => b.vendor_id === q.get('vendor_id')) : all, page_context: page });
  }
  if (path === '/vendorpayments') return json({ vendorpayments: q.get('vendor_id') ? vendorpayments.filter((p) => p.vendor_id === q.get('vendor_id')) : vendorpayments, page_context: page });
  if (path === '/vendorcredits') return json({ vendor_credits: [], page_context: page });
  if (path === '/journals') return json({ journals: summaries, page_context: page });
  const m = path.match(/^\/journals\/(\w+)$/);
  if (m) {
    fetchedDetails.push(m[1]);
    return json({ journal: details[m[1]] });
  }
  throw new Error('unmocked path ' + path);
}) as typeof fetch;

(async () => {
  const raw = await fetchAllRawData();
  const today = '2026-10-05';
  const rawNow: RawZohoData = { ...raw, fetchedAt: '2026-10-05T08:00:00Z' };
  const ledger = ledgerFromContacts(rawNow);

  check('customers and vendors are separate active lists', raw.activeCustomers.map((c) => c.contact_id).sort().join() === 'C1,C3,C5' && raw.activeVendors.map((c) => c.contact_id).join() === 'V1,V2,V4');
  check('contact ledger fields survive the fetch', raw.activeCustomers.find((c) => c.contact_id === 'C3')?.outstanding_receivable_amount === 1500000);
  check('JN-Clean journals are NOT mixed into ordinary journals', !raw.journals.some((j) => j.entry_number.startsWith('JN-Clean')));
  check('draft journal never fetched', !fetchedDetails.includes('J7'));
  check('JN-Clean journal with a customer line was read (2 lines, 1 application)', raw.jnClean?.length === 1 && raw.jnClean[0].lines.length === 2 && raw.jnClean[0].applications.length === 1, JSON.stringify(raw.jnCleanStats));
  check('JN-Clean journal without contacts is a marker only (not kept)', !raw.jnClean?.some((e) => e.entry_number === 'JN-Clean-2') && fetchedDetails.includes('J8'));
  check('application read from invoices_credited: Rs 2,00,000 on invoice I2', raw.jnClean?.[0].applications[0].doc_id === 'I2' && raw.jnClean?.[0].applications[0].amount === 200000);

  const ar = computeARSummary(rawNow, today, { ledger });
  const ap = computeAPSummary(rawNow, today, { ledger });
  const c1 = ar.customers.find((c) => c.customerId === 'C1');
  const c3 = ar.customers.find((c) => c.customerId === 'C3');
  check('account types looked up by id for the accounts used on contact-tagged lines: Receivable AR1, Payable AP1', raw.ledgerAccounts?.receivable.join() === 'AR1' && raw.ledgerAccounts?.payable.join() === 'AP1' && raw.accountTypeStats?.unknown === 0, JSON.stringify(raw.accountTypeStats));
  check('opening balance looked up ONLY for the one contact the documents could not explain', fetchedContacts.join() === 'C5' && raw.openingBalances?.C5?.receivable === 5000000 && raw.openingBalances?.C5?.docId === 'OB5', fetchedContacts.join());
  const c5 = ar.customers.find((c) => c.customerId === 'C5');
  check('C5: total Rs 50,00,000 from its opening balance, reconciled, aged >180 days', !!c5 && near(c5.netTotal, 5000000) && c5.gap === 0 && near(c5.more180, 5000000));
  check('C1 total (documents) = Rs 4,64,98,061 and matches the ledger', !!c1 && near(c1.netTotal, 46498061) && c1.gap === 0, c1 ? inr(c1.netTotal) : 'missing');
  check('C3 total (invoice I2 at Rs 12,00,000 incl. JN spend, less the Rs 17,978 TDS credit) = Rs 11,82,022 and matches the ledger', !!c3 && near(c3.netTotal, 1182022) && near(c3.agedTotal, 1200000) && near(c3.unappliedCredits, 17978) && c3.gap === 0, c3 ? `${inr(c3.netTotal)} / aged ${inr(c3.agedTotal)} / gap ${c3.gap}` : 'missing');
  check('inactive customer absent', !ar.customers.some((c) => c.customerId === 'C2'));
  check('AP: Indian Customs not listed (small credit); a vendor with a USD bill and a USD advance = rupee balance Rs 50,26,900, matching Zoho, no gap', !ap.vendors.some((v) => v.vendorId === 'V1') && near(ap.vendors.find((v) => v.vendorId === 'V2')?.netTotal ?? NaN, 5036000 - 9100));
  check('AR grand total = sum of the documents, and equals the ledger total', near(ar.grandTotal.netTotal, 46498061 + 1182022 + 5000000) && near(ar.ledgerGrandTotal ?? NaN, 46498061 + 1182022 + 5000000), inr(ar.grandTotal.netTotal));
  const v2 = ap.vendors.find((v) => v.vendorId === 'V2');
  check('foreign currency: USD 400 bill at 90 = Rs 36,000; USD 100 advance = Rs 9,100 (Zoho\'s own bcy figure); contact read in rupees', !!v2 && v2.gap === 0 && raw.bills.find((b) => b.bill_id === 'B3')?.balance === 36000 && raw.vendorPayments.find((p) => p.payment_id === 'P4')?.unused_amount === 9100 && raw.activeVendors.find((c) => c.contact_id === 'V2')?.outstanding_payable_amount === 5036000);
  check('no contacts flagged in the clean scenario', ar.unreconciledCount === 0 && ap.unreconciledCount === 0);

  // ---- custom From-To range: only documents dated From..To (inclusive), no ledger check, limits enforced
  const rng1 = computeARSummary(rawNow, today, { from: '2026-07-15' });
  const rngC3 = rng1.customers.find((c) => c.customerId === 'C3');
  check('range From 15 Jul: C1 (invoice 1 Jul) and C5 (opening balance, older) drop out; C3 (invoice 1 Aug) stays', !rng1.customers.some((c) => c.customerId === 'C1') && !rng1.customers.some((c) => c.customerId === 'C5') && !!rngC3);
  check('range keeps C3 at its invoice less its credit (Rs 11,82,022), nothing else changed', !!rngC3 && near(rngC3.netTotal, 1182022), rngC3 ? inr(rngC3.netTotal) : 'missing');
  check('range answer says so (fromDate) and has no ledger check to flag against', rng1.fromDate === '2026-07-15' && rng1.ledgerGrandTotal === undefined && rng1.unreconciledCount === 0 && rng1.customers.every((c) => c.ledgerTotal === undefined && c.gap === 0));
  check('range From is inclusive: an invoice dated exactly on From is counted', computeARSummary(rawNow, today, { from: '2026-07-01' }).customers.some((c) => c.customerId === 'C1'));
  check('range To is inclusive/respected: To 15 Jul leaves out the 1 Aug invoice (C3) but keeps C1', (() => { const r = computeARSummary(rawNow, '2026-07-15', { from: '2026-07-01' }); return r.customers.some((c) => c.customerId === 'C1') && !r.customers.some((c) => c.customerId === 'C3'); })());
  check('no From = exactly the ordinary figures (no fromDate, same totals)', computeARSummary(rawNow, today, { ledger }).fromDate === undefined && near(computeARSummary(rawNow, today, { ledger }).grandTotal.netTotal, ar.grandTotal.netTotal));
  const rngP1 = computeAPSummary(rawNow, today, { from: '2026-07-25' });
  const rngP1v2 = rngP1.vendors.find((v) => v.vendorId === 'V2');
  check('AP range From 25 Jul: V2 keeps only its 1 Aug bill (Rs 36,000), the 20 Jul bill drops out', !!rngP1v2 && near(rngP1v2.billedTotal, 36000) && rngP1.fromDate === '2026-07-25' && rngP1.ledgerGrandTotal === undefined, rngP1v2 ? inr(rngP1v2.billedTotal) : 'missing');
  check('AP range From 1 Jul keeps both V2 bills (Rs 50,36,000)', near(computeAPSummary(rawNow, today, { from: '2026-07-01' }).vendors.find((v) => v.vendorId === 'V2')?.billedTotal ?? NaN, 5036000));
  // the limits the page and the API both use
  check('first day of the books is 31 Mar 2025', ZB_EARLIEST_DATE === '2025-03-31');
  check('rangeFrom: a From on/before the first day of the books is no restriction (answered like a plain "up to this date")', rangeFrom('2025-03-31', today) === undefined && rangeFrom('2024-01-01', today) === undefined && rangeFrom('2020-05-05', today) === undefined);
  check('rangeFrom: a real From is kept; one after the To is pulled back to the To; junk is ignored', rangeFrom('2026-07-15', today) === '2026-07-15' && rangeFrom('2026-12-31', today) === today && rangeFrom('garbage', today) === undefined && rangeFrom(null, today) === undefined && rangeFrom('2026-02-30', today) === undefined);
  check('isISODate / clampISO', isISODate('2026-10-05') && !isISODate('2026-13-01') && !isISODate('05/10/2026') && clampISO('2019-01-01', ZB_EARLIEST_DATE, today) === ZB_EARLIEST_DATE && clampISO('2030-01-01', ZB_EARLIEST_DATE, today) === today && clampISO('2026-01-01', ZB_EARLIEST_DATE, today) === '2026-01-01');

  // foreign currency, read from Zoho's own figures through the real fetch
  const v2c = raw.activeVendors.find((c) => c.contact_id === 'V2');
  check('pipeline: the contact\'s balance in each currency survives the fetch -- USD 300 (the currency named only by id, resolved from the other rows) and Rs 50,00,000', v2c?.by_currency?.find((e) => e.currency === 'USD')?.net === 300 && v2c.by_currency.find((e) => e.currency === 'INR')?.net === 5000000, JSON.stringify(v2c?.by_currency));
  const b2 = raw.bills.find((b) => b.bill_id === 'B2');
  check('pipeline: a foreign bill keeps Zoho\'s rate and face amounts (USD 400 open of 1,000 at 90), so does the advance (91); a rupee bill gains nothing', JSON.stringify(raw.bills.find((b) => b.bill_id === 'B3')?.foreign) === JSON.stringify({ currency: 'USD', rate: 90, total: 1000, open: 400 }) && raw.vendorPayments.find((p) => p.payment_id === 'P4')?.foreign?.rate === 91 && !!b2 && !('foreign' in b2) && !raw.activeVendors.some((c) => c.contact_id === 'V1' && c.by_currency));
  const fcAll = foreignContacts(rawNow);
  const fV2 = fcAll.find((c) => c.contactId === 'V2');
  const fV4 = fcAll.find((c) => c.contactId === 'V4');
  check('foreign contacts from the fetched data: Abhishek = USD 300 open (bill USD 400 at 90, advance USD 100 at 91 = Rs 26,900), documents agree; Xiamen = dollars nil, Rs 4,432.59 residual explained by its own two documents', fcAll.length === 2 && fV2?.status === 'open' && fV2.foreignRupees === 26900 && fV2.currencies[0].zohoRate?.toFixed(4) === '89.6667' && fV2.currencies[0].documentsAgree === true && fV2.problems.length === 0 && fV4?.status === 'residual' && fV4.foreignRupees === 4432.59 && fV4.exchangeDifference === 0 && fV4.problems.length === 0, fcAll.map((c) => `${c.name}:${c.status}:${c.foreignRupees}:${c.problems.join(';')}`).join(' | '));
  const viaJson = foreignContacts(JSON.parse(JSON.stringify(rawNow)) as RawZohoData);
  check('the same answer after the cache round trip (JSON out and back)', JSON.stringify(viaJson) === JSON.stringify(fcAll));

  // past date with no snapshot: must say "unavailable", not pretend
  const past = await getLedgerFor('2026-09-30', rawNow);
  check('past date without a stored snapshot is reported as unavailable', past.basis === 'unavailable' && past.ledger === null);
  check('today resolves to the contact records', (await getLedgerFor(today, rawNow)).basis === 'current');

  // proof layer
  const rec = reconcile(rawNow, today, ledger);
  const fcs = rec.foreignCurrency.contacts;
  check('reconcile lists the foreign contacts from Zoho\'s own figures (1 with a dollar balance, 1 with a rupee residual), no problems, per-currency balances present', fcs.count === 2 && fcs.withAForeignBalance === 1 && fcs.withOnlyARupeeResidual === 1 && fcs.withProblems === 0 && fcs.perCurrencyBalancesInCache === 'yes', JSON.stringify({ n: fcs.count, o: fcs.withAForeignBalance, r: fcs.withOnlyARupeeResidual, p: fcs.withProblems }));
  const recOld = reconcile({ ...rawNow, activeVendors: rawNow.activeVendors.map(({ by_currency: _gone, ...rest }) => rest) }, today, ledger).foreignCurrency.contacts;
  check('reconcile on a cache without per-currency balances says so plainly instead of reporting a false all-clear', /sync-cache/.test(recOld.perCurrencyBalancesInCache));
  check('reconcile: customers all reconcile', rec.customers.flagged === 0 && rec.customers.reconciled === rec.customers.contactsWithABalance, `${rec.customers.reconciled}/${rec.customers.contactsWithABalance}`);
  const broken = { ...rawNow, jnClean: [] };
  const recBroken = reconcile(broken, today, ledger);
  check('reconcile: dropping the JN-Clean data makes C3 flagged: documents 9,82,022 vs ledger 11,82,022, gap Rs 2,00,000', recBroken.customers.flagged === 1 && recBroken.customers.biggestGaps[0].gap === 200000 && recBroken.customers.biggestGaps[0].documentsTotal === 982022, JSON.stringify(recBroken.customers.biggestGaps[0]));
  const bd = contactBreakdown(rawNow, today, ledger, 'jagdamba')[0];
  check('breakdown: shows the JN-Clean lines and the Rs 2,00,000 spent on the invoice', bd.jnClean.lines.length === 2 && bd.jnClean.spentOnDocuments === 200000);

  // two-way split used by the AR bank statement
  const mk = (due: string, amount: number): OpenItem => ({ kind: 'invoice', id: due, date: due, ageDate: due, amount, jnSpent: 0 });
  const two = splitAtEdge([mk('2026-10-20', 50), mk('2026-09-30', 100), mk('2026-07-01', 200), mk('2026-03-01', 300)], '2026-10-05', 180);
  check('AR <=180 / >180 split by days past due date', two.less === 350 && two.more === 300, `<180 ${two.less} >180 ${two.more}`);
  check('AP rows carry no age split (totals only, as before)', !('less180' in ap.vendors[0]) && !('more180' in ap.vendors[0]));

  // Zoho says "too many requests": wait and ask again instead of giving up
  const { zohoTry, getAccountInfoDetailed } = await import('../lib/zoho-client');
  const th = await zohoTry('/throttle-probe');
  check('a throttled call (429 "too many requests") is retried until it succeeds', th.ok && throttleCalls === 3, `${throttleCalls} attempts`);
  // pacing: never more than the allowed number of calls per window, even when fired all at once
  process.env.ZOHO_MAX_PER_MIN = '3';
  process.env.ZOHO_RATE_WINDOW_MS = '300';
  const t0 = Date.now();
  const burst = await Promise.all(Array.from({ length: 7 }, () => zohoTry('/ok-probe')));
  const took = Date.now() - t0;
  process.env.ZOHO_MAX_PER_MIN = '100000';
  delete process.env.ZOHO_RATE_WINDOW_MS;
  check('pacing: 7 calls at once with a budget of 3 per window are spread over 3 windows, all succeed', burst.every((b) => b.ok) && took >= 550, `${took} ms`);
  const bad = await getAccountInfoDetailed('BAD1');
  check('a hard failure is NOT retried and says why', !bad.info && /HTTP 500/.test(bad.reason ?? ''), bad.reason);

  // a failed account lookup is never turned into "this line does not count"
  const { syncAccountTypes } = await import('../lib/account-types');
  const part = await syncAccountTypes(['AR1', 'AP1', 'BAD1']);
  check('a failed account lookup is recorded as unknown and counted (never silently dropped)', part.ledgerAccounts.unknown?.join() === 'BAD1' && part.stats.unknown === 1);
  const { accountSets, lineHitsLedger } = await import('../lib/accounts');
  const sets = accountSets(part.ledgerAccounts);
  check('...an unknown account reaches both ledgers; a known loan account reaches neither', lineHitsLedger(sets, 'payable', 'BAD1') && lineHitsLedger(sets, 'receivable', 'BAD1') && !lineHitsLedger(sets, 'payable', 'LOAN1'));
  check('a half-known chart (receivable only) is treated as unknown, not as a filter', accountSets({ receivable: ['AR1'], payable: [] }) === null);

  // ---- vendor balance report: asks for the id column, falls back to names, and explains a failure
  const { fetchBalanceReport, nameIndex } = await import('../lib/ledger');
  const vNames = nameIndex(raw.activeVendors);
  reportMode = 'ids';
  const r1 = await fetchBalanceReport('vendor', '2026-09-30', vNames);
  check('vendor report: asks for the vendor id column and reads balances by id', r1.ok && r1.variant === 'with the vendor id column' && near(r1.balances.get('V2') ?? NaN, 5026900) && r1.matchedByName === 0, r1.ok ? r1.variant : 'failed');
  reportMode = 'rejectSelect';
  const r2 = await fetchBalanceReport('vendor', '2026-09-30', vNames);
  check('vendor report: if Zoho refuses the column request, falls back to matching by name', r2.ok && r2.matchedByName === 2 && near(r2.balances.get('V1') ?? NaN, -50766), r2.ok ? `${r2.variant}, ${r2.matchedByName} by name` : 'failed');
  reportMode = 'unmatched';
  const r3 = await fetchBalanceReport('vendor', '2026-09-30', vNames);
  check('vendor report: rows that cannot be tied to any contact are a clear failure, not an empty success', !r3.ok && r3.tried.some((x) => /none could be tied/.test(x.error)));
  reportMode = 'real';
  const r4 = await fetchBalanceReport('vendor', '2026-09-30', vNames);
  check('vendor report in the exact shape Zoho returns (rows inside an extra wrapper): read correctly', r4.ok && near(r4.balances.get('V2') ?? NaN, 5026900) && near(r4.balances.get('V1') ?? NaN, -50766) && r4.rowCount === 2, r4.ok ? `${r4.rowCount} rows` : JSON.stringify(r4.tried[0]?.error).slice(0, 80));
  reportMode = 'ids';
  check('report calibration: the report agrees with every contact record', (await import('../lib/ledger')).calibrate(r1.ok ? r1.balances : new Map(), ledger.vendors).agreement === 1);

  // ---- a PAST date with a stored snapshot: the snapshot is the total (documents cannot be summed back in time)
  const snap = { asOf: '2026-09-30', source: 'report-snapshot' as const, customers: new Map([['C1', 40000000], ['C3', 900000]]), vendors: new Map([['V2', 4000000]]) };
  const hist = computeARSummary(rawNow, '2026-09-30', { ledger: snap, historical: true });
  check('past date: customer totals ARE the snapshot (Rs 4,00,00,000 + Rs 9,00,000), unflagged', near(hist.grandTotal.netTotal, 40900000) && hist.unreconciledCount === 0, inr(hist.grandTotal.netTotal));
  const histAp = computeAPSummary(rawNow, '2026-09-30', { ledger: snap, historical: true });
  check('past date: vendor total is the snapshot (Rs 40,00,000)', near(histAp.grandTotal.netTotal, 4000000), inr(histAp.grandTotal.netTotal));
  const live = computeARSummary(rawNow, today, { ledger });
  check('today is unchanged by all this: still the sum of the documents', near(live.grandTotal.netTotal, ar.grandTotal.netTotal));

  // ---- one snapshot shared by every visitor for 24 hours: nothing that answers a page load may change it
  const deepFreeze = <T,>(o: T): T => {
    if (o && typeof o === 'object') {
      Object.freeze(o);
      for (const v of Object.values(o as Record<string, unknown>)) if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
    }
    return o;
  };
  const frozen = deepFreeze(JSON.parse(JSON.stringify(rawNow)) as RawZohoData);
  let touched = '';
  let frozenAnswers: string[] = [];
  try {
    const lf = ledgerFromContacts(frozen);
    frozenAnswers = [
      JSON.stringify(computeARSummary(frozen, today, { ledger: lf })),
      JSON.stringify(computeAPSummary(frozen, today, { ledger: lf })),
      JSON.stringify(reconcile(frozen, today, lf)),
      JSON.stringify(foreignContacts(frozen)),
      JSON.stringify((await getLedgerFor(today, frozen)).basis),
    ];
  } catch (e) {
    touched = String(e);
  }
  check('answering a page load never alters the shared snapshot (AR, AP, reconcile, foreign view all run on a frozen copy)', touched === '' && frozenAnswers.length === 5, touched.slice(0, 120));
  check('...and the frozen run gives the very same figures as the normal run', frozenAnswers[0] === JSON.stringify(computeARSummary(rawNow, today, { ledger })) && frozenAnswers[1] === JSON.stringify(computeAPSummary(rawNow, today, { ledger })));
  const { effectiveAsOf } = await import('../lib/ledger');
  const snapDay = cacheDay(rawNow.fetchedAt);
  check('a date after the snapshot day is answered as of the snapshot day; today and earlier dates are untouched', effectiveAsOf('2099-01-01', rawNow) === snapDay && effectiveAsOf(snapDay, rawNow) === snapDay && effectiveAsOf('2020-01-01', rawNow) === '2020-01-01', snapDay);

  const { topMismatches } = await import('../lib/ledger');
  const mm = topMismatches(new Map([['a', 100], ['b', 50], ['c', 10]]), new Map([['a', 100], ['b', 0], ['c', 12], ['d', 5]]), 1);
  check('mismatch listing: biggest disagreements first, matches ignored, a contact missing from the report counts as 0', mm.map((m) => m.id).join() === 'b,d,c' && mm[0].diff === 50, mm.map((m) => m.id + ':' + m.diff).join(' '));

  const agRes = await fetchArAging('2026-09-30');
  check('fetchArAging reads the report page(s) and returns per-customer rows', agRes.ok && agRes.rows.size === 2 && splitRow(agRes.rows.get('C1')!).less === 700 && splitRow(agRes.rows.get('C3')!).more === 90);
  agingShape = false;
  const agEmpty = await fetchArAging('2026-09-30');
  check('an aging response with no customers is a clear failure, not an empty success', !agEmpty.ok && agEmpty.tried.some((x) => /no customer rows/.test(x.error)));
  agingShape = true;

  // TDS lookup on payments with an unused balance (only those), and the vendor report taken as today's vendor ledger
  const { syncPaymentTds } = await import('../lib/payment-tds');
  const tdsRun = await syncPaymentTds([
    { payment_id: 'PT', vendor_id: 'V9', date: '2026-01-01', amount: 94500, unused_amount: 94500, status: 'paid' },
    { payment_id: 'PX', vendor_id: 'V9', date: '2026-01-02', amount: 500, unused_amount: 0, status: 'paid' },
  ]);
  check('TDS looked up only for payments with an unused balance; Rs 10,500 found on PT', tdsRun.stats.candidates === 1 && tdsRun.stats.withTds === 1 && tdsRun.tds.PT === 10500, JSON.stringify(tdsRun.stats));
  check('the fetch looked up TDS for every payment with an unused balance and took the vendor report as today\'s vendor ledger', raw.paymentTdsStats?.candidates === 5 && near(raw.vendorLedgerToday?.V2 ?? NaN, 5026900), `${raw.paymentTdsStats?.candidates} candidates, V2 ${raw.vendorLedgerToday?.V2}`);

  // helpers for the report parsing
  const rows = parseReportRows({ code: 0, customerbalancesummary: [{ customer_id: 'x', closing_balance: 5 }], page_context: {} });
  check('report parser finds the row array by closing_balance', rows?.key === 'customerbalancesummary' && rows.rows.length === 1);
  const cal = calibrate(new Map([['a', -100], ['b', -50]]), new Map([['a', 100], ['b', 50]]));
  check('report calibration detects an opposite sign convention', cal.sign === -1 && cal.agreement === 1);
  const unusual = extractJNEntry({ journal_id: 'Z', journal_date: '2026-03-31', entry_number: 'JN-Clean-5', line_items: [li('a', 'C1', 'AR', 'credit', 5)], bills_credited: [{ bill_id: 'B9', amount: 5 }], other_array: [1] });
  check('journal parser tolerates field-name variants (bill amount from "amount")', unusual?.applications[0]?.doc_id === 'B9' && unusual.applications[0].amount === 5);

  // ---- Xiamen through the whole pipeline: list row -> journal detail -> store -> calculator
  const j296 = raw.journals.find((j) => j.entry_number === '296');
  const xmLine = j296?.line_items.find((l) => l.contact_id === 'V4');
  check('Xiamen: journal 296 (USD) is stored at its rupee value Rs 1,30,735.48, keeping the USD face amount and the rate', !!j296 && xmLine?.amount === 130735.48 && xmLine.face_amount === 1398.47 && j296.currency_code === 'USD' && j296.exchange_rate === 93.48465 && j296.bcy_total === 130735.48, JSON.stringify(xmLine));
  check('Xiamen: the rupee journal SJ-1289 is NOT treated as foreign', !raw.journals.find((j) => j.entry_number === 'SJ-1289')?.currency_code);
  const xm = computeAPDetail(rawNow, today, { ledger }).find((r) => r.vendorId === 'V4');
  check('Xiamen: 1,30,735.48 - 4,432.59 - 1,26,302.89 = Rs 0.00, equal to Zoho\'s ledger, no flag', !!xm && Math.abs(xm.netTotal) < 0.01 && xm.gap === 0, xm ? xm.netTotal.toFixed(2) : 'missing');
  const fx = reconcile(rawNow, today, ledger).foreignCurrency;
  check('reconcile reports the foreign-currency journal, and its rupee debits equal the total Zoho itself shows', fx.journalsInForeignCurrency === 1 && fx.journalsWhoseRupeeTotalDiffersFromZoho === 0);
  const unconverted = { ...rawNow, journals: rawNow.journals.map((j) => (j.entry_number === '296' ? { ...j, line_items: j.line_items.map((l) => ({ ...l, amount: l.face_amount ?? l.amount })) } : j)) };
  const fxBad = reconcile(unconverted, today, ledger).foreignCurrency;
  check('self-check: if a foreign journal were ever read at its face amount again, reconcile says so (1 journal off its rupee total)', fxBad.journalsWhoseRupeeTotalDiffersFromZoho === 1 && fxBad.offTotalExamples[0]?.zohoRupeeTotal === 130735, JSON.stringify(fxBad.offTotalExamples[0]));
  const bdX = contactBreakdown(rawNow, today, ledger, 'xiamen')[0];
  const xl = bdX.ordinaryJournalLines.shown.find((l) => l.journal === '296');
  check('breakdown shows the foreign journal line with its USD face amount, rate and rupee value', !!xl && 'faceAmount' in xl && xl.faceAmount === 1398.47 && xl.currency === 'USD' && xl.rupees === 130735.48);

  // ---- the sync's own re-check of flagged contacts (timing noise vs real gap)
  timing = true;
  vendorReportReads = 0;
  const raw2 = await fetchAllRawData();
  const se = raw2.settleStats;
  check('re-check ran at the end of the sync: 3 contacts were flagged (stale balance on 2, one real gap), all 3 re-read, journals re-synced', se?.flaggedBefore === 3 && se.reread === 3 && se.journalsResynced === true, JSON.stringify(se && { f: se.flaggedBefore, r: se.reread, s: se.settled, p: se.persistent }));
  check('timing noise cleared: customer C6 (list was stale) and vendor V5 (contact record AND report were stale) settle; the cache now holds the fresh picture', se?.settled === 2 && !!se.settledNames.includes('Timing Noise Traders') && se.settledNames.includes('Timing Vendor Pvt'), se?.settledNames.join(', '));
  const ar2 = computeARDetail(raw2, today, { ledger: ledgerFromContacts({ ...raw2, fetchedAt: '2026-10-05T08:00:00Z' }) });
  const ap2 = computeAPDetail(raw2, today, { ledger: ledgerFromContacts({ ...raw2, fetchedAt: '2026-10-05T08:00:00Z' }) });
  check('C6 and V5 are no longer flagged and total what Zoho says now (Rs 1,50,000 and Rs 80,000)', ar2.find((r) => r.customerId === 'C6')?.gap === 0 && near(ar2.find((r) => r.customerId === 'C6')?.netTotal ?? NaN, 150000) && ap2.find((r) => r.vendorId === 'V5')?.gap === 0 && near(ap2.find((r) => r.vendorId === 'V5')?.netTotal ?? NaN, 80000));
  check('V5\'s vendor ledger is the FRESH report (80,000), not the stale one (50,000)', raw2.vendorLedgerToday?.V5 === 80000);
  check('a gap that is still there on the fresh read stays flagged (C7: documents Rs 4,00,000 vs Zoho Rs 5,00,000) and is listed', se?.persistent === 1 && se.persistentDetails[0]?.name === 'Real Gap Industries' && se.persistentDetails[0].documents === 400000 && se.persistentDetails[0].zohoLedger === 500000, JSON.stringify(se?.persistentDetails[0]));
  check('...and the balance report is asked who is right: it sides with the contact record, so our documents are what is missing something', se?.persistentDetails[0]?.reportAgrees === 'contact record' && se.persistentDetails[0].reportBalance === 500000);
  check('re-reading swaps documents, it does not duplicate them (no invoice, bill or payment appears twice; nothing of other contacts changed)', raw2.invoices.length === invoices.length + 2 && new Set(raw2.invoices.map((i) => i.invoice_id)).size === raw2.invoices.length && raw2.bills.length === bills.length + 1 && raw2.vendorPayments.length === vendorpayments.length && raw2.activeCustomers.length === raw.activeCustomers.length + 2 && raw2.activeVendors.length === raw.activeVendors.length + 1);
  check('reconcile shows the re-check result, and only the real gap remains flagged', reconcile({ ...raw2, fetchedAt: '2026-10-05T08:00:00Z' }, today, ledgerFromContacts({ ...raw2, fetchedAt: '2026-10-05T08:00:00Z' })).customers.flagged === 1);

  // ?reread=1 now uses the same fresh picture (including a fresh vendor report, never the cache's stale one)
  const staleCopy: RawZohoData = {
    ...raw,
    fetchedAt: '2026-10-05T08:00:00Z',
    activeCustomers: [...raw.activeCustomers, { contact_id: 'C6', contact_name: 'Timing Noise Traders', contact_type: 'customer', status: 'active', outstanding_receivable_amount: 100000, unused_credits_receivable_amount: 0 }, { contact_id: 'C7', contact_name: 'Real Gap Industries', contact_type: 'customer', status: 'active', outstanding_receivable_amount: 500000, unused_credits_receivable_amount: 0 }],
    activeVendors: [...raw.activeVendors, { contact_id: 'V5', contact_name: 'Timing Vendor Pvt', contact_type: 'vendor', status: 'active', outstanding_payable_amount: 50000, unused_credits_payable_amount: 0 }],
    invoices: [...raw.invoices, { invoice_id: 'I3', customer_id: 'C6', date: '2026-09-01', due_date: '2026-10-01', status: 'sent', total: 150000, balance: 150000 }, { invoice_id: 'I4', customer_id: 'C7', date: '2026-09-01', due_date: '2026-10-01', status: 'sent', total: 400000, balance: 400000 }] as typeof raw.invoices,
    bills: [...raw.bills, { bill_id: 'B5', vendor_id: 'V5', date: '2026-09-05', due_date: '2026-10-05', status: 'open', total: 80000, balance: 80000 }] as typeof raw.bills,
    vendorLedgerToday: { ...(raw.vendorLedgerToday ?? {}), V5: 50000 },
  };
  vendorReportReads = 1; // the next reading is the fresh one
  const { rereadFlagged } = await import('../lib/reconcile');
  const rr = await rereadFlagged(staleCopy, today, ledgerFromContacts(staleCopy));
  const byName = Object.fromEntries(rr.map((x) => [x.name, x]));
  check('?reread=1: stale C6 and V5 clear (V5 from the fresh vendor report), C7 persists', byName['Timing Noise Traders']?.gapAfter === 0 && byName['Timing Vendor Pvt']?.gapAfter === 0 && byName['Timing Vendor Pvt']?.vendorLedgerFrom === 'fresh vendor balance report' && byName['Real Gap Industries']?.gapAfter !== 0, JSON.stringify(rr.map((x) => [x.name, 'gapAfter' in x ? x.gapAfter : 'err'])));
  timing = false;

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('selftest crashed:', e);
  process.exit(2);
});

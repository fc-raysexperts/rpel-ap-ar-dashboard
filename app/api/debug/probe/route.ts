import { NextResponse } from 'next/server';
import { listJournalSummaries, getJournalDetailRaw, isJNCleanJournal, zohoTry, getAccountInfo } from '@/lib/zoho-client';
import { extractJNEntry } from '@/lib/jn-clean';
import { getCachedRawData } from '@/lib/cache';
import { ledgerFromContacts, fetchBalanceReport, calibrate, parseReportRows } from '@/lib/ledger';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// One-time diagnostic for the two things that cannot be confirmed without a
// live call:
//   1. what Zoho records on a JN-Clean journal about the invoices/bills its
//      credit was spent on (needed for the AR age buckets), and
//   2. where Zoho's customer / vendor balance reports live and whether they
//      reproduce the balances on the contact records (needed for past dates).
// Open /api/debug/probe in the browser; the "summary" block at the top is
// the part to send back.

const KNOWN = {
  // From the official Statements: JN-Clean credit spent on Wonder's invoice 627,
  // and on Abhishek Enterprises' bills (31 Mar, then 12 May).
  wonder: [37381390],
  abhishek: [666000, 748800, 593550, 465450, 770400, 620600],
};

function scalars(o: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!o || typeof o !== 'object') return out;
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = typeof v === 'string' ? v.slice(0, 60) : v;
  }
  return out;
}

async function describeJournal(entryNumber: string) {
  const summaries = await listJournalSummaries();
  const target = summaries.find((j) => j.entry_number === entryNumber);
  if (!target) return { entryNumber, found: false as const };
  const raw = await getJournalDetailRaw(target.journal_id);
  const arrays = Object.entries(raw)
    .filter(([k, v]) => Array.isArray(v) && k !== 'line_items')
    .map(([k, v]) => {
      const arr = v as unknown[];
      return { key: k, length: arr.length, firstItem: arr.length ? scalars(arr[0]) : null };
    });
  const lineItems = Array.isArray(raw.line_items) ? (raw.line_items as Record<string, unknown>[]) : [];
  const parsed = extractJNEntry({ ...raw, journal_id: target.journal_id });
  const amounts = (parsed?.applications ?? []).map((a) => a.amount);
  return {
    entryNumber,
    found: true as const,
    topLevelKeys: Object.keys(raw),
    lineItemCount: lineItems.length,
    contactTaggedLines: lineItems.filter((l) => l.customer_id).length,
    firstLineKeys: lineItems[0] ? Object.keys(lineItems[0]) : [],
    otherArrays: arrays,
    parsed: {
      contactLines: parsed?.lines.length ?? 0,
      applications: parsed?.applications.length ?? 0,
      applicationsTotal: Math.round(amounts.reduce((s, a) => s + a, 0)),
      firstApplications: (parsed?.applications ?? []).slice(0, 3),
    },
    amounts,
  };
}

async function probeReport(kind: 'customer' | 'vendor', today: string) {
  const names =
    kind === 'customer'
      ? [process.env.ZOHO_REPORT_PATH_CUSTOMER, 'customerbalancesummary', 'customerbalances', 'customer_balance_summary']
      : [process.env.ZOHO_REPORT_PATH_VENDOR, 'vendorbalancesummary', 'vendorbalances', 'vendor_balance_summary'];
  const attempts = [];
  for (const n of names.filter((x): x is string => Boolean(x))) {
    const res = await zohoTry(`/reports/${n}`, {
      filter_by: 'TransactionDate.CustomDate',
      from_date: `${Number(today.slice(5, 7)) >= 4 ? today.slice(0, 4) : Number(today.slice(0, 4)) - 1}-04-01`,
      to_date: today,
      per_page: 3,
      response_option: 1,
      usestate: 'false',
    });
    if (!res.ok) {
      attempts.push({ path: `/reports/${n}`, ok: false, status: res.status, error: res.error.slice(0, 140) });
      continue;
    }
    const parsed = parseReportRows(res.body);
    attempts.push({
      path: `/reports/${n}`,
      ok: Boolean(parsed),
      status: res.status,
      rowsKey: parsed?.key ?? null,
      sampleRow: parsed ? scalars(parsed.rows[0]) : null,
      topLevelKeys: Object.keys(res.body),
      ...(parsed
        ? {}
        : {
            zohoCode: res.body.code,
            zohoMessage: res.body.message,
            bodyPreview: JSON.stringify(res.body).slice(0, 900),
          }),
    });
    if (parsed) break;
  }
  return attempts;
}

export async function GET() {
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const details: Record<string, unknown> = {};

  // ---------- 1. JN-Clean journals ----------
  let jnSummary: Record<string, unknown> = {};
  try {
    const all = await listJournalSummaries();
    const jnCount = all.filter((j) => isJNCleanJournal(j)).length;
    const [wonderJ, abhishekJ] = await Promise.all([describeJournal('JN-Clean-1'), describeJournal('JN-Clean-301')]);
    details.jnClean = { jnJournalsFound: jnCount, 'JN-Clean-1 (customers)': wonderJ, 'JN-Clean-301 (vendors)': abhishekJ };
    const amtsW = wonderJ.found ? wonderJ.amounts : [];
    const amtsA = abhishekJ.found ? abhishekJ.amounts : [];
    jnSummary = {
      jnJournalsFound: jnCount,
      customerJournalApplications: wonderJ.found ? wonderJ.parsed.applications : 'journal not found',
      vendorJournalApplications: abhishekJ.found ? abhishekJ.parsed.applications : 'journal not found',
      wonderSpendFoundInData: KNOWN.wonder.every((a) => amtsW.some((x) => Math.abs(x - a) < 1)),
      abhishekAmountsFoundInData: KNOWN.abhishek.filter((a) => amtsA.some((x) => Math.abs(x - a) < 1)),
      abhishekAmountsExpected: KNOWN.abhishek,
    };
  } catch (e) {
    details.jnClean = { error: e instanceof Error ? e.message : String(e) };
    jnSummary = { error: 'JN-Clean probe failed -- see details.jnClean' };
  }

  // ---------- 2. balance reports ----------
  let repSummary: Record<string, unknown> = {};
  try {
    const [cAtt, vAtt] = await Promise.all([probeReport('customer', today), probeReport('vendor', today)]);
    details.reports = { customer: cAtt, vendor: vAtt };
    const raw = await getCachedRawData();
    const contacts = raw ? ledgerFromContacts(raw) : null;
    const [cRep, vRep] = await Promise.all([fetchBalanceReport('customer', today), fetchBalanceReport('vendor', today)]);
    const cCal = contacts && cRep.ok ? calibrate(cRep.balances, contacts.customers) : null;
    const vCal = contacts && vRep.ok ? calibrate(vRep.balances, contacts.vendors) : null;
    repSummary = {
      customerReportPath: cRep.ok ? cRep.path : null,
      customerRows: cRep.ok ? cRep.rowCount : (cRep.tried.map((t) => `${t.path}: ${t.status}`) as unknown),
      customerAgreesWithContactRecords: cCal ? `${cCal.plus} of ${cCal.total} contacts (${Math.round(cCal.agreement * 100)}%)` : 'not checked (no cache or report failed)',
      vendorReportPath: vRep.ok ? vRep.path : null,
      vendorRows: vRep.ok ? vRep.rowCount : (vRep.tried.map((t) => `${t.path}: ${t.status}`) as unknown),
      vendorAgreesWithContactRecords: vCal
        ? `${Math.max(vCal.plus, vCal.minus)} of ${vCal.total} contacts (${Math.round(vCal.agreement * 100)}%)${vCal.sign === -1 ? ' -- sign is OPPOSITE (handled automatically)' : ''}`
        : 'not checked (no cache or report failed)',
    };
  } catch (e) {
    details.reports = { error: e instanceof Error ? e.message : String(e) };
    repSummary = { error: 'report probe failed -- see details.reports' };
  }

  // ---------- 3. account types (which accounts reach a contact's ledger) ----------
  // Three accounts whose type is known for certain, so this shows the lookup works.
  let accSummary: Record<string, unknown> = {};
  try {
    const checks = [
      { id: '2346113000026786417', expect: 'accounts_payable', what: 'Sundry Creditors- Others (child account)' },
      { id: '2346113000004358223', expect: 'accounts_payable', what: 'Creditors for Purchase (inactive account)' },
      { id: '2346113000013974235', expect: 'other_current_asset', what: 'Abhilasha Goswami loan account' },
    ];
    const results = [];
    for (const c of checks) {
      const info = await getAccountInfo(c.id);
      results.push({ what: c.what, expected: c.expect, got: info?.account_type ?? null, ok: info?.account_type === c.expect });
    }
    details.accounts = results;
    accSummary = { lookupByIdWorks: results.every((x) => x.ok), results: results.map((x) => `${x.what}: ${x.got ?? 'NOT FOUND'}`) };
  } catch (e) {
    details.accounts = { error: e instanceof Error ? e.message : String(e) };
    accSummary = { error: 'account probe failed -- see details.accounts' };
  }

  return NextResponse.json({ summary: { today, jnClean: jnSummary, reports: repSummary, accounts: accSummary }, details });
}

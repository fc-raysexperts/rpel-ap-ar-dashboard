// Run with: npm run sync-ledger -- 2026-09-30 [2026-08-31 ...]
//
// Stores Zoho's own ledger balance (the Statement balance) for every customer
// and vendor as of each date given, so the dashboard can show correct TOTALS
// for past period-ends. Needs a populated cache first (npm run sync-cache),
// because today's contact records are used to confirm each report is being
// read correctly before anything is stored.
//
// How it stays honest: it first reads each report for TODAY and compares every
// contact against the balance on its contact record. A side whose report does
// not agree (or cannot be read) is NOT stored, and the output says exactly what
// Zoho returned -- so a failure here is something to copy and send, not a mystery.

import { config } from 'dotenv';
config({ path: '.env.local' });

import { getCachedRawData } from '../lib/cache';
import { fetchArAging, saveAging } from '../lib/aging';
import { computeARDetail, chooseAgingOpeningBasis } from '../lib/ar-calculator';
import { ledgerFromContacts, cacheDay, fetchBalanceReport, calibrate, saveLedgerSnapshot, nameIndex, topMismatches, type ReportFetch, type ReportFail } from '../lib/ledger';

const inr = (n: number) => Math.round(n).toLocaleString('en-IN');

function printMismatches(label: string, rows: ReturnType<typeof topMismatches>, people: { contact_id: string; contact_name: string }[]) {
  const names = new Map(people.map((p) => [p.contact_id, p.contact_name]));
  console.log(`    ${label} where the report and the contact record differ (biggest first):`);
  for (const r of rows) {
    console.log(`      ${(names.get(r.id) ?? r.id).slice(0, 50).padEnd(50)} report Rs ${inr(r.report).padStart(14)}   contact record Rs ${inr(r.contact).padStart(14)}   difference Rs ${inr(r.diff)}`);
  }
}

function explainFailure(label: string, rep: ReportFail) {
  console.error(`\nCould not read the ${label} balance report. What was tried and what Zoho said:`);
  for (const t of rep.tried) console.error(`  ${t.path} [${t.variant}] -> HTTP ${t.status}: ${t.error.slice(0, 700)}`);
}

async function main() {
  const dates = process.argv.slice(2).filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
  if (dates.length === 0) {
    console.error('Give at least one date, e.g.  npm run sync-ledger -- 2026-09-30');
    process.exit(1);
  }
  const raw = await getCachedRawData();
  if (!raw) {
    console.error('No cache yet. Run npm run sync-cache first.');
    process.exit(1);
  }
  // The report is checked against a DIFFERENT source: the raw contact records (vendors: plus the TDS read from
  // each payment's own record), never against the vendor report the cache already holds.
  const contacts = ledgerFromContacts(raw, { contactRecordsOnly: true });
  const today = cacheDay(raw.fetchedAt);
  const customerNames = nameIndex(raw.activeCustomers);
  const vendorNames = nameIndex(raw.activeVendors);

  console.log(`Checking the balance reports against contact records for ${today} first...`);
  const [cRep, vRep] = await Promise.all([
    fetchBalanceReport('customer', today, customerNames),
    fetchBalanceReport('vendor', today, vendorNames),
  ]);

  let customers: ReportFetch | null = null;
  let vendors: ReportFetch | null = null;
  let vendorSign: 1 | -1 = 1;

  if (cRep.ok) {
    const cal = calibrate(cRep.balances, contacts.customers);
    console.log(`  customers: ${cal.plus}/${cal.total} contacts agree with their contact record (${cRep.path}, ${cRep.variant})`);
    if (cal.total > cal.plus) printMismatches('customers', topMismatches(cRep.balances, contacts.customers, 1), raw.activeCustomers);
    if (cal.agreement >= 0.8) customers = cRep;
    else console.error('  customers: agreement too low (need 80%+), not stored.');
  } else explainFailure('customer', cRep);

  if (vRep.ok) {
    const cal = calibrate(vRep.balances, contacts.vendors);
    console.log(`  vendors  : ${Math.max(cal.plus, cal.minus)}/${cal.total} agree${cal.sign === -1 ? ' (report shows vendor balances with the opposite sign; corrected)' : ''} (${vRep.path}, ${vRep.variant}${vRep.matchedByName ? `, ${vRep.matchedByName} rows matched by name` : ''})`);
    if (cal.total > Math.max(cal.plus, cal.minus)) printMismatches('vendors', topMismatches(vRep.balances, contacts.vendors, cal.sign), raw.activeVendors);
    if (cal.agreement >= 0.8) {
      vendors = vRep;
      vendorSign = cal.sign;
    } else console.error('  vendors: agreement too low (need 80%+), not stored.');
  } else explainFailure('vendor', vRep);

  if (!customers && !vendors) {
    console.error('\nNothing could be verified, so nothing was stored. Copy everything above and send it to Claude.');
    process.exit(1);
  }
  console.log(`  OK for: ${[customers && 'customers', vendors && 'vendors'].filter(Boolean).join(' and ')}.\n`);

  for (const asOf of dates) {
    const [c, v] = await Promise.all([
      customers ? fetchBalanceReport('customer', asOf, customerNames) : Promise.resolve(null),
      vendors ? fetchBalanceReport('vendor', asOf, vendorNames) : Promise.resolve(null),
    ]);
    const cMap = c && c.ok ? c.balances : new Map<string, number>();
    const vMap = v && v.ok ? new Map([...v.balances].map(([id, b]) => [id, b * vendorSign] as [string, number])) : new Map<string, number>();
    if (cMap.size === 0 && vMap.size === 0) {
      console.error(`${asOf}: no report data came back, skipped.`);
      continue;
    }
    await saveLedgerSnapshot(asOf, cMap, vMap, {
      customerPath: customers?.path ?? '',
      vendorPath: vendors?.path ?? '',
      vendorSign,
    });
    const pos = (m: Map<string, number>) => [...m.values()].filter((x) => x > 1).reduce((s, x) => s + x, 0);
    console.log(
      `${asOf}: stored ${cMap.size} customers (positive balances Rs ${inr(pos(cMap))}) and ${vMap.size} vendors (Rs ${inr(pos(vMap))})` +
        (cMap.size === 0 ? '  [customers NOT available]' : '') +
        (vMap.size === 0 ? '  [vendors NOT available]' : '')
    );

    // exact age buckets for the day: Zoho's aging report as of that date
    if (cMap.size > 0) {
      const ag = await fetchArAging(asOf);
      if (!ag.ok) {
        console.error(`  ${asOf}: could not read Zoho's AR aging report, so the <180/>180 split stays approximate. What Zoho said:`);
        for (const t of ag.tried) console.error(`    ${t.path} -> HTTP ${t.status}: ${t.error.slice(0, 600)}`);
        continue;
      }
      const snapLedger = { asOf, source: 'report-snapshot' as const, customers: cMap, vendors: vMap };
      const choice = chooseAgingOpeningBasis(raw, asOf, snapLedger, ag.rows);
      await saveAging({ asOf, rows: ag.rows, includesOpening: choice.includesOpening });
      const rows = computeARDetail(raw, asOf, { ledger: snapLedger, historical: true, aging: { asOf, rows: ag.rows, includesOpening: choice.includesOpening } });
      const flagged = rows.filter((r) => r.gap !== 0).sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
      const withBalance = rows.filter((r) => r.netTotal > 1).length;
      const sum = (f: (r: (typeof rows)[number]) => number) => rows.filter((r) => r.netTotal > 1).reduce((s, r) => s + f(r), 0);
      console.log(`  ${asOf}: Zoho's aging report read (${ag.path}): ${ag.rows.size} customers.`);
      console.log(`    opening balances ${choice.includesOpening ? 'ARE' : 'are NOT'} part of that report (mismatch on opening-balance customers if assumed in: Rs ${inr(choice.unexplainedIfIncluded)}, if not: Rs ${inr(choice.unexplainedIfNot)}).`);
      console.log(`    buckets: <=180 days Rs ${inr(sum((r) => r.less180))}   >180 days Rs ${inr(sum((r) => r.more180))}   derived credits Rs ${inr(sum((r) => r.unappliedCredits))}`);
      console.log(`    customers fully explained: ${withBalance - flagged.filter((r) => r.netTotal > 1).length} of ${withBalance}; not explained: ${flagged.length}${flagged.length ? ' (biggest first):' : ''}`);
      for (const r of flagged.slice(0, 8)) console.log(`      ${r.customerName.slice(0, 50).padEnd(50)} ledger Rs ${inr(r.netTotal).padStart(14)}   buckets explain Rs ${inr(r.agedTotal).padStart(14)}   short by Rs ${inr(r.gap)}`);
    }
  }
  console.log('\nDone. Pick one of these dates in the dashboard to see its totals.');
}

main().catch((e) => {
  console.error('\nFailed:', e);
  process.exit(1);
});

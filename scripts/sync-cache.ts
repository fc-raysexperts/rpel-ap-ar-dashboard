// Run with: npm run sync-cache
//
// One command, runs to completion unattended -- no repeated manual
// curling needed. The first run against an empty store fetches every
// journal once (about 2 minutes in practice), plus the ~670 JN-Clean
// journals once (a minute or two more); every later run only fetches what
// changed, so it takes well under a minute. Progress is logged as it goes. This is a plain Node
// script, not a Next.js API route, so it has no serverless timeout to
// worry about -- that's what makes running the whole thing in one
// unbroken pass possible here, unlike on Vercel (see lib/journal-job.ts
// for why production instead uses a chunked, cron-driven approach).
//
// This script is for LOCAL USE ONLY. Once deployed to Vercel, none of
// this is needed -- vercel.json's cron schedule makes Vercel's own
// infrastructure call /api/cron/refresh automatically every 5 minutes,
// forever, with no manual action from anyone ever again.

import { config } from 'dotenv';
config({ path: '.env.local' });

import { fetchAllRawData } from '../lib/zoho-raw-fetch';
import { setCachedRawData, isCacheConfigured } from '../lib/cache';
import { journalLinkageStats } from '../lib/journal-job';
import { ledgerFromContacts } from '../lib/ledger';
import { reconcile } from '../lib/reconcile';
import { foreignContacts, describeForeign } from '../lib/foreign';
import { auditVendors, auditCustomers } from '../lib/audit';

async function main() {
  if (!isCacheConfigured()) {
    console.error(
      'UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are not set in .env.local -- ' +
        'nothing to sync into. Add them first (see .env.local.example).'
    );
    process.exit(1);
  }

  console.log('Starting sync from Zoho Books.');
  console.log('First run on an empty store: every journal, then the JN-Clean journals, are');
  console.log('fetched once (a few minutes). After that only what changed is fetched.\n');

  const startedAt = Date.now();
  const raw = await fetchAllRawData();
  await setCachedRawData(raw);
  const totalMin = ((Date.now() - startedAt) / 60_000).toFixed(1);

  console.log(`\nDone in ${totalMin} minutes. Cached:`);
  console.log(`  ${raw.activeCustomers.length} customers, ${raw.activeVendors.length} vendors`);
  const inactiveKept = [...raw.activeCustomers, ...raw.activeVendors].filter((c) => String(c.status).toLowerCase() !== 'active');
  console.log(
    inactiveKept.length === 0
      ? '  Inactive contacts holding a balance: none (all inactive contacts are at zero).'
      : `  Inactive contacts that still hold a balance, included so the totals match Zoho: ${inactiveKept.length} -> ${inactiveKept
          .slice(0, 12)
          .map((c) => `${c.contact_name} (${c.contact_type})`)
          .join(', ')}`
  );
  console.log(`  ${raw.invoices.length} invoices, ${raw.bills.length} bills`);
  console.log(`  ${raw.customerPayments.length} customer payments, ${raw.vendorPayments.length} vendor payments`);
  console.log(`  ${raw.creditNotes.length} credit notes, ${raw.vendorCredits.length} vendor credits`);
  console.log(`  ${raw.journals.length} relevant journals (${raw.journals.filter((j) => j.currency_code).length} in a foreign currency, counted at their rupee value)`);

  // Self-check: are journal lines actually linked to the right contacts?
  const link = journalLinkageStats(raw.journals);
  const custIds = new Set(raw.activeCustomers.map((c) => c.contact_id));
  const vendIds = new Set(raw.activeVendors.map((c) => c.contact_id));
  let toCustomers = 0;
  let toVendors = 0;
  for (const j of raw.journals) {
    for (const l of j.line_items) {
      if (!l.contact_id) continue;
      if (custIds.has(l.contact_id)) toCustomers += 1;
      else if (vendIds.has(l.contact_id)) toVendors += 1;
    }
  }
  console.log('\nJournal linkage check:');
  console.log(`  ${link.lines} journal lines, ${link.linesWithContact} linked to a contact`);
  console.log(`  of those: ${toCustomers} to active customers, ${toVendors} to active vendors, ${link.linesWithContact - toCustomers - toVendors} to other/inactive contacts`);
  if (raw.activeCustomers.some((c) => vendIds.has(c.contact_id))) {
    console.log('  WARNING: some contacts appear in BOTH the customer and vendor lists -- tell Claude.');
  }

  // ---- JN-Clean: what was loaded, and does it cancel contact by contact? ----
  const st = raw.jnCleanStats;
  if (st) {
    console.log('\nJN-Clean journals:');
    console.log(`  ${st.jnJournals} journals found, ${st.fetchedThisRun} fetched this run${st.failed ? `, ${st.failed} FAILED (retried next run)` : ''}${st.partial ? ' (time budget hit -- partial)' : ''}`);
    console.log(`  ${st.entriesWithContacts} carry customer/vendor lines (${st.contactLines} lines)`);
    console.log(`  ${st.applications} applications to invoices/bills found, totalling Rs ${Math.round(st.applicationTotal).toLocaleString('en-IN')}`);
    if (st.foreignJournals) console.log(`  ${st.foreignJournals} of them are in a foreign currency (read at their rupee value)`);
    if (st.entriesWithContacts > 0 && st.applications === 0) {
      console.log('  NOTE: contact lines were read but NO applications were. Totals are unaffected,');
      console.log('  but age buckets can be understated. Open /api/debug/probe and send Claude the result.');
    }
  }

  // ---- account types and opening balances ----
  const at = raw.accountTypeStats;
  if (at) {
    console.log('\nAccounts on journal lines tagged to a customer/vendor (only Receivable / Payable ones reach their balance):');
    console.log(`  ${at.distinctAccounts} accounts: ${at.receivable} Receivable, ${at.payable} Payable, ${at.other} other${at.unknown ? `, ${at.unknown} could not be looked up (counted as before)` : ''}; ${at.lookedUp} looked up this run`);
    if (at.unknown > 0) console.log('  Why lookups failed (first few):', at.failureSamples.join(' | ') || '(none recorded)', '\n  Run npm run sync-cache again: accounts already looked up are remembered, only the rest are retried.');
    if (at.receivable === 0 || at.payable === 0) console.log('  WARNING: no Receivable or no Payable account found, so journal lines are NOT being filtered by account type. Send Claude /api/debug/probe.');
  }
  const ob = raw.openingBalanceStats;
  if (ob) {
    console.log('Opening balances (carried over from the old books, not in any invoice/bill list):');
    console.log(`  ${ob.contactsLookedUp} contacts looked up this run, ${ob.contactsWithOpeningBalance} carry one${ob.failed ? `, ${ob.failed} lookups FAILED (retried next run)` : ''}${ob.partial ? ' (time budget hit -- partial)' : ''}`);
  }

  const pt = raw.paymentTdsStats;
  if (pt) {
    console.log('TDS on advance vendor payments (counted at the gross, as the Statement does):');
    console.log(`  ${pt.candidates} payments with an unused balance, ${pt.lookedUp} looked up this run, ${pt.withTds} carry TDS${pt.failed ? `, ${pt.failed} lookups FAILED (retried next run)` : ''}${pt.partial ? ' (time budget hit -- partial)' : ''}`);
  }
  console.log(`Vendor ledger for today: ${raw.vendorLedgerToday ? `Zoho vendor balance report (${Object.keys(raw.vendorLedgerToday).length} vendors)` : 'contact records (the vendor report was not usable)'}`);

  // ---- the proof: do the documents explain Zoho's ledger for every contact? ----
  const today = new Date();
  const asOf = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const rec = reconcile(raw, asOf, ledgerFromContacts(raw));
  console.log('\nProof (documents vs Zoho ledger, per contact):');
  console.log(`  Customers: ${rec.customers.reconciled} of ${rec.customers.contactsWithABalance} with a balance reconcile, ${rec.customers.flagged} flagged`);
  console.log(`  Vendors  : ${rec.vendors.reconciled} of ${rec.vendors.contactsWithABalance} with a balance reconcile, ${rec.vendors.flagged} flagged`);
  console.log(`  JN-Clean cancels to zero for all but ${rec.jnClean.contactsWhereJNDoesNotCancel} of ${rec.jnClean.contactsWithJNLines} contacts`);
  const hl = rec.jnClean.headlineEffectOfTheRule;
  if (hl) {
    const sgn = (n: number) => (n >= 0 ? '+' : '-') + 'Rs ' + Math.abs(n).toLocaleString('en-IN');
    if (rec.jnClean.rule === 'literal') {
      console.log(`  JN-Clean rule: LITERAL (JN_CLEAN_RULE=literal): every JN-Clean row is excluded. Against the raw Statements this makes Debtors ${sgn(hl.customers.literalRuleWouldAdd)} and Creditors ${sgn(hl.vendors.literalRuleWouldAdd)} (${hl.customers.contactsWhoseBalanceWouldChangeSide + hl.vendors.contactsWhoseBalanceWouldChangeSide} contacts change side)`);
    } else {
      console.log(`  JN-Clean rule: rows excluded only where they cancel. For the ${hl.customers.contactsWhereJNDoesNotCancel + hl.vendors.contactsWhereJNDoesNotCancel} contacts where they do not, the row is kept, so each equals its Zoho Statement (the literal rule would have made Debtors ${sgn(hl.customers.literalRuleWouldAdd)} and Creditors ${sgn(hl.vendors.literalRuleWouldAdd)} against the Statements)`);
    }
  }
  console.log(`  Foreign-currency journals: ${rec.foreignCurrency.journalsInForeignCurrency}, counted at their rupee value; ${rec.foreignCurrency.journalsWhoseRupeeTotalDiffersFromZoho === 0 ? 'every one adds up to the rupee total Zoho shows for it' : `WARNING: ${rec.foreignCurrency.journalsWhoseRupeeTotalDiffersFromZoho} do NOT add up to Zoho's rupee total - send Claude /api/debug/reconcile`}`);
  // ---- foreign-currency contacts: Zoho's own per-currency balances and the rate on each document ----
  const fxc = foreignContacts(raw);
  const live = fxc.filter((v) => v.status === 'open' || v.status === 'residual' || v.problems.length > 0);
  console.log(`\nForeign-currency contacts: ${fxc.length} found (${live.length} with a foreign balance, a rupee residual or something to check; ${fxc.length - live.length} settled / set up only)`);
  for (const v of live) for (const l of describeForeign(v)) console.log('  ' + l);
  if (live.length === 0) console.log('  none with a balance. A foreign vendor appears here once it has an approved bill or payment.');
  console.log('  Details: http://localhost:3000/api/debug/reconcile  (add ?reread=1 to separate timing noise from real gaps)');

  // ---- the automatic re-check of flagged contacts (timing noise vs real gaps) ----
  const se = raw.settleStats;
  if (se) {
    console.log('\nAutomatic re-check of flagged contacts (done by the sync itself, at the end):');
    console.log(`  ${se.flaggedBefore} contacts were flagged when the sync finished reading; ${se.reread} were re-read from Zoho${se.journalsResynced ? ' (journals re-synced first)' : ''}`);
    console.log(`  timing noise, cleared on re-read: ${se.settled}${se.settledNames.length ? ' -> ' + se.settledNames.slice(0, 12).join(', ') : ''}`);
    console.log(`  still flagged after re-read     : ${se.persistent}${se.notChecked ? `   (not re-read: ${se.notChecked})` : ''}${se.failed ? `   (re-read FAILED: ${se.failed})` : ''}`);
    for (const p of se.persistentDetails.slice(0, 12)) {
      console.log(`    - ${p.name.slice(0, 44).padEnd(44)} documents Rs ${p.documents.toLocaleString('en-IN').padStart(14)}  Zoho ledger Rs ${(p.zohoLedger ?? 0).toLocaleString('en-IN').padStart(14)}  gap ${p.gap.toLocaleString('en-IN')}${p.reportAgrees ? `  [balance report agrees with: ${p.reportAgrees}]` : ''}`);
    }
  }

  // ---- TDS / two-source audit across every vendor, and the customers' report ----
  const va = auditVendors(raw);
  console.log('\nVendors: balance report vs contact record + TDS (every vendor, not a sample):');
  console.log(`  ${va.verdict}`);
  if (va.reportAvailable) {
    for (const u of va.unexplainedList.slice(0, 10)) console.log(`    - ${u.name.slice(0, 44).padEnd(44)} report Rs ${u.report.toLocaleString('en-IN').padStart(13)}  contact record Rs ${u.contactRecord.toLocaleString('en-IN').padStart(13)}  TDS Rs ${u.tds.toLocaleString('en-IN')}  -> ${u.reason}`);
    console.log(
      va.reportVendorsNotHeldCount === 0
        ? '  Coverage: every vendor that has a balance on Zoho\'s report is on the dashboard (none missing).'
        : `  COVERAGE GAP: ${va.reportVendorsNotHeldCount} vendors have a balance on Zoho's report but are NOT on the dashboard (contact ids): ${va.reportVendorsNotHeld.slice(0, 10).map((x) => `${x.id} Rs ${x.balance.toLocaleString('en-IN')}`).join('; ')}`
    );
  }
  try {
    const ca = await auditCustomers(raw, asOf, ledgerFromContacts(raw));
    if (ca.reportAvailable) {
      console.log('Customers: balance report vs contact record vs our documents:');
      console.log(`  ${ca.customersCompared} customers with a balance: report = contact record for ${ca.reportEqualsContactRecord}, report = our documents for ${ca.reportEqualsDocuments}; ${ca.differ} differ`);
      console.log(
        ca.reportCustomersNotHeldCount === 0
          ? '  Coverage: every customer that has a balance on Zoho\'s report is on the dashboard (none missing).'
          : `  COVERAGE GAP: ${ca.reportCustomersNotHeldCount} customers have a balance on Zoho's report but are NOT on the dashboard (contact ids): ${ca.reportCustomersNotHeld.slice(0, 10).map((x) => `${x.id} Rs ${x.balance.toLocaleString('en-IN')}`).join('; ')}`
      );
      for (const d of ca.differList.slice(0, 8)) console.log(`    - ${d.name.slice(0, 44).padEnd(44)} report Rs ${d.report.toLocaleString('en-IN').padStart(13)}  contact Rs ${d.contactRecord.toLocaleString('en-IN').padStart(13)}  documents Rs ${d.documents.toLocaleString('en-IN').padStart(13)}  (${d.reportAgreesWith})`);
    } else console.log('Customers: the balance report could not be read for the cross-check (not an error for the dashboard).');
  } catch (e) {
    console.log('Customers: cross-check skipped:', e instanceof Error ? e.message : e);
  }

  console.log('\nThe dashboard will now read from this cache instantly -- reload the page.');
}

main().catch((err) => {
  console.error('\nSync failed:', err);
  process.exit(1);
});

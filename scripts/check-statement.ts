// Run with: npm run check-statement -- "C:\path\to\customer_statement - Wonder.xls" [more files...]
//
// Reads an official Zoho Statement export (customer or vendor), re-does its
// arithmetic, applies your JN-Clean rule, and -- if the cache is populated --
// compares the result with what the dashboard shows for that contact.
//
// For a like-for-like comparison download the Statement with "To" = today (the
// dashboard's contact balances are as of the last sync). For an earlier "To"
// date, run  npm run sync-ledger -- <that date>  first.
//
// A Statement of a foreign-currency vendor has one section per currency (a rupee section and, say, a USD section).
// Each section is checked on its own. Nothing is guessed: the cache holds Zoho's own balance for the contact in each
// currency and the exchange rate Zoho put on every foreign document (npm run sync-cache stores them), so each Statement
// column is compared directly with Zoho's, and the rupee value of the foreign part is Zoho's too.
// Only a cache written before that was kept falls back to working a rate out from the Statement (or  --rate=USD=92.00885).

import { config } from 'dotenv';
// .env.local is read only when this file is RUN (see the bottom of the file), never when another script imports it:
// scripts/selftest.ts imports parseStatement from here and must not pick up real Upstash / Zoho keys.

import * as XLSX from 'xlsx';
import * as nodeFs from 'fs';
import * as nodePath from 'path';
import { getCachedRawData } from '../lib/cache';
import { getLedgerFor } from '../lib/ledger';
import { computeARDetail } from '../lib/ar-calculator';
import { computeAPDetail } from '../lib/ap-calculator';
import { expectedJNLines, findJNRows, type JNExpected } from '../lib/jn-locate';
import { jnRule } from '../lib/jn-rule';
import { foreignBreakdown, statementVerdict, describeForeign, type StatementColumn } from '../lib/foreign';

// (a balance that rounds to nothing prints as 0, never "-0")
const inr = (n: number) => {
  const r = Math.round(n);
  return (r === 0 ? 0 : r).toLocaleString('en-IN');
};

export interface Row {
  date: string;
  type: string;
  details: string;
  amount: number;
  payments: number;
  balance: number | null;
}

function money(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return 0;
  const n = Number(v.replace(/[^0-9.\-]/g, '')); // "₹ -4,432.59" and "$ 24,000.000" alike
  return Number.isFinite(n) ? n : 0;
}

const baseCurrency = () => (process.env.ZOHO_BASE_CURRENCY || 'INR').toUpperCase();

/** "₹ INR - Indian Rupee" / "$ USD - United States Dollar": the title row that starts a currency section */
function sectionCode(r: unknown[] | undefined): string | null {
  if (!r || String(r[1] ?? '').trim() !== '' || String(r[2] ?? '').trim() !== '') return null;
  const m = /^\s*(?:\S{1,4}\s+)?([A-Z]{3})\s+-\s+\S/.exec(String(r[0] ?? ''));
  return m ? m[1] : null;
}

export interface ForeignSection {
  currency: string;
  opening: number;
  /** "Billed Amount" of the account summary, in this currency */
  billed: number;
  /** "Balance Due" printed for this currency */
  printed: number | null;
  rows: Row[];
}

export function parseStatement(path: string) {
  const wb = XLSX.readFile(path);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null, raw: true });

  const title = String(grid[0]?.[0] ?? '');
  const lines = title.split('\n').map((l) => l.trim()).filter(Boolean);
  const name = lines[1] ?? '(unknown)';
  const kind: 'customer' | 'vendor' = /vendor statement/i.test(title) ? 'vendor' : 'customer';
  const range = /From\s+(\d\d\/\d\d\/\d{4})\s+To\s+(\d\d\/\d\d\/\d{4})/i.exec(title);
  const toDate = range ? range[2].split('/').reverse().join('-') : '';

  const hdrIdx = grid.findIndex((r) => String(r?.[1] ?? '').trim() === 'Transactions');
  const base = baseCurrency();

  // Account summary. A Statement with several currencies has one column per currency (the order varies: INR,USD or USD,INR),
  // named in the "Account Summary" row; a single-currency one has just the one column.
  const cols: [number, string][] = [];
  for (let i = 0; i < hdrIdx; i++) {
    const r = grid[i] ?? [];
    if (String(r[0] ?? '').trim() !== 'Account Summary') continue;
    r.forEach((c, j) => {
      if (j > 0 && /^[A-Z]{3}$/.test(String(c ?? '').trim())) cols.push([j, String(c).trim()]);
    });
  }
  if (cols.length === 0) cols.push([1, base]);
  const summary = new Map<string, { opening: number; billed: number; printed: number | null }>();
  for (const [, code] of cols) summary.set(code, { opening: 0, billed: 0, printed: null });
  for (let i = 1; i < hdrIdx; i++) {
    const k = String(grid[i]?.[0] ?? '').trim();
    for (const [j, code] of cols) {
      const s = summary.get(code)!;
      if (k === 'Balance Due') s.printed = money(grid[i]?.[j]);
      if (k === 'Opening Balance') s.opening = money(grid[i]?.[j]);
      if (k === 'Billed Amount') s.billed = money(grid[i]?.[j]);
    }
  }

  // Transactions, one section per currency. Each section has a title row, a column-header row and a "Balance Due" footer.
  const sections = new Map<string, { rows: Row[]; footer: number | null }>();
  const section = (c: string) => {
    if (!sections.has(c)) sections.set(c, { rows: [], footer: null });
    return sections.get(c)!;
  };
  let code = (hdrIdx > 0 ? sectionCode(grid[hdrIdx - 1]) : null) ?? base;
  for (let i = hdrIdx + 1; i < grid.length; i++) {
    const r = grid[i] ?? [];
    const title = sectionCode(r);
    if (title) {
      code = title;
      continue;
    }
    const type = String(r[1] ?? '').trim();
    if (String(r[0] ?? '').trim() === 'Date' && type === 'Transactions') continue; // the next section's column headings
    if (String(r[4] ?? '').trim() === 'Balance Due') {
      section(code).footer = money(r[5]);
      continue;
    }
    if (!r[0] || !type || type === 'Opening Balance') continue;
    section(code).rows.push({
      date: String(r[0]),
      type,
      details: String(r[2] ?? ''),
      amount: typeof r[3] === 'number' ? r[3] : 0,
      payments: typeof r[4] === 'number' ? r[4] : 0,
      balance: typeof r[5] === 'number' ? r[5] : null,
    });
  }

  // `rows`, `opening` and `printedBalance` are the BASE-currency (rupee) section, as before; the other currencies are in `foreign`.
  const rows = sections.get(base)?.rows ?? [];
  const opening = summary.get(base)?.opening ?? 0;
  const codes = [...new Set([...summary.keys(), ...sections.keys()])];
  const foreign: ForeignSection[] = codes
    .filter((c) => c !== base)
    .map((c) => ({ currency: c, opening: summary.get(c)?.opening ?? 0, billed: summary.get(c)?.billed ?? 0, printed: summary.get(c)?.printed ?? sections.get(c)?.footer ?? null, rows: sections.get(c)?.rows ?? [] }));
  const printedBalance = summary.get(base)?.printed ?? sections.get(base)?.footer ?? (foreign.length ? 0 : null);
  return { name, kind, toDate, opening, printedBalance, rows, foreign };
}

const fx = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
const isoOf = (d: string) => {
  const m = /^(\d\d)\/(\d\d)\/(\d{4})$/.exec(d.trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : d.trim();
};

/** a rate given on the command line: --rate=USD=92.00885 */
function ratesFromArgs(argv: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const a of argv) {
    const m = /^--rate=([A-Za-z]{3})=([0-9]*\.?[0-9]+)$/.exec(a);
    if (m) out.set(m[1].toUpperCase(), Number(m[2]));
  }
  return out;
}

/**
 * Does the Statement's own rupee section show the rate? Zoho carries a foreign bill in the rupee section as a journal of
 * (foreign amount x rate). So a rupee entry divided by one of the foreign bills that gives (about) the rate we expect is evidence for it.
 */
export function rateEvidence(baseRows: Row[], f: ForeignSection, expected: number, tolerance = 0.01): { rate: number; rupees: number; date: string; foreignAmount: number } | null {
  const denominators = [...f.rows.filter((r) => /^(Bill|Invoice)$/i.test(r.type) && r.amount > 0).map((r) => r.amount), f.billed].filter((d) => d > 0);
  let best: { rate: number; rupees: number; date: string; foreignAmount: number } | null = null;
  let bestOff = Infinity;
  for (const r of baseRows) {
    const a = Math.abs(r.amount - r.payments);
    if (a < 1) continue;
    for (const d of denominators) {
      const rate = a / d;
      const off = Math.abs(rate - expected) / expected;
      if (off < tolerance && off < bestOff) {
        best = { rate, rupees: a, date: r.date, foreignAmount: d };
        bestOff = off;
      }
    }
  }
  return best;
}

/** "₹5,93,550.00 for payment of AE/26-27/07" lines -> amounts */
function spentLines(details: string): number[] {
  return details
    .split('\n')
    .map((l) => /^₹([\d,\.]+) for payment of /.exec(l.trim()))
    .filter((m): m is RegExpExecArray => Boolean(m))
    .map((m) => Number(m[1].replace(/,/g, '')));
}

/** a JN-Clean line the dashboard knows in rupees, printed on the Statement in the foreign currency of its own section */
export function findForeignJournal(foreign: ForeignSection[], m: JNExpected) {
  for (const f of foreign) {
    for (const r of f.rows) {
      if (r.type !== 'Journal' || isoOf(r.date) !== m.date) continue;
      const amt = r.amount - r.payments;
      if (!amt || Math.sign(amt) !== Math.sign(m.effect)) continue;
      const rate = Math.abs(m.effect) / Math.abs(amt);
      if (rate >= 1 && rate <= 1000) return { f, amt, rate };
    }
  }
  return null;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

export async function checkOne(path: string) {
  const st = parseStatement(path);
  console.log('\n' + '='.repeat(78));
  console.log(`${st.name}   [${st.kind} statement, to ${st.toDate}]`);
  console.log('='.repeat(78));

  const sumAmt = st.rows.reduce((s, r) => s + r.amount, 0);
  const sumPay = st.rows.reduce((s, r) => s + r.payments, 0);
  const recomputed = st.opening + sumAmt - sumPay;
  let running = st.opening;
  let breaks = 0;
  for (const r of st.rows) {
    running += r.amount - r.payments;
    if (r.balance !== null && Math.abs(running - r.balance) > 0.5) breaks += 1;
  }
  console.log(`Balance Due as printed              : Rs ${inr(st.printedBalance ?? NaN)}${st.foreign.length ? '   (rupee section)' : ''}`);
  console.log(`Recomputed (opening + Amount - Payments): Rs ${inr(recomputed)}   ${Math.abs(recomputed - (st.printedBalance ?? NaN)) <= 1 ? 'OK' : 'MISMATCH'}   (running balance breaks: ${breaks})`);
  // foreign-currency sections, each checked in its own currency
  const fxChecks = st.foreign.map((f) => {
    const rec = f.opening + f.rows.reduce((a, r) => a + r.amount - r.payments, 0);
    let run = f.opening;
    let br = 0;
    for (const r of f.rows) {
      run += r.amount - r.payments;
      if (r.balance !== null && Math.abs(run - r.balance) > 0.005) br += 1;
    }
    return { f, rec, br, ok: Math.abs(rec - (f.printed ?? NaN)) <= 0.01 };
  });
  for (const c of fxChecks) console.log(`${c.f.currency} section Balance Due as printed : ${c.f.currency} ${fx(c.f.printed ?? NaN)}   recomputed ${fx(c.rec)}   ${c.ok ? 'OK' : 'MISMATCH'}   (running balance breaks: ${c.br})`);

  // The dashboard's cache: needed up front, because it knows which JN-Clean lines were removed for this contact.
  const raw = await getCachedRawData();
  const want = norm(st.name);
  const contact = (st.kind === 'customer' ? raw?.activeCustomers : raw?.activeVendors)?.find((c) => norm(c.contact_name) === want);
  const expected = raw && contact ? expectedJNLines(raw.jnClean, contact.contact_id, st.kind, st.toDate, raw.ledgerAccounts) : [];

  // JN-Clean rows on the Statement: those that say so, same-day cancelling pairs, and every line the dashboard removed
  // (found by journal number, else by date and amount) -- a JN-Clean journal that does not cancel is a single, often unlabelled row.
  const labelled = st.rows.filter((r) => /JN-Clean/i.test(r.details));
  const found = findJNRows(st.rows, expected);
  const jnRows = [...found.rowIdx].map((i) => st.rows[i]);
  const jnNet = found.net;
  const excl = recomputed - jnNet;
  const spent = [...jnRows, ...labelled.filter((r) => r.type === 'Journal Applied')].reduce((s, r) => s + spentLines(r.details).reduce((a, b) => a + b, 0), 0);
  console.log(`JN-Clean rows found                 : ${jnRows.length} journal rows (net Rs ${inr(jnNet)})${spent ? `; credit spent on ${st.kind === 'customer' ? 'invoices' : 'bills'}: Rs ${inr(spent)}` : ''}`);
  const cancels = Math.abs(excl - recomputed) <= 1;
  console.log(`Balance with JN-Clean rows excluded : Rs ${inr(excl)}   ${cancels ? '(same: the pair cancels)' : jnRule() === 'literal' ? '(DIFFERENT: JN-Clean does not cancel for this contact)' : '(DIFFERENT, but JN-Clean does not cancel for this contact, so the dashboard KEEPS these rows and is compared with the Statement as printed)'}`);
  console.log(`JN-Clean rule in force              : ${jnRule() === 'literal' ? 'literal (every JN-Clean row excluded)' : 'rows excluded only where they cancel; where they do not, the row is kept'}`);
  if (expected.length > 0) {
    const handled = jnRule() === 'literal' || Math.abs(found.expectedNet) <= 1 ? 'removed' : 'kept (do not cancel)';
    const inForeign: string[] = [];
    const stillMissing: JNExpected[] = [];
    for (const m of found.missing) {
      const hitF = findForeignJournal(st.foreign, m);
      if (hitF) inForeign.push(`  ${m.journal || '(no number)'} dated ${m.date}: found in the ${hitF.f.currency} section as ${hitF.f.currency} ${fx(Math.abs(hitF.amt))} (= Rs ${inr(Math.abs(m.effect))} at ${hitF.rate.toFixed(5)})`);
      else stillMissing.push(m);
    }
    const nFound = found.located.length + inForeign.length;
    console.log(`JN-Clean lines in the dashboard data: ${expected.length} on this contact's ledger (net Rs ${inr(found.expectedNet)} on the Statement), ${handled}; found on this Statement: ${nFound} of ${expected.length}${found.located.length ? ' (' + [...new Set(found.located.map((l) => l.by))].join(', ') + ')' : ''}`);
    for (const l of inForeign) console.log(l);
    for (const m of stillMissing) console.log(`  NOT FOUND on this Statement: ${m.journal || '(no number)'} dated ${m.date}, Rs ${inr(m.effect)}`);
    if (stillMissing.length === 0 && inForeign.length === 0 && Math.abs(found.net - found.expectedNet) > 1) {
      console.log(`  NOTE: JN-Clean rows on the Statement net Rs ${inr(found.net)}, the dashboard's data has Rs ${inr(found.expectedNet)} -- the Statement holds JN-Clean rows the dashboard's data does not.`);
    }
  } else if (raw && contact) {
    console.log('JN-Clean lines in the dashboard data: none on this contact\'s ledger');
  }

  // compare with the dashboard
  if (!raw) {
    console.log('Dashboard: no cache available here, so no comparison.');
    return;
  }
  const { ledger, basis } = await getLedgerFor(st.toDate, raw);
  if (!ledger) {
    console.log(`Dashboard: no ledger for ${st.toDate} (cache was read ${raw.fetchedAt.slice(0, 10)}). Download the Statement with To = today, or run: npm run sync-ledger -- ${st.toDate}`);
    return;
  }
  const historical = basis === 'snapshot';
  const rows = st.kind === 'customer' ? computeARDetail(raw, st.toDate, { ledger, historical }) : computeAPDetail(raw, st.toDate, { ledger, historical });
  const hit = rows.find((r) => norm('customerName' in r ? r.customerName : r.vendorName) === want);
  if (!hit) {
    console.log(`Dashboard: no active ${st.kind} named "${st.name}" in the cache (inactive, or the name differs).`);
    return;
  }
  const mixed = Math.abs(recomputed - (st.printedBalance ?? NaN)) > 1 || fxChecks.some((c) => !c.ok || c.br > 0);
  // Default rule: JN-Clean rows are excluded only where they cancel, so the dashboard is compared with the Statement as printed.
  // JN_CLEAN_RULE=literal: every JN-Clean row is excluded, so it is compared with the Statement less those rows.
  const literal = jnRule() === 'literal';
  const baseTarget = literal ? excl : recomputed;
  const lessJN = literal && Math.abs(jnNet) > 1 ? ' (the Statement less its JN-Clean rows, as the literal rule says)' : '';
  const basisText = `Dashboard shows (${historical ? "Zoho's ledger for that day" : 'the sum of the documents'})`;

  // Foreign-currency part. First choice: Zoho's own figures from the cache (per-currency balance + the rate on each document).
  const given = ratesFromArgs(process.argv);
  const columns: StatementColumn[] = [{ currency: baseCurrency(), printed: st.printedBalance ?? 0 }, ...st.foreign.map((f) => ({ currency: f.currency, printed: f.printed ?? 0 }))];
  const view = contact ? foreignBreakdown(raw, contact) : null;
  const fromZoho = view && given.size === 0 ? statementVerdict(view, columns, baseTarget, hit.netTotal) : null;
  if (view && fromZoho) {
    const v = fromZoho;
    console.log(`${basisText} : Rs ${inr(hit.netTotal)}   ${v.match ? `MATCHES the Statement${lessJN}` : v.columnsMatch ? `DIFFERS by Rs ${inr(v.diff)}` : 'DIFFERS: a currency column of the Statement does not agree with Zoho (below)'}`);
    console.log("  Each currency on the Statement against Zoho's own balance for this contact (no exchange rate involved):");
    for (const c of v.columns) console.log(`    ${c.currency.padEnd(4)} Statement ${fx(c.statement).padStart(16)}   Zoho ${fx(c.zoho).padStart(16)}   ${c.ok ? 'OK' : `DIFFERS by ${fx(c.diff)}`}`);
    console.log(`  Foreign part in rupees, as Zoho values it : Rs ${inr(v.foreignRupees)}   ->   rupee section Rs ${inr(baseTarget)} + Rs ${inr(v.foreignRupees)} = Rs ${inr(v.target)}`);
    for (const l of describeForeign(view)) console.log('  ' + l);
  } else {
    if (st.foreign.length > 0 && given.size === 0) {
      console.log("NOTE: the cache holds no per-currency balances / document rates for this contact (it was probably written before they were kept). Run  npm run sync-cache  once and re-run this for a check against Zoho's own figures; until then the rate is worked out below.");
    }
    // foreign-currency part: every currency that still has a balance, in rupees at its rate
    const open = st.foreign.filter((f) => Math.abs(f.printed ?? 0) > 0.0005);
    let target = baseTarget;
    const parts: string[] = [];
    const unknown: ForeignSection[] = [];
    for (const f of open) {
      const r = given.get(f.currency);
      if (r !== undefined) {
        target += (f.printed ?? 0) * r;
        parts.push(`${f.currency} ${fx(f.printed ?? 0)} x ${r} (rate you gave)`);
      } else unknown.push(f);
    }
    const evidence: string[] = [];
    if (unknown.length === 1) {
      const f = unknown[0];
      const implied = (hit.netTotal - target) / (f.printed ?? 1);
      const ev = implied > 0 ? rateEvidence(st.rows, f, implied) : null;
      if (ev) {
        target += (f.printed ?? 0) * ev.rate;
        parts.push(`${f.currency} ${fx(f.printed ?? 0)} x ${ev.rate.toFixed(5)}`);
        evidence.push(`Rate on the Statement itself : Rs ${inr(ev.rupees)} (rupee section, ${ev.date}) / ${f.currency} ${fx(ev.foreignAmount)} = ${ev.rate.toFixed(5)}`);
        unknown.length = 0;
      }
    }

    if (unknown.length === 0) {
      const diff = hit.netTotal - target;
      const fxText = parts.length ? `   (rupee part Rs ${inr(baseTarget)} + ${parts.join(' + ')} = Rs ${inr(target)})` : '';
      console.log(`${basisText} : Rs ${inr(hit.netTotal)}   ${Math.abs(diff) <= 1 ? `MATCHES the Statement${lessJN}` : `DIFFERS by Rs ${inr(diff)}`}${fxText}`);
      for (const l of evidence) console.log(l);
    } else {
      const need = hit.netTotal - target;
      console.log(`${basisText} : Rs ${inr(hit.netTotal)}   (no verdict yet: the ${unknown.map((f) => f.currency).join(' and ')} part needs an exchange rate)`);
      console.log(`  Rupee part of the Statement : Rs ${inr(baseTarget)}`);
      if (unknown.length === 1) {
        const f = unknown[0];
        console.log(`  ${f.currency} part : ${f.currency} ${fx(f.printed ?? 0)} -- for the dashboard to be right this must be Rs ${inr(need)}, a rate of ${(need / (f.printed ?? 1)).toFixed(5)}`);
        console.log(`  Compare that rate with the exchange rate on the ${f.currency} bill in Zoho, or re-run with  --rate=${f.currency}=<rate>  for a definite answer.`);
      } else {
        console.log(`  The foreign-currency parts together must come to Rs ${inr(need)} for the dashboard to be right.`);
      }
    }
  }
  if (!historical && hit.ledgerTotal !== undefined) {
    console.log(`Zoho's own ledger figure            : Rs ${inr(hit.ledgerTotal)}   ${hit.gap === 0 ? '(the documents agree with it)' : `(documents differ from it by Rs ${inr(Math.abs(hit.gap))} -- flagged on the dashboard)`}`);
  }
  if (mixed || breaks > 0) {
    console.log('NOTE: a section of this Statement does not add up to its own printed balance. This may be a layout this script does not know -- send me the file.');
  }
}

/** a folder given instead of a file stands for every .xls / .xlsx file in it (sorted by name) */
export function expandFiles(args: string[]): string[] {
  const out: string[] = [];
  for (const a of args) {
    let isDir = false;
    try {
      isDir = nodeFs.statSync(a).isDirectory();
    } catch {
      /* not there: left as it is, so the error names the file */
    }
    if (!isDir) out.push(a);
    else
      out.push(
        ...nodeFs
          .readdirSync(a)
          .filter((f) => /\.xlsx?$/i.test(f) && !f.startsWith('~$'))
          .sort()
          .map((f) => nodePath.join(a, f)),
      );
  }
  return out;
}

async function main() {
  const files = expandFiles(process.argv.slice(2).filter((a) => !/^--rate=/i.test(a)));
  if (files.length === 0) {
    console.error('Usage: npm run check-statement -- "<statement.xls or a folder of them>" ["<another.xls>" ...] [--rate=USD=92.5]');
    process.exit(1);
  }
  for (const f of files) {
    try {
      await checkOne(f);
    } catch (e) {
      console.error(`\n${f}: could not be read -- ${e instanceof Error ? e.message : e}`);
    }
  }
}

if (require.main === module || process.argv[1]?.includes('check-statement')) {
  config({ path: '.env.local' });
  main();
}

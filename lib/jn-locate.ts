import { parseISO } from 'date-fns';
import type { JNCleanEntry } from './jn-clean';
import { accountSets, lineHitsLedger, type LedgerAccounts } from './accounts';

// Finds the JN-Clean rows on an official Zoho Statement, for scripts/check-statement.
//
// Why this exists: the Statement does not always label a JN-Clean journal. Some rows say
// "JN-Clean-1", some are blank, and the credit leg of a pair may carry only "for payment of ..."
// lines. Looking for the label or for a same-day cancelling pair finds the ordinary cases, but a
// JN-Clean journal that does NOT cancel on the contact's ledger (the other leg sits on a non-AR/AP
// account such as "Other Current Asset", e.g. a group loan account) is a single unlabelled row and
// was missed -- so the script printed "JN-Clean rows found: 0" while the dashboard had removed one.
//
// The dashboard already knows exactly which JN-Clean lines it removed (the cache holds them). So we
// take those lines and look for each one on the Statement -- by journal number where the Statement
// prints it, otherwise by date AND amount. A line that cannot be found is reported, never ignored.

export interface StmtRow {
  date: string; // dd/mm/yyyy, as Zoho prints it
  type: string;
  details: string;
  amount: number;
  payments: number;
}

export interface JNExpected {
  journal: string;
  /** ISO date */
  date: string;
  /** Effect of this line on the contact's STATEMENT balance (customer: debit +, credit -; vendor: credit +, debit -). */
  effect: number;
}

const TOL = 1;

/** The JN-Clean lines the dashboard removed for one contact, as they show up on that contact's Statement. */
export function expectedJNLines(
  entries: JNCleanEntry[] | undefined,
  contactId: string,
  kind: 'customer' | 'vendor',
  toDate: string,
  accounts?: LedgerAccounts,
): JNExpected[] {
  const sets = accountSets(accounts);
  const asOf = toDate ? parseISO(toDate) : undefined;
  const out: JNExpected[] = [];
  for (const e of entries ?? []) {
    const d = e.journal_date ? parseISO(e.journal_date) : undefined;
    if (asOf && d && d > asOf) continue;
    for (const l of e.lines) {
      if (l.contact_id !== contactId) continue;
      if (!lineHitsLedger(sets, kind === 'customer' ? 'receivable' : 'payable', l.account_id)) continue;
      const debit = l.debit_or_credit === 'debit';
      const effect = kind === 'customer' ? (debit ? l.amount : -l.amount) : debit ? -l.amount : l.amount;
      out.push({ journal: e.entry_number, date: (e.journal_date ?? '').slice(0, 10), effect });
    }
  }
  return out;
}

const toIso = (d: string) => {
  const m = /^(\d\d)\/(\d\d)\/(\d{4})$/.exec(d.trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : d.trim();
};
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const rowEffect = (r: StmtRow) => r.amount - r.payments;

export interface JNFound {
  /** every Statement row treated as JN-Clean: labelled, same-day cancelling pairs, and rows matched to the dashboard's lines */
  rowIdx: Set<number>;
  /** net effect of those rows on the Statement balance */
  net: number;
  expected: JNExpected[];
  expectedNet: number;
  located: { line: JNExpected; row: number; by: 'journal number' | 'date and amount' | 'journal total' }[];
  missing: JNExpected[];
}

export function findJNRows(rows: StmtRow[], expected: JNExpected[]): JNFound {
  const idx = new Set<number>();

  // rows that say so, and unlabelled same-day cancelling journal pairs
  rows.forEach((r, i) => {
    if (r.type === 'Journal' && /JN-Clean/i.test(r.details)) idx.add(i);
  });
  const journals = rows.map((r, i) => ({ r, i })).filter((x) => x.r.type === 'Journal');
  for (let k = 0; k + 1 < journals.length; k++) {
    const a = journals[k];
    const b = journals[k + 1];
    if (a.r.date === b.r.date && a.r.amount < 0 && Math.abs(a.r.amount + b.r.amount) < 0.5 && (/for payment of/.test(a.r.details) || /JN-Clean/i.test(a.r.details))) {
      idx.add(a.i);
      idx.add(b.i);
    }
  }

  // the lines the dashboard removed: look for each one on the Statement
  const used = new Set<number>();
  const located: JNFound['located'] = [];
  const missing: JNExpected[] = [];
  const ordered = [...expected].sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect));
  const free = (i: number, effect: number) => rows[i].type === 'Journal' && !used.has(i) && Math.abs(rowEffect(rows[i]) - effect) <= TOL;
  const labelOf = (journal: string) => (journal ? new RegExp(esc(journal) + '(?![0-9A-Za-z])', 'i') : null);
  for (const line of ordered) {
    const label = labelOf(line.journal);
    let hit = -1;
    let by: 'journal number' | 'date and amount' = 'journal number';
    if (label) hit = rows.findIndex((r, i) => free(i, line.effect) && label.test(r.details));
    if (hit < 0) {
      by = 'date and amount';
      hit = rows.findIndex((r, i) => free(i, line.effect) && toIso(r.date) === line.date);
    }
    if (hit < 0) {
      missing.push(line);
      continue;
    }
    used.add(hit);
    idx.add(hit);
    located.push({ line, row: hit, by });
  }

  // Several lines of ONE journal on the same contact might be printed as a single row (their total): try that before giving up.
  const groups = new Map<string, JNExpected[]>();
  for (const m of missing) groups.set(`${m.journal}|${m.date}`, [...(groups.get(`${m.journal}|${m.date}`) ?? []), m]);
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const total = g.reduce((a, l) => a + l.effect, 0);
    if (Math.abs(total) <= TOL) continue; // a journal that nets to nothing on this contact leaves no number to look for
    const label = labelOf(g[0].journal);
    const hit = rows.findIndex((r, i) => free(i, total) && ((label && label.test(r.details)) || toIso(r.date) === g[0].date));
    if (hit < 0) continue;
    used.add(hit);
    idx.add(hit);
    for (const l of g) {
      located.push({ line: l, row: hit, by: 'journal total' });
      missing.splice(missing.indexOf(l), 1);
    }
  }

  let net = 0;
  for (const i of idx) net += rowEffect(rows[i]);
  return { rowIdx: idx, net, expected, expectedNet: expected.reduce((s, l) => s + l.effect, 0), located, missing };
}

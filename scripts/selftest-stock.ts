// Offline self-test for the Stock Statement tab (no credentials, no network). Run: npx tsx scripts/selftest-stock.ts
//
// Checks the rules in lib/stock-calculator.ts on the examples Jatin gave (13 Oct 2026) and on random data, and
// the date rules in lib/stock-period.ts, and how a period is added up from the daily snapshot's months (lib/stock-compose.ts).
//
// Amount rule (13 Oct, 15:09 IST): Zoho's own amount of every SKU as it is, except a SKU with NEGATIVE stock, whose
// amount is subtracted by its modulus. No rate is ever worked out. Net-negative products: -|amount| in the last line.

import { buildStatement, qualifyingProducts, itemKey, LIST_THRESHOLD, OTHER_LABEL, type StockRow } from '../lib/stock-calculator';
import { composeRows, listsFromMonths, monthSpans, monthsFor } from '../lib/stock-compose';
import {
  STOCK_FIRST_DATE, clampStockRange, defaultStockRange, fyStartYearOf, stockMonthOptions, stockQuarterOptions, stockYearOptions,
} from '../lib/stock-period';

let failures = 0;
function check(label: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  -> ' + extra : ''}`);
  if (!ok) failures += 1;
}
const near = (a: number, b: number, tol = 0.005) => Math.abs(a - b) <= tol;

let n = 0;
const row = (name: string, opening: number, qtyIn: number, qtyOut: number, closing: number, closingValue: number): StockRow => ({
  itemId: `id${++n}`, name, opening, qtyIn, qtyOut, closing, closingValue,
});
const none = new Set<string>();

// ---------------------------------------------------------------- the four Sept 2026 items from the brief
console.log('--- Point 3: negative stock goes into the last line; amount rule ---');
{
  const rows = [
    row('FUSE', -3, 0, 0, -3, -3),
    row('PG Clamp', -3, 0, 3, -6, 1680),
    row('Shock Treatment Chart', -9, 0, 0, -9, 0),
    row('LCL Fan Black', -11, 0, 0, -11, 21800),
  ];
  const s = buildStatement(rows, new Set(rows.map((r) => itemKey(r.name)))); // even if they were on the list
  check('all four are in the last line, none shown separately', s.lines.length === 0 && s.other.name === OTHER_LABEL && s.other.itemCount === 4 && s.other.negativeCount === 4);
  check('Opening Stock total = -26 (negatives added as they are)', s.other.opening === -26 && s.total.opening === -26);
  check('Quantity Out = 3, Closing Stock = -29', s.other.qtyOut === 3 && s.other.closing === -29);
  check('Closing Stock Amount = -23,483 (FUSE -3 as it is, PG Clamp 1,680 and LCL Fan 21,800 SUBTRACTED, Shock chart 0)', s.other.closingValue === -23483 && s.total.closingValue === -23483, String(s.total.closingValue));
  check('Zoho would add 23,477 (-3 + 1,680 + 0 + 21,800)', s.zoho.closingValue === 23477, String(s.zoho.closingValue));
  check('the difference from Zoho is -46,960: the two positive amounts, taken out of Zoho\'s total and then subtracted again', s.valueDifference === -46960, String(s.valueDifference));
  check('only PG Clamp and LCL Fan Black are listed as adjusted', s.adjustments.length === 2 && s.adjustments.every((a) => a.reason === 'negative-stock-value-subtracted'), s.adjustments.map((a) => a.name).join(', '));
  check('quantities tie to Zoho', s.quantitiesTie);
}

// ---------------------------------------------------------------- point 5: old + new SKU clubbed
console.log('--- Point 5: old and new SKU of one item are clubbed ---');
{
  // the two items in the Zoho screenshot (Sept 2026): +928 / -928 and +359 / -359, the amount sits on the positive SKU
  const rows = [
    row('1C X 240 Sqmm cable', 928, 0, 0, 928, 295104),
    row('1C X 240 Sqmm cable', -928, 0, 0, -928, 0),
    row('4C X 16 Sqmm AI Arm Cable', 359, 0, 0, 359, 37695),
    row('4C X 16 Sqmm AI Arm Cable', -359, 0, 0, -359, 0),
  ];
  const s = buildStatement(rows, none);
  check('each pair adds up to nil stock, so no negative stock is left', s.other.negativeCount === 0 && s.other.opening === 0 && s.other.closing === 0);
  check('...and the amounts are Zoho\'s own: 2,95,104 + 37,695 (the nil-stock pair is not zeroed)', s.other.closingValue === 332799 && s.zoho.closingValue === 332799, `${s.other.closingValue} vs Zoho ${s.zoho.closingValue}`);
  check('nothing differs from Zoho, so nothing is listed as adjusted', s.adjustments.length === 0 && s.valueDifference === 0);
  check('name clubbing ignores capitals and extra spaces', itemKey('  Solar  MODULE ') === itemKey('solar module'));
}
{
  // Jatin, 13 Oct: an amount on nil stock is shown as it is, and on its own line when over Rs 5 lakh
  const rows = [row('3C X 240 Sqmm AI Arm Cable', 0, 0, 0, 0, 1236700.6), row('Tiny nil item', 0, 0, 0, 0, 100)];
  const q = qualifyingProducts(rows);
  check('an amount of 12,36,700.60 on nil stock qualifies for the list', q.length === 1 && q[0].name === '3C X 240 Sqmm AI Arm Cable');
  const s = buildStatement(rows, new Set(q.map((x) => x.key)));
  const l = s.lines[0];
  check('it is its own line: Opening 0, In 0, Out 0, Closing 0, amount 12,36,700.60', s.lines.length === 1 && l.opening === 0 && l.qtyIn === 0 && l.qtyOut === 0 && l.closing === 0 && near(l.closingValue, 1236700.6), JSON.stringify(l));
  check('the small nil-stock amount (100) goes into the last line as it is; the Grand Total equals Zoho\'s', near(s.other.closingValue, 100) && near(s.total.closingValue, 1236800.6) && s.valueDifference === 0 && s.adjustments.length === 0);
}
{
  // net stock stays positive (Aug 2026 Solar Module)
  const rows = [
    row('Solar Module', -720, 720, 0, 0, 0),
    row('Solar Module', 863, 3124, 3844, 143, 1350724),
  ];
  const s = buildStatement(rows, new Set([itemKey('Solar Module')]));
  const l = s.lines[0];
  check('positive net: shown separately when on the list', s.lines.length === 1 && l.name === 'Solar Module');
  check('net Opening 143, In 3,844, Out 3,844, Closing 143', l.opening === 143 && l.qtyIn === 3844 && l.qtyOut === 3844 && l.closing === 143);
  check('amount = Zoho\'s 1,350,724 as it is (the SKU with nil stock carries nothing)', near(l.closingValue, 1350724), String(l.closingValue));
}
{
  // a negative SKU with a NEGATIVE amount, net stock still positive: amount of the +ve SKU minus |amount of the -ve SKU|
  const rows = [
    row('Battery Pack', -3, 0, 0, -3, -300000),
    row('Battery Pack', 11, 7, 11, 7, 700000),
  ];
  const s = buildStatement(rows, new Set([itemKey('Battery Pack')]));
  check('700,000 - |-300,000| = 400,000', near(s.total.closingValue, 400000), String(s.total.closingValue));
  check('net opening 8 is positive so the pack stays a separate line', s.lines.length === 1 && s.lines[0].opening === 8 && s.lines[0].closing === 4);
  check('this equals Zoho\'s own sum, so nothing is listed as adjusted', s.adjustments.length === 0);
}
{
  // the big BESS-type case: a large negative amount on the negative SKU is simply carried (no rate is worked out)
  const rows = [
    row('Battery Pack', -3, 0, 0, -3, -9000000),
    row('Battery Pack', 11, 7, 11, 7, 27000000),
  ];
  const s = buildStatement(rows, new Set([itemKey('Battery Pack')]));
  check('27,000,000 - |-9,000,000| = 18,000,000, as Zoho shows it (no stock x rate)', near(s.total.closingValue, 18000000) && s.adjustments.length === 0, String(s.total.closingValue));
}
{
  // the same, but Zoho shows a POSITIVE amount on the negative SKU: its modulus is subtracted
  const rows = [
    row('Battery Pack', -3, 0, 0, -3, 9000000),
    row('Battery Pack', 11, 7, 11, 7, 27000000),
  ];
  const s = buildStatement(rows, new Set([itemKey('Battery Pack')]));
  check('27,000,000 - |9,000,000| = 18,000,000 (Zoho adds them: 36,000,000)', near(s.total.closingValue, 18000000) && s.zoho.closingValue === 36000000, String(s.total.closingValue));
  check('...listed as adjusted for a positive amount on negative stock', s.adjustments.length === 1 && s.adjustments[0].reason === 'negative-stock-value-subtracted' && s.valueDifference === -18000000);
}
{
  // clubbing leaves NEGATIVE net stock: point 3 applies to the clubbed product
  const rows = [
    row('Cable X', 10, 0, 0, 10, 5000),
    row('Cable X', -25, 0, 0, -25, -20),
  ];
  const s = buildStatement(rows, none);
  check('net stock -15 -> last line, quantities as they are', s.other.closing === -15 && s.other.opening === -15 && s.other.negativeCount === 1);
  check('its amount (Zoho: 4,980 positive) is subtracted: -4,980', s.other.closingValue === -4980 && s.adjustments[0]?.reason === 'negative-stock-value-subtracted', String(s.other.closingValue));
}

{
  // the amount of negative stock is SUBTRACTED from the last line's amount, so the Grand Total goes down (Jatin, 13 Oct, after the first build)
  const rows = [row('Small item', 5, 0, 0, 5, 1000), row('Oversold item', -2, 0, 0, -2, 4000), row('Oversold item 2', -1, 0, 0, -1, -700)];
  const s = buildStatement(rows, none);
  check('last line amount = 1,000 (small) - 4,000 (oversold, positive Zoho amount) - 700 (oversold, negative Zoho amount) = -3,700', s.other.closingValue === -3700 && s.total.closingValue === -3700, String(s.other.closingValue));
  check('Zoho adds them up to 4,300, so the Grand Total is 8,000 below it', s.zoho.closingValue === 4300 && s.valueDifference === -8000, `${s.zoho.closingValue} / ${s.valueDifference}`);
  check('only the positive-amount item is listed as adjusted (the negative one is counted as it is)', s.adjustments.length === 1 && s.adjustments[0].name === 'Oversold item');
}

// ---------------------------------------------------------------- point 3/4: negative OPENING with positive closing
console.log('--- a listed item with negative net Opening goes to the last line for that period ---');
{
  const rows = [
    row('Solar Module', -720, 0, 0, -720, -6420600),
    row('Solar Module', 593, 270, 0, 863, 7719972),
  ];
  const s = buildStatement(rows, new Set([itemKey('Solar Module')]));
  check('net Opening -127: in the last line although it is on the list', s.lines.length === 0 && s.other.opening === -127 && s.other.closing === 143 && s.other.negativeCount === 1);
  check('its amount is Zoho\'s own: 7,719,972 - |-6,420,600| = 1,299,372', near(s.other.closingValue, 1299372), String(s.other.closingValue));
}

// ---------------------------------------------------------------- point 4: which items are shown separately
console.log('--- the Rs 5,00,000 rule ---');
{
  const rows = [row('At the line', 10, 0, 0, 10, 500000), row('A paisa over', 10, 0, 0, 10, 500000.01), row('Small', 3, 0, 0, 3, 100)];
  const q = qualifyingProducts(rows).map((x) => x.name);
  check('exactly Rs 5,00,000 does not qualify, 5,00,000.01 does', q.length === 1 && q[0] === 'A paisa over' && LIST_THRESHOLD === 500000, q.join(','));
  const s = buildStatement(rows, new Set(q.map(itemKey)));
  check('listed products are shown separately, the rest are added into the last line', s.lines.length === 1 && s.other.itemCount === 2 && s.other.smallCount === 2);
  {
    // Jatin, 13 Oct: a listed item with no closing stock and no closing amount is not worth a line
    const rows = [
      row('Idle item', 0, 0, 0, 0, 0),
      row('Sold out item', 50, 0, 50, 0, 0),
      row('Stranded amount', 0, 0, 0, 0, 1236700.6),
      row('Live item', 10, 0, 0, 10, 900000),
    ];
    const s = buildStatement(rows, new Set(rows.map((r) => itemKey(r.name))));
    check('on the list, but nothing left at the end: "Idle item" and "Sold out item" are not shown on their own', s.lines.map((l) => l.name).join('|') === 'Live item|Stranded amount', s.lines.map((l) => l.name).join('|'));
    check('a stranded amount on nil stock keeps its line (it has an amount)', s.lines.some((l) => l.name === 'Stranded amount' && near(l.closingValue, 1236700.6)));
    check('the sold-out item\'s movement stays in the totals through the last line: Opening 50, Out 50', s.other.opening === 50 && s.other.qtyOut === 50 && s.quantitiesTie && s.valueDifference === 0, JSON.stringify(s.other));
  }
  check('a negative amount never qualifies (it is no stock in hand)', qualifyingProducts([row('Minus', -2, 0, 0, -2, -9000000)]).length === 0);
}

// ---------------------------------------------------------------- random data: totals must tie
console.log('--- random data: nothing is lost or invented ---');
{
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const rows: StockRow[] = [];
  for (let i = 0; i < 600; i++) {
    const name = `Item ${Math.floor(rnd() * 350)}`; // many names repeat: old + new SKUs
    const opening = Math.round((rnd() - 0.25) * 4000) / 2;
    const qtyIn = Math.round(rnd() * 2000) / 2;
    const qtyOut = Math.round(rnd() * 2500) / 2;
    const closing = opening + qtyIn - qtyOut;
    const rate = 50 + rnd() * 5000;
    rows.push(row(name, opening, qtyIn, qtyOut, closing, Math.round(closing * rate * (rnd() < 0.15 ? -1 : 1) * 100) / 100));
  }
  const list = new Set(qualifyingProducts(rows).map((x) => x.key));
  const s = buildStatement(rows, list, () => 'Nos');
  check('Opening, In, Out and Closing STOCK totals equal Zoho\'s exactly', s.quantitiesTie, `${s.total.closing} vs ${s.zoho.closing}`);
  check('Opening + In - Out = Closing on every line and in the Grand Total', [...s.lines, s.other].every((l) => near(l.opening + l.qtyIn - l.qtyOut, l.closing, 0.002)) && near(s.total.opening + s.total.qtyIn - s.total.qtyOut, s.total.closing, 0.01));
  const explained = s.adjustments.reduce((t, a) => t + (a.usedValue - a.zohoValue), 0);
  check('the amount difference to Zoho is fully explained by the adjusted products', near(explained, s.valueDifference, 0.05), `${explained.toFixed(2)} vs ${s.valueDifference}`);
  check('no separately shown line is negative-stock', s.lines.every((l) => l.opening >= 0 && l.closing >= 0));
  check('lines are in A-Z order', s.lines.every((l, i) => i === 0 || s.lines[i - 1].name.localeCompare(l.name, 'en', { sensitivity: 'base' }) <= 0));
  const mustBeSeparate = s.qualifying.filter((q) => {
    const rs = rows.filter((r) => itemKey(r.name) === q.key);
    const op = rs.reduce((t, r) => t + r.opening, 0);
    const cl = rs.reduce((t, r) => t + r.closing, 0);
    return op >= 0 && cl >= 0;
  });
  check('every over-5-lakh product whose stock is not negative is on its own line', mustBeSeparate.length > 0 && mustBeSeparate.every((q) => s.lines.some((l) => l.key === q.key)), `${mustBeSeparate.length} products`);
}

// ---------------------------------------------------------------- dates
// ---------------------------------------------------------------- periods added up from the daily snapshot's months
console.log('--- the daily snapshot: months, and a period added up from them ---');
{
  const spans = monthSpans('2026-10-13');
  check('months run from April 2026 to the running month, which stops at today', spans.length === 7 && spans[0].from === '2026-04-01' && spans[0].to === '2026-04-30' && spans[6].from === '2026-10-01' && spans[6].to === '2026-10-13');
  check('a leap February and a 31-day month are right', monthSpans('2028-03-31').find((m) => m.ym === '2028-02')?.to === '2028-02-29');
  const asOf = '2026-10-13';
  const m = (f: string, t: string) => monthsFor(spans, f, t, asOf);
  check('a month is one month', m('2026-09-01', '2026-09-30')?.months.length === 1);
  check('a quarter is three months', m('2026-07-01', '2026-09-30')?.months.map((x) => x.ym).join() === '2026-07,2026-08,2026-09');
  check('the year to date is every month, ending today', m('2026-04-01', '2026-10-13')?.months.length === 7);
  check('the running month to date is the last month', m('2026-10-01', '2026-10-13')?.months.map((x) => x.ym).join() === '2026-10');
  check('a To past the snapshot day is taken as the snapshot day (before the 7:45 refresh)', m('2026-10-01', '2026-10-14')?.to === '2026-10-13');
  check('5 Sep to 20 Sep is not whole months (read live)', m('2026-09-05', '2026-09-20') === null);
  check('1 Sep to 15 Sep is not whole months (read live)', m('2026-09-01', '2026-09-15') === null);
  check('1 Apr to 15 Sep is not whole months (read live)', m('2026-04-01', '2026-09-15') === null);
  check('From later than To is not whole months', m('2026-09-01', '2026-08-31') === null);

  // two months of one SKU: Opening of the first, In and Out added, Closing of the last (the real July/August chain)
  const jul = [
    { itemId: 'a', name: 'Cable', opening: 100, qtyIn: 50, qtyOut: 30, closing: 120, closingValue: 1200 },
    { itemId: 'b', name: 'Panel', opening: 5, qtyIn: 0, qtyOut: 5, closing: 0, closingValue: 0 },
    { itemId: 'c', name: 'Gone later', opening: 7, qtyIn: 0, qtyOut: 0, closing: 7, closingValue: 70 },
  ];
  const aug = [
    { itemId: 'a', name: 'Cable', opening: 120, qtyIn: 10.5, qtyOut: 40.25, closing: 90.25, closingValue: 902.5 },
    { itemId: 'b', name: 'Panel', opening: 0, qtyIn: 3, qtyOut: 1, closing: 2, closingValue: 400 },
    { itemId: 'd', name: 'New item', opening: 0, qtyIn: 9, qtyOut: 0, closing: 9, closingValue: 90 },
  ];
  const both = composeRows([jul, aug]);
  const by = (id: string) => both.find((r) => r.itemId === id);
  check('Opening is the first month\'s opening', by('a')?.opening === 100 && by('b')?.opening === 5);
  check('In and Out are added up', by('a')?.qtyIn === 60.5 && by('a')?.qtyOut === 70.25 && by('b')?.qtyIn === 3 && by('b')?.qtyOut === 6);
  check('Closing quantity and amount are the last month\'s', by('a')?.closing === 90.25 && by('a')?.closingValue === 902.5 && by('b')?.closing === 2 && by('b')?.closingValue === 400);
  check('an item not in the last month has nothing at the end', by('c')?.closing === 0 && by('c')?.closingValue === 0 && by('c')?.opening === 7);
  check('an item that first appears later opened with nothing', by('d')?.opening === 0 && by('d')?.qtyIn === 9 && by('d')?.closing === 9);
  check('Opening + In - Out = Closing for every item of the period', both.every((r) => near(r.opening + r.qtyIn - r.qtyOut, r.closing, 0.0011) || r.itemId === 'c'));
  check('one month is used as it is', composeRows([jul]) === jul);
  check('composing does not change the months it was made from', jul[0].qtyIn === 50 && aug[0].opening === 120);

  // the year's list: over Rs 5,00,000 at ANY month-end of the year, per financial year, with the first month-end
  const lists = listsFromMonths([
    { from: '2027-02-01', to: '2027-02-28', qualifying: [{ key: 'old', name: 'Old Year Item' }] },
    { from: '2027-03-01', to: '2027-03-31', qualifying: [{ key: 'old', name: 'Old Year Item' }] },
    { from: '2027-04-01', to: '2027-04-30', qualifying: [{ key: 'bess', name: 'BESS' }] },
    { from: '2027-05-01', to: '2027-05-31', qualifying: [{ key: 'bess', name: 'BESS' }, { key: 'idt', name: 'IDT' }] },
  ]);
  check('the list is kept per financial year and starts afresh each April', Object.keys(lists).join() === '2026,2027' && !lists['2027'].old && !!lists['2026'].old);
  check('each product carries the first month-end it qualified', lists['2027'].bess.first === '2027-04-30' && lists['2027'].idt.first === '2027-05-31' && lists['2026'].old.first === '2027-02-28');

  // the statement of a composed period obeys the same rules as a single month
  const stmt = buildStatement(both, new Set(['cable']));
  check('a composed period builds a statement whose quantities tie to its own rows', stmt.quantitiesTie && near(stmt.total.closing, 90.25 + 2 + 9, 0.001));
}

console.log('--- dates on this tab ---');
{
  const today = '2026-10-13';
  check('the tab starts on 1 Apr 2026', STOCK_FIRST_DATE === '2026-04-01');
  const m = stockMonthOptions(today);
  check('months: Oct (to date) down to Apr 2026, nothing earlier', m.length === 7 && m[0].label === 'October 2026 (to date)' && m[0].from === '2026-10-01' && m[0].to === today && m[6].from === '2026-04-01', m.map((x) => x.label).join(' | '));
  check('a finished month runs from its 1st to its last day', m[1].label === 'September 2026' && m[1].from === '2026-09-01' && m[1].to === '2026-09-30' && m[5].to === '2026-05-31');
  const q = stockQuarterOptions(today);
  check('quarters: Q3 FY27 (to date), Q2, Q1', q.map((x) => x.label).join('|') === 'Q3 FY27 (to date)|Q2 FY27|Q1 FY27' && q[2].from === '2026-04-01' && q[2].to === '2026-06-30' && q[0].to === today);
  const y = stockYearOptions(today);
  check('year: FY27 (to date) = 1 Apr 2026 to today', y.length === 1 && y[0].label === 'FY27 (to date)' && y[0].from === '2026-04-01' && y[0].to === today);
  check('the tab opens on FY27 to date', defaultStockRange(today).from === '2026-04-01' && defaultStockRange(today).to === today);
  check('a year that has ended runs to 31 March', stockYearOptions('2027-05-10').map((o) => `${o.label} ${o.from} ${o.to}`).join('|') === 'FY28 (to date) 2027-04-01 2027-05-10|FY27 2026-04-01 2027-03-31');
  check('Jan-Mar belongs to the year that started the April before', fyStartYearOf('2027-02-14') === 2026 && fyStartYearOf('2026-04-01') === 2026 && fyStartYearOf('2026-03-31') === 2025);
  const c1 = clampStockRange('2025-12-01', '2026-02-10', today);
  check('FY26 or earlier is moved up to 1 Apr 2026', c1.from === '2026-04-01' && c1.to === '2026-04-01' && c1.changed);
  const c2 = clampStockRange('2026-09-30', '2026-09-01', today);
  check('From after To is pulled back to To', c2.from === c2.to && c2.changed);
  const c3 = clampStockRange('2026-05-01', '2027-01-01', today);
  check('a To in the future is held at today', c3.to === today && c3.from === '2026-05-01');
  const c4 = clampStockRange('2026-05-01', '2026-05-31', today);
  check('a good range is left alone', c4.from === '2026-05-01' && c4.to === '2026-05-31' && !c4.changed);
  const c5 = clampStockRange(undefined, 'rubbish', today);
  check('nothing / rubbish gives the default range', c5.from === '2026-04-01' && c5.to === today);
}

console.log(failures === 0 ? '\nALL STOCK SELF-TESTS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures ? 1 : 0);

// The Stock Statement rules as plain functions: no Zoho, no network, no browser. The page, the API and the
// self-test all use these same functions.
//
// Input: the rows of Zoho's own Stock Summary report for the period (one row per item SKU).
// Output: the statement table: one line per product that is shown separately, then ONE last line,
// "Other Stock Value Rs. 5 Lakhs or less", then the Grand Total.
//
// THE RULES (Jatin, 13 Oct 2026)
//  1. Every figure is Zoho's own. Stock quantities are never changed, floored or topped up.
//  2. The old SKU and the "_New" SKU of one product are CLUBBED: same item name = one product, the stock figures
//     simply added up. Most "negative stock" rows cancel out this way (one SKU holds +928, the other -928).
//  3. Closing Stock Amount of the clubbed product = Zoho's own amounts, SKU by SKU, with ONE change:
//       a SKU holding POSITIVE stock   -> its amount, as Zoho shows it
//       a SKU holding NIL stock        -> its amount, as Zoho shows it (even if there is no stock left: the books carry
//                                         it, so the statement shows it too)
//       a SKU holding NEGATIVE stock   -> minus the MODULUS of its amount (a negative amount is counted as it is, a
//                                         positive amount is subtracted), so negative stock can only lower the total
//     i.e. amount of the product = amount of its +ve SKUs - |amount of its -ve SKUs|. No rate is worked out and
//     no stock is multiplied by anything.
//  4. A product whose net Opening Stock or net Closing Stock is negative goes into the last line
//     "Other Stock Value Rs. 5 Lakhs or less" for the period, whatever its size. Its quantities are added in as
//     they are, so the Grand Totals of Opening, In, Out and Closing STOCK equal Zoho's own totals exactly.
//     If the product's NET closing stock is negative, its amount is -|amount| (again: it can only lower the
//     total). The Closing Stock AMOUNT total therefore differs from Zoho's only by what rule 3 and this rule
//     subtract; the difference is shown and every adjusted product is listed.
//  5. Products shown separately are the ones whose Closing Stock Amount went above Rs 5,00,000 at any month-end
//     of the financial year so far (or today). That list is fixed for the whole financial year, whichever period
//     is picked, and starts afresh each year (see stock-zoho.ts). Everything else is added into the last line.
//     A listed product that has NO closing stock and NO closing amount in the period is added into the last line
//     too (a line of zeros serves no purpose); its quantities, if it moved, stay in the totals.

export const LIST_THRESHOLD = 500000;
export const OTHER_LABEL = 'Other Stock Value Rs. 5 Lakhs or less';

/** One row of Zoho's Stock Summary report (one item SKU). */
export interface StockRow {
  itemId: string;
  name: string;
  opening: number;
  qtyIn: number;
  qtyOut: number;
  closing: number;
  closingValue: number;
}

export interface StockLine {
  key: string;
  name: string;
  unit: string;
  opening: number;
  qtyIn: number;
  qtyOut: number;
  closing: number;
  closingValue: number;
}

export type AdjustmentReason =
  | 'negative-stock-value-subtracted'; // stock is negative but Zoho shows a positive amount against it: the amount is subtracted

/** Plain-English reason for each kind of adjustment (page and Excel use the same words). */
export const ADJUSTMENT_TEXT: Record<AdjustmentReason, string> = {
  'negative-stock-value-subtracted': 'Stock is negative but Zoho shows a positive amount against it, so the amount is subtracted (it reduces the total)',
};

export interface Adjustment {
  key: string;
  name: string;
  opening: number;
  closing: number;
  zohoValue: number;
  usedValue: number;
  reason: AdjustmentReason;
  inOtherLine: boolean;
}

export interface Totals {
  opening: number;
  qtyIn: number;
  qtyOut: number;
  closing: number;
  closingValue: number;
}

export interface StockStatement {
  lines: StockLine[];
  other: StockLine & { itemCount: number; negativeCount: number; smallCount: number };
  total: Totals;
  /** Zoho's own Grand Total of the report, every row added up exactly as Zoho does */
  zoho: Totals;
  /** total.closingValue minus zoho.closingValue (the adjusted amounts) */
  valueDifference: number;
  /** Opening, In, Out and Closing STOCK of this statement equal Zoho's totals */
  quantitiesTie: boolean;
  /** every product whose amount differs from the sum of Zoho's rows */
  adjustments: Adjustment[];
  /** products (keys) whose Closing Stock Amount is above Rs 5,00,000 in this report: what the yearly list is built from */
  qualifying: { key: string; name: string }[];
}

const QTY_EPS = 0.0005;
const MONEY_EPS = 0.004;
const r3 = (x: number) => Math.round(x * 1000) / 1000 + 0; // + 0 turns -0 into 0
const r2 = (x: number) => Math.round(x * 100) / 100 + 0;

/** Same product = same name, ignoring capitals and stray spaces. */
export function itemKey(name: string): string {
  return String(name ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

interface Group {
  key: string;
  name: string;
  rows: StockRow[];
  opening: number;
  qtyIn: number;
  qtyOut: number;
  closing: number;
  zohoValue: number;
  value: number;
  reason?: AdjustmentReason;
}

/** Closing Stock Amount of one clubbed product (rules 3 and 4). */
function valueOfGroup(rows: StockRow[], closing: number, zohoValue: number): { value: number; reason?: AdjustmentReason } {
  // SKU by SKU: positive and nil stock keep Zoho's amount, negative stock is minus the modulus of its amount.
  let value = 0;
  for (const r of rows) value += r.closing < -QTY_EPS ? -Math.abs(r.closingValue) : r.closingValue;
  // The product as a whole is short of stock: whatever its amount, it only lowers the total.
  if (closing < -QTY_EPS) value = -Math.abs(value);
  value = r2(value);
  return { value, reason: Math.abs(value - zohoValue) > MONEY_EPS ? 'negative-stock-value-subtracted' : undefined };
}

export function groupRows(rows: StockRow[]): Group[] {
  const byKey = new Map<string, StockRow[]>();
  for (const r of rows) {
    const k = itemKey(r.name);
    if (!k) continue;
    const list = byKey.get(k);
    if (list) list.push(r);
    else byKey.set(k, [r]);
  }
  const out: Group[] = [];
  for (const [key, list] of byKey) {
    const opening = r3(list.reduce((s, r) => s + r.opening, 0));
    const qtyIn = r3(list.reduce((s, r) => s + r.qtyIn, 0));
    const qtyOut = r3(list.reduce((s, r) => s + r.qtyOut, 0));
    const closing = r3(list.reduce((s, r) => s + r.closing, 0));
    const zohoValue = r2(list.reduce((s, r) => s + r.closingValue, 0));
    const { value, reason } = valueOfGroup(list, closing, zohoValue);
    out.push({ key, name: list[0].name.replace(/\s+/g, ' ').trim(), rows: list, opening, qtyIn, qtyOut, closing, zohoValue, value, reason });
  }
  return out;
}

/** Products whose Closing Stock Amount is above Rs 5,00,000 in these rows (what joins the yearly list). */
export function qualifyingProducts(rows: StockRow[]): { key: string; name: string }[] {
  return groupRows(rows)
    .filter((g) => g.value > LIST_THRESHOLD)
    .map((g) => ({ key: g.key, name: g.name }));
}

const zeroTotals = (): Totals => ({ opening: 0, qtyIn: 0, qtyOut: 0, closing: 0, closingValue: 0 });

export function buildStatement(rows: StockRow[], listKeys: ReadonlySet<string>, unitOf: (itemId: string) => string = () => ''): StockStatement {
  const groups = groupRows(rows);
  const lines: StockLine[] = [];
  const other: StockLine & { itemCount: number; negativeCount: number; smallCount: number } = {
    key: '__other__', name: OTHER_LABEL, unit: '', opening: 0, qtyIn: 0, qtyOut: 0, closing: 0, closingValue: 0, itemCount: 0, negativeCount: 0, smallCount: 0,
  };
  const adjustments: Adjustment[] = [];

  for (const g of groups) {
    const negative = g.opening < -QTY_EPS || g.closing < -QTY_EPS;
    // An item on the year's list that has no stock and no amount left at the end of the period shows nothing worth a
    // line of its own (Jatin, 13 Oct): it is added into the last line, so its movement, if any, stays in the totals.
    const nothingLeft = Math.abs(g.closing) <= QTY_EPS && Math.abs(g.value) <= MONEY_EPS;
    const separate = !negative && listKeys.has(g.key) && !nothingLeft;
    if (separate) {
      // the unit of the SKU that holds the stock (else of the first SKU that has one)
      const holder = g.rows.find((r) => Math.abs(r.closing) > QTY_EPS && unitOf(r.itemId)) ?? g.rows.find((r) => unitOf(r.itemId));
      lines.push({ key: g.key, name: g.name, unit: holder ? unitOf(holder.itemId) : '', opening: g.opening, qtyIn: g.qtyIn, qtyOut: g.qtyOut, closing: g.closing, closingValue: g.value });
    } else {
      other.opening += g.opening;
      other.qtyIn += g.qtyIn;
      other.qtyOut += g.qtyOut;
      other.closing += g.closing;
      other.closingValue += g.value;
      const active = [g.opening, g.qtyIn, g.qtyOut, g.closing, g.value, g.zohoValue].some((v) => Math.abs(v) > MONEY_EPS);
      if (active) {
        other.itemCount += 1;
        if (negative) other.negativeCount += 1;
        else other.smallCount += 1;
      }
    }
    if (g.reason) {
      adjustments.push({ key: g.key, name: g.name, opening: g.opening, closing: g.closing, zohoValue: g.zohoValue, usedValue: g.value, reason: g.reason, inOtherLine: !separate });
    }
  }

  lines.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
  other.opening = r3(other.opening);
  other.qtyIn = r3(other.qtyIn);
  other.qtyOut = r3(other.qtyOut);
  other.closing = r3(other.closing);
  other.closingValue = r2(other.closingValue);

  const total = zeroTotals();
  for (const l of [...lines, other]) {
    total.opening += l.opening;
    total.qtyIn += l.qtyIn;
    total.qtyOut += l.qtyOut;
    total.closing += l.closing;
    total.closingValue += l.closingValue;
  }
  total.opening = r3(total.opening);
  total.qtyIn = r3(total.qtyIn);
  total.qtyOut = r3(total.qtyOut);
  total.closing = r3(total.closing);
  total.closingValue = r2(total.closingValue);

  const zoho = zeroTotals();
  for (const r of rows) {
    zoho.opening += r.opening;
    zoho.qtyIn += r.qtyIn;
    zoho.qtyOut += r.qtyOut;
    zoho.closing += r.closing;
    zoho.closingValue += r.closingValue;
  }
  zoho.opening = r3(zoho.opening);
  zoho.qtyIn = r3(zoho.qtyIn);
  zoho.qtyOut = r3(zoho.qtyOut);
  zoho.closing = r3(zoho.closing);
  zoho.closingValue = r2(zoho.closingValue);

  const tol = 0.002;
  const quantitiesTie =
    Math.abs(total.opening - zoho.opening) < tol && Math.abs(total.qtyIn - zoho.qtyIn) < tol && Math.abs(total.qtyOut - zoho.qtyOut) < tol && Math.abs(total.closing - zoho.closing) < tol;

  adjustments.sort((a, b) => Math.abs(b.usedValue - b.zohoValue) - Math.abs(a.usedValue - a.zohoValue) || a.name.localeCompare(b.name));

  return {
    lines,
    other,
    total,
    zoho,
    valueDifference: r2(total.closingValue - zoho.closingValue),
    quantitiesTie,
    adjustments,
    qualifying: groups.filter((g) => g.value > LIST_THRESHOLD).map((g) => ({ key: g.key, name: g.name })),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// What /api/stock sends to the page (types only: safe to import in the browser)

export interface StockApiData extends StockStatement {
  from: string;
  to: string;
  /** "FY27" */
  fy: string;
  /** how many products the year's list shows separately */
  listCount: number;
  /** when the figures were read from Zoho: the daily snapshot's completion time, or, for a live read, the moment of the read */
  pulledAt: string;
  /** true when this answer came from the daily snapshot (or from a live read kept for a few minutes) */
  cached: boolean;
  /** 'snapshot' = added up from the daily snapshot (the normal case); 'live' = a custom period that is not whole months, read from Zoho just now */
  source?: 'snapshot' | 'live';
  /** the India date the daily snapshot was read for */
  snapshotAsOf?: string;
  mock?: boolean;
  pages?: number;
  ms?: number;
}

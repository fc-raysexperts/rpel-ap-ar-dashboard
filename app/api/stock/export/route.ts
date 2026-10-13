import { NextRequest, NextResponse } from 'next/server';
import ExcelJS from 'exceljs';
import { getStock, todayIST } from '@/lib/stock-service';
import { clampStockRange, prettyStockDate } from '@/lib/stock-period';
import { ADJUSTMENT_TEXT, OTHER_LABEL, type StockApiData } from '@/lib/stock-calculator';
import { FIRM_NAME } from '@/lib/brand';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const NAVY = 'FF0F2547'; // the navy of the site's table headings
const TOTAL_FILL = 'FFE4ECFB';
const OTHER_FILL = 'FFFBF1DC';
const MONEY = '#,##0.00;[Red]-#,##0.00';

/** The fewest decimals (0 to 3) that show a quantity exactly, so 143 is not "143.000" and 12.5 is not "12.50". */
function qtyFormat(v: number): string {
  const s = String(Math.round(Math.abs(v) * 1000) / 1000);
  const dot = s.indexOf('.');
  const d = dot < 0 || s.includes('e') ? 0 : Math.min(3, s.length - dot - 1);
  const base = d === 0 ? '#,##0' : `#,##0.${'0'.repeat(d)}`;
  return `${base};[Red]-${base}`;
}

/** How many characters a number will take on screen. */
const digitsOf = (v: number, decimals: number) => v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).length;

function widthFor(longest: number, heading: string, min: number, max: number): number {
  const word = heading.split(/\s+/).reduce((m, w) => Math.max(m, w.length), 0) * 1.15;
  return Math.min(Math.ceil(Math.max(longest + 3, word + 4, min)), max);
}

function istStamp(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' IST';
}

function headerRow(row: ExcelJS.Row, rightFrom: number) {
  row.height = 34;
  row.eachCell((cell, n) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
    cell.alignment = { vertical: 'middle', horizontal: n >= rightFrom ? 'right' : 'left', wrapText: true };
  });
}

function statementSheet(wb: ExcelJS.Workbook, d: StockApiData) {
  const ws = wb.addWorksheet('Stock Statement', { views: [{ state: 'frozen', ySplit: 5 }] });

  ws.getCell('A1').value = FIRM_NAME;
  ws.getCell('A1').font = { bold: true, size: 14, color: { argb: NAVY } };
  ws.getCell('A2').value = 'Stock Statement';
  ws.getCell('A2').font = { bold: true, size: 12 };
  ws.getCell('A3').value = `Period: ${prettyStockDate(d.from)} to ${prettyStockDate(d.to)}   |   Source: Zoho Books Stock Summary report${d.mock ? ' (sample data)' : d.source === 'live' ? `, read live ${istStamp(d.pulledAt)}` : `, data as of ${istStamp(d.pulledAt)} (read once a day, at 7:45 am IST)`}`;
  ws.getCell('A3').font = { size: 10, color: { argb: 'FF5A6678' } };

  const heads = ['Item Name', 'Unit', 'Opening Stock', 'Quantity In', 'Quantity Out', 'Closing Stock', 'Closing Stock Amount (Rs.)'];
  const head = ws.getRow(5);
  heads.forEach((h, i) => (head.getCell(i + 1).value = h));
  headerRow(head, 3);

  const all = [...d.lines, d.other];
  const qtyKeys = ['opening', 'qtyIn', 'qtyOut', 'closing'] as const;

  all.forEach((l, i) => {
    const isOther = l === d.other;
    const row = ws.getRow(6 + i);
    row.getCell(1).value = isOther ? OTHER_LABEL : l.name;
    row.getCell(2).value = isOther ? '' : l.unit;
    qtyKeys.forEach((k, j) => {
      const cell = row.getCell(3 + j);
      cell.value = l[k];
      cell.numFmt = qtyFormat(l[k]);
    });
    const amount = row.getCell(7);
    amount.value = l.closingValue;
    amount.numFmt = MONEY;
    for (let c = 1; c <= 7; c++) {
      const cell = row.getCell(c);
      cell.alignment = { vertical: 'top', horizontal: c >= 3 ? 'right' : 'left', wrapText: c === 1 };
      cell.border = { bottom: { style: 'hair', color: { argb: 'FFB8C4D6' } } };
      if (isOther) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: OTHER_FILL } };
        cell.font = { bold: true };
        cell.border = { top: { style: 'thin', color: { argb: 'FFB7791F' } }, bottom: { style: 'thin', color: { argb: 'FFB7791F' } } };
      }
    }
  });

  const totalRowNo = 6 + all.length;
  const tr = ws.getRow(totalRowNo);
  tr.getCell(1).value = 'GRAND TOTAL';
  qtyKeys.forEach((k, j) => {
    const cell = tr.getCell(3 + j);
    cell.value = d.total[k];
    cell.numFmt = qtyFormat(d.total[k]);
  });
  tr.getCell(7).value = d.total.closingValue;
  tr.getCell(7).numFmt = MONEY;
  for (let c = 1; c <= 7; c++) {
    const cell = tr.getCell(c);
    cell.font = { bold: true, size: 11 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TOTAL_FILL } };
    cell.border = { top: { style: 'medium', color: { argb: NAVY } } };
    cell.alignment = { vertical: 'middle', horizontal: c >= 3 ? 'right' : 'left' };
  }
  tr.height = 22;

  const notes = [
    `Items on their own line: Closing Stock Amount above Rs 5,00,000 at any month-end of ${d.fy} (${d.listCount} items this year; one with no closing stock and no closing amount in the period is not shown on its own). Everything else, and any item with negative opening or closing stock, is in the last line.`,
    `Zoho's own Grand Total of Closing Stock Amount for this period is Rs ${d.zoho.closingValue.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}; the difference is explained on the "Working" sheet.`,
  ];
  notes.forEach((t, i) => {
    const c = ws.getCell(totalRowNo + 2 + i, 1);
    c.value = t;
    c.font = { italic: true, size: 10, color: { argb: 'FF5A6678' } };
  });

  // every column as wide as its own contents need
  const nameLen = all.reduce((m, l) => Math.max(m, l === d.other ? OTHER_LABEL.length : l.name.length), 0);
  ws.getColumn(1).width = widthFor(nameLen, heads[0], 30, 60);
  ws.getColumn(2).width = widthFor(all.reduce((m, l) => Math.max(m, l.unit.length), 0), heads[1], 8, 14);
  qtyKeys.forEach((k, j) => {
    let longest = digitsOf(d.total[k], 3) * 1.12;
    for (const l of all) longest = Math.max(longest, digitsOf(l[k], Math.abs(l[k] % 1) > 0.0005 ? 3 : 0));
    ws.getColumn(3 + j).width = widthFor(longest, heads[2 + j], 13, 24);
  });
  let moneyLongest = digitsOf(d.total.closingValue, 2) * 1.12;
  for (const l of all) moneyLongest = Math.max(moneyLongest, digitsOf(l.closingValue, 2));
  ws.getColumn(7).width = widthFor(moneyLongest, heads[6], 18, 30);

  ws.autoFilter = { from: { row: 5, column: 1 }, to: { row: 5 + d.lines.length, column: 7 } }; // the listed items; the last line and the total stay put
  ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '5:5' };
}

function workingSheet(wb: ExcelJS.Workbook, d: StockApiData) {
  const ws = wb.addWorksheet('Working');
  const bold = { bold: true } as const;

  ws.getCell('A1').value = 'How the totals were worked out';
  ws.getCell('A1').font = { bold: true, size: 14, color: { argb: NAVY } };
  ws.getCell('A2').value = `Period: ${prettyStockDate(d.from)} to ${prettyStockDate(d.to)}`;
  ws.getCell('A2').font = { size: 10, color: { argb: 'FF5A6678' } };

  // 1. agreement with Zoho
  const r1 = ws.getRow(4);
  ['Grand Total', 'This statement', "Zoho's report", 'Difference'].forEach((h, i) => (r1.getCell(i + 1).value = h));
  headerRow(r1, 2);
  const figures: { label: string; ours: number; theirs: number; money?: boolean }[] = [
    { label: 'Opening Stock', ours: d.total.opening, theirs: d.zoho.opening },
    { label: 'Quantity In', ours: d.total.qtyIn, theirs: d.zoho.qtyIn },
    { label: 'Quantity Out', ours: d.total.qtyOut, theirs: d.zoho.qtyOut },
    { label: 'Closing Stock', ours: d.total.closing, theirs: d.zoho.closing },
    { label: 'Closing Stock Amount (Rs.)', ours: d.total.closingValue, theirs: d.zoho.closingValue, money: true },
  ];
  figures.forEach((f, i) => {
    const row = ws.getRow(5 + i);
    const diff = Math.round((f.ours - f.theirs) * 1000) / 1000 + 0;
    row.getCell(1).value = f.label;
    [f.ours, f.theirs, diff].forEach((v, j) => {
      const cell = row.getCell(2 + j);
      cell.value = v;
      cell.numFmt = f.money ? MONEY : qtyFormat(v);
      cell.alignment = { horizontal: 'right' };
    });
    for (let c = 1; c <= 4; c++) row.getCell(c).border = { bottom: { style: 'hair', color: { argb: 'FFB8C4D6' } } };
  });
  ws.getCell('A10').value = d.quantitiesTie ? 'Opening, In, Out and Closing Stock agree with Zoho’s report.' : 'WARNING: the stock quantities do not agree with Zoho’s report. Please check.';
  ws.getCell('A10').font = { ...bold, color: { argb: d.quantitiesTie ? 'FF0B7A62' : 'FFC2362B' } };

  // 2. the rules, in words
  const rules = [
    'Every quantity is Zoho’s own, simply added up. Nothing is floored, topped up or changed.',
    'The old SKU and the "_New" SKU of one item (same item name) are clubbed into one line by adding their stock.',
    'Closing Stock Amount: Zoho’s own amount of each SKU, as it is (an amount that Zoho still shows on nil stock is shown too), except that a SKU with negative stock has the modulus of its amount subtracted: a negative Zoho amount is counted as it is and a positive Zoho amount is subtracted. So the amount of an item = amount of its SKUs with positive stock - |amount of its SKUs with negative stock|. An item whose net closing stock is negative is shown in the last line with its amount likewise subtracted.',
    `Items listed on their own line: Closing Stock Amount above Rs 5,00,000 at any month-end of ${d.fy} (or today), ${d.listCount} items this year. The list is worked out again every morning from Zoho’s own month-end figures, is the same whichever period is picked, and starts afresh each April. An item on it with no closing stock and no closing amount in the period is added into the last line instead.`,
    'The last line adds up every other item, and every item with negative opening or closing stock (its quantities are added as they are).',
  ];
  rules.forEach((t, i) => {
    const r = 12 + i;
    ws.mergeCells(r, 1, r, 8);
    const c = ws.getCell(r, 1);
    c.value = t;
    c.alignment = { wrapText: true, vertical: 'top' };
    ws.getRow(r).height = Math.max(16, Math.ceil(t.length / 120) * 15);
  });

  // 3. every item whose amount differs from Zoho's
  const start = 12 + rules.length + 1;
  ws.getCell(start, 1).value = `${d.adjustments.length} ${d.adjustments.length === 1 ? 'item' : 'items'} whose Closing Stock Amount differs from Zoho’s`;
  ws.getCell(start, 1).font = { bold: true, size: 12, color: { argb: NAVY } };
  const heads = ['Item', 'Opening Stock', 'Closing Stock', "Zoho's amount (Rs.)", 'Amount used (Rs.)', 'Difference (Rs.)', 'Where', 'Why'];
  const hr = ws.getRow(start + 1);
  heads.forEach((h, i) => (hr.getCell(i + 1).value = h));
  headerRow(hr, 2);
  hr.getCell(7).alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
  hr.getCell(8).alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };

  let nameLen = 'Closing Stock Amount (Rs.)'.length;
  d.adjustments.forEach((a, i) => {
    const row = ws.getRow(start + 2 + i);
    row.getCell(1).value = a.name;
    row.getCell(2).value = a.opening;
    row.getCell(2).numFmt = qtyFormat(a.opening);
    row.getCell(3).value = a.closing;
    row.getCell(3).numFmt = qtyFormat(a.closing);
    row.getCell(4).value = a.zohoValue;
    row.getCell(5).value = a.usedValue;
    row.getCell(6).value = Math.round((a.usedValue - a.zohoValue) * 100) / 100 + 0;
    [4, 5, 6].forEach((c) => (row.getCell(c).numFmt = MONEY));
    row.getCell(7).value = a.inOtherLine ? 'Last line' : 'Own line';
    row.getCell(8).value = ADJUSTMENT_TEXT[a.reason];
    for (let c = 1; c <= 8; c++) {
      row.getCell(c).alignment = { vertical: 'top', horizontal: c >= 2 && c <= 6 ? 'right' : 'left', wrapText: c === 1 || c === 8 };
      row.getCell(c).border = { bottom: { style: 'hair', color: { argb: 'FFB8C4D6' } } };
    }
    nameLen = Math.max(nameLen, a.name.length);
  });

  ws.getColumn(1).width = Math.min(Math.max(nameLen + 3, 30), 60);
  [2, 3].forEach((c) => (ws.getColumn(c).width = 16));
  [4, 5, 6].forEach((c) => (ws.getColumn(c).width = 20));
  ws.getColumn(7).width = 12;
  ws.getColumn(8).width = 70;
  ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
}

export async function GET(req: NextRequest) {
  try {
    const today = todayIST();
    const sp = req.nextUrl.searchParams;
    const range = clampStockRange(sp.get('from'), sp.get('to'), today);
    const res = await getStock(range.from, range.to, { today });
    if (res.building) {
      return NextResponse.json(
        { error: 'The stock data is still being read from Zoho Books for the first time. Wait for the Stock Statement tab to finish loading, then download again.' },
        { status: 409 }
      );
    }
    const d = res.data;

    const wb = new ExcelJS.Workbook();
    wb.creator = 'RPEL Accounts Ledger';
    wb.created = new Date();
    statementSheet(wb, d);
    workingSheet(wb, d);

    const buffer = await wb.xlsx.writeBuffer();
    const filename = `RPEL_Stock_${d.from}_to_${d.to}.xlsx`;
    return new NextResponse(new Blob([buffer]), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    console.error('Stock Excel export failed:', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown error building the Excel file' }, { status: 500 });
  }
}

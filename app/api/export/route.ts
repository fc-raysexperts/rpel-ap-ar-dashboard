import { NextRequest, NextResponse } from 'next/server';
import ExcelJS from 'exceljs';
import { computeARSummary } from '@/lib/ar-calculator';
import { computeAPSummary } from '@/lib/ap-calculator';
import { getRawData } from '@/lib/get-raw-data';
import { getLedgerFor, effectiveAsOf, cacheDay } from '@/lib/ledger';
import { ZB_EARLIEST_DATE, clampISO, rangeFrom } from '@/lib/period';
import { loadAging } from '@/lib/aging';
import { getMockARSummary, getMockAPSummary, isMockMode } from '@/lib/mock-data';

export const dynamic = 'force-dynamic';

const NUM_FMT = '#,##0.00';
const HEADER_FILL = 'FF0F2547'; // the navy of the site's table headings
const TOTAL_FILL_AR = 'FFE3F1EC';
const TOTAL_FILL_AP = 'FFF9E6E3';

interface Col {
  header: string;
  key: string;
  type: 'text' | 'int' | 'money';
  /** the widest this column may get; a longer text wraps onto a second line instead */
  maxWidth: number;
  minWidth: number;
}

/** How many characters a cell will show. */
function shown(v: unknown, type: Col['type']): number {
  if (v === null || v === undefined || v === '') return 0;
  if (type === 'money' && typeof v === 'number') {
    return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).length;
  }
  // a text that already has line breaks needs only its longest line
  return String(v)
    .split('\n')
    .reduce((m, line) => Math.max(m, line.length), 0);
}

/**
 * One sheet: styled heading, the rows, a bold Grand Total, and every column as wide as ITS OWN contents need
 * (the longest value in it, the longest word of its heading, within a sensible minimum and maximum) rather than
 * one width for all.
 */
function addSheet(
  wb: ExcelJS.Workbook,
  name: string,
  cols: Col[],
  rows: Record<string, unknown>[],
  total: Record<string, unknown>,
  totalFill: string
) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = cols.map((c) => ({ header: c.header, key: c.key, style: c.type === 'money' ? { numFmt: NUM_FMT } : {} }));

  // widths: from the data, the Grand Total and the heading's longest word
  cols.forEach((c, i) => {
    let longest = 0;
    for (const r of rows) longest = Math.max(longest, shown(r[c.key], c.type));
    longest = Math.max(longest, shown(total[c.key], c.type) * 1.12); // the total is bold
    const longestHeadingWord = c.header.split(/\s+/).reduce((m, w) => Math.max(m, w.length), 0) * 1.15;
    const width = Math.ceil(Math.max(longest + 3, longestHeadingWord + 4, c.minWidth));
    ws.getColumn(i + 1).width = Math.min(width, c.maxWidth);
  });

  // heading row
  const head = ws.getRow(1);
  head.height = 34;
  head.eachCell((cell, n) => {
    const c = cols[n - 1];
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
    cell.alignment = { vertical: 'middle', horizontal: c.type === 'money' ? 'right' : c.type === 'int' ? 'center' : 'left', wrapText: true };
  });

  // rows
  rows.forEach((r) => ws.addRow(r));
  const first = 2;
  const last = rows.length + 1;
  for (let n = first; n <= last; n++) {
    const row = ws.getRow(n);
    cols.forEach((c, i) => {
      const cell = row.getCell(i + 1);
      cell.alignment = {
        vertical: 'top',
        horizontal: c.type === 'int' ? 'center' : c.type === 'money' ? 'right' : 'left',
        wrapText: c.type === 'text', // a long name goes onto a second line instead of being cut off
      };
      cell.border = { bottom: { style: 'hair', color: { argb: 'FFB8C4D6' } } };
    });
  }

  // Grand Total
  const totalRow = ws.addRow(total);
  cols.forEach((c, i) => {
    const cell = totalRow.getCell(i + 1); // every column, so the tint and the top rule run the full width
    cell.font = { bold: true, size: 11 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: totalFill } };
    cell.border = { top: { style: 'medium', color: { argb: HEADER_FILL } } };
    cell.alignment = { vertical: 'middle', horizontal: c.type === 'money' ? 'right' : 'left' };
  });
  totalRow.height = 22;

  if (rows.length > 0) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: last, column: cols.length } };
  ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
  return ws;
}

export async function GET(req: NextRequest) {
  // 'ar' or 'ap' gives that one sheet; no kind (what the page's download button sends) gives both.
  const kind = req.nextUrl.searchParams.get('kind');
  if (kind !== null && kind !== 'ar' && kind !== 'ap') {
    return NextResponse.json({ error: "kind must be 'ar' or 'ap' (or left out for both)" }, { status: 400 });
  }
  const requested = req.nextUrl.searchParams.get('asOf') ?? new Date().toISOString().slice(0, 10);
  const wantAR = kind === null || kind === 'ar';
  const wantAP = kind === null || kind === 'ap';

  try {
    const mock = isMockMode();
    const raw = mock ? null : await getRawData();
    // the date the workbook is really for: a date after the daily snapshot's own day is answered as of that day,
    // and nothing is answered for a day before the books begin
    const asOf = raw ? clampISO(effectiveAsOf(requested, raw), ZB_EARLIEST_DATE, cacheDay(raw.fetchedAt)) : requested;
    // custom range: only documents dated From..To (the same rule as the page)
    const from = raw ? rangeFrom(req.nextUrl.searchParams.get('from'), asOf) : undefined;

    const wb = new ExcelJS.Workbook();
    wb.creator = 'RPEL Accounts Ledger';
    wb.created = new Date();

    if (wantAR) {
      let summary;
      if (!raw) summary = getMockARSummary();
      else if (from) summary = computeARSummary(raw, asOf, { from });
      else {
        const got = await getLedgerFor(asOf, raw);
        const usable = got.basis !== 'snapshot' || (got.ledger?.customers.size ?? 0) > 0;
        const aging = got.basis === 'snapshot' && usable ? await loadAging(asOf) : null;
        summary = computeARSummary(raw, asOf, { ledger: usable ? got.ledger : null, historical: got.basis === 'snapshot' && usable, aging });
      }
      addSheet(
        wb,
        'Accounts Receivable',
        [
          { header: 'Sr. No.', key: 'sr', type: 'int', minWidth: 8, maxWidth: 12 },
          { header: 'Customer Name', key: 'name', type: 'text', minWidth: 24, maxWidth: 60 },
          { header: 'Less Than 180 Days (Rs.)', key: 'less180', type: 'money', minWidth: 14, maxWidth: 28 },
          { header: 'More Than 180 Days (Rs.)', key: 'more180', type: 'money', minWidth: 14, maxWidth: 28 },
          { header: 'Credits (Rs.)', key: 'credits', type: 'money', minWidth: 14, maxWidth: 28 },
          { header: 'Net Total (Rs.)', key: 'net', type: 'money', minWidth: 14, maxWidth: 28 },
          { header: 'Unreconciled (Rs.)', key: 'gap', type: 'money', minWidth: 14, maxWidth: 28 },
        ],
        summary.customers.map((c, i) => ({
          sr: i + 1,
          name: c.customerName,
          less180: c.less180,
          more180: c.more180,
          credits: c.unappliedCredits,
          net: c.netTotal,
          gap: c.gap || null,
        })),
        {
          sr: '',
          name: 'GRAND TOTAL',
          less180: summary.grandTotal.less180,
          more180: summary.grandTotal.more180,
          credits: summary.grandTotal.unappliedCredits,
          net: summary.grandTotal.netTotal,
        },
        TOTAL_FILL_AR
      );
    }

    if (wantAP) {
      let summary;
      if (!raw) summary = getMockAPSummary();
      else if (from) summary = computeAPSummary(raw, asOf, { from });
      else {
        const got = await getLedgerFor(asOf, raw);
        const usable = got.basis !== 'snapshot' || (got.ledger?.vendors.size ?? 0) > 0;
        summary = computeAPSummary(raw, asOf, { ledger: usable ? got.ledger : null, historical: got.basis === 'snapshot' && usable });
      }
      addSheet(
        wb,
        'Accounts Payable',
        [
          { header: 'Sr. No.', key: 'sr', type: 'int', minWidth: 8, maxWidth: 12 },
          { header: 'Vendor Name', key: 'name', type: 'text', minWidth: 24, maxWidth: 60 },
          { header: 'Billed Total (Rs.)', key: 'billed', type: 'money', minWidth: 14, maxWidth: 28 },
          { header: 'Credits (Rs.)', key: 'credits', type: 'money', minWidth: 14, maxWidth: 28 },
          { header: 'Net Total (Rs.)', key: 'net', type: 'money', minWidth: 14, maxWidth: 28 },
          { header: 'Unreconciled (Rs.)', key: 'gap', type: 'money', minWidth: 14, maxWidth: 28 },
        ],
        summary.vendors.map((v, i) => ({
          sr: i + 1,
          name: v.vendorName,
          billed: v.billedTotal,
          credits: v.unappliedCredits,
          net: v.netTotal,
          gap: v.gap || null,
        })),
        {
          sr: '',
          name: 'GRAND TOTAL',
          billed: summary.grandTotal.billedTotal,
          credits: summary.grandTotal.unappliedCredits,
          net: summary.grandTotal.netTotal,
        },
        TOTAL_FILL_AP
      );
    }

    const buffer = await wb.xlsx.writeBuffer();
    const filename = `RPEL_${kind === null ? 'AP_AR' : kind.toUpperCase()}_${from ? `${from}_to_${asOf}` : asOf}.xlsx`;

    return new NextResponse(new Blob([buffer]), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    console.error('Excel export failed:', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown error building the Excel file' }, { status: 500 });
  }
}

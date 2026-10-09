import { NextRequest, NextResponse } from 'next/server';
import ExcelJS from 'exceljs';
import { computeARSummary } from '@/lib/ar-calculator';
import { computeAPSummary } from '@/lib/ap-calculator';
import { getRawData } from '@/lib/get-raw-data';
import { getLedgerFor, effectiveAsOf } from '@/lib/ledger';
import { loadAging } from '@/lib/aging';
import { getMockARSummary, getMockAPSummary, isMockMode } from '@/lib/mock-data';

export const dynamic = 'force-dynamic';

const CURRENCY_FMT = '#,##0.00';

export async function GET(req: NextRequest) {
  const kind = req.nextUrl.searchParams.get('kind'); // 'ar' | 'ap'
  const requested = req.nextUrl.searchParams.get('asOf') ?? new Date().toISOString().slice(0, 10);
  // the date the workbook is really for (a date after the daily snapshot's own day is answered as of that day)
  let asOf = requested;

  if (kind !== 'ar' && kind !== 'ap') {
    return NextResponse.json({ error: "kind must be 'ar' or 'ap'" }, { status: 400 });
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'RPEL AP/AR Ledger';
  wb.created = new Date();

  if (kind === 'ar') {
    let summary;
    if (isMockMode()) summary = getMockARSummary();
    else {
      const raw = await getRawData();
      asOf = effectiveAsOf(requested, raw);
      const got = await getLedgerFor(asOf, raw);
      const usable = got.basis !== 'snapshot' || (got.ledger?.customers.size ?? 0) > 0;
      const aging = got.basis === 'snapshot' && usable ? await loadAging(asOf) : null;
      summary = computeARSummary(raw, asOf, { ledger: usable ? got.ledger : null, historical: got.basis === 'snapshot' && usable, aging });
    }
    const ws = wb.addWorksheet('Debtors (AR)');
    ws.columns = [
      { header: 'Sr. No.', key: 'sr', width: 8 },
      { header: 'Customer Name', key: 'name', width: 42 },
      { header: 'Less Than 180 Days (Rs.)', key: 'less180', width: 20, style: { numFmt: CURRENCY_FMT } },
      { header: 'More Than 180 Days (Rs.)', key: 'more180', width: 20, style: { numFmt: CURRENCY_FMT } },
      { header: 'Unapplied Credits (Rs.)', key: 'credits', width: 20, style: { numFmt: CURRENCY_FMT } },
      { header: 'Net Total (Rs.)', key: 'net', width: 20, style: { numFmt: CURRENCY_FMT } },
      { header: 'Unreconciled (Rs.)', key: 'gap', width: 20, style: { numFmt: CURRENCY_FMT } },
    ];
    ws.getRow(1).font = { bold: true };
    summary.customers.forEach((c, i) => {
      ws.addRow({
        sr: i + 1,
        name: c.customerName,
        less180: c.less180,
        more180: c.more180,
        credits: c.unappliedCredits,
        net: c.netTotal,
        gap: c.gap || null,
      });
    });
    const totalRow = ws.addRow({
      sr: '',
      name: 'Grand Total',
      less180: summary.grandTotal.less180,
      more180: summary.grandTotal.more180,
      credits: summary.grandTotal.unappliedCredits,
      net: summary.grandTotal.netTotal,
    });
    totalRow.font = { bold: true };
  } else {
    let summary;
    if (isMockMode()) summary = getMockAPSummary();
    else {
      const raw = await getRawData();
      asOf = effectiveAsOf(requested, raw);
      const got = await getLedgerFor(asOf, raw);
      const usable = got.basis !== 'snapshot' || (got.ledger?.vendors.size ?? 0) > 0;
      summary = computeAPSummary(raw, asOf, { ledger: usable ? got.ledger : null, historical: got.basis === 'snapshot' && usable });
    }
    const ws = wb.addWorksheet('Creditors (AP)');
    ws.columns = [
      { header: 'Sr. No.', key: 'sr', width: 8 },
      { header: 'Vendor Name', key: 'name', width: 42 },
      { header: 'Billed Total (Rs.)', key: 'billed', width: 20, style: { numFmt: CURRENCY_FMT } },
      { header: 'Unapplied Credits (Rs.)', key: 'credits', width: 20, style: { numFmt: CURRENCY_FMT } },
      { header: 'Net Total (Rs.)', key: 'net', width: 20, style: { numFmt: CURRENCY_FMT } },
      { header: 'Unreconciled (Rs.)', key: 'gap', width: 20, style: { numFmt: CURRENCY_FMT } },
    ];
    ws.getRow(1).font = { bold: true };
    summary.vendors.forEach((v, i) => {
      ws.addRow({
        sr: i + 1,
        name: v.vendorName,
        billed: v.billedTotal,
        credits: v.unappliedCredits,
        net: v.netTotal,
        gap: v.gap || null,
      });
    });
    const totalRow = ws.addRow({
      sr: '',
      name: 'Grand Total',
      billed: summary.grandTotal.billedTotal,
      credits: summary.grandTotal.unappliedCredits,
      net: summary.grandTotal.netTotal,
    });
    totalRow.font = { bold: true };
  }

  const buffer = await wb.xlsx.writeBuffer();
  const filename = `RPEL_${kind.toUpperCase()}_${asOf}.xlsx`;

  return new NextResponse(new Blob([buffer]), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}

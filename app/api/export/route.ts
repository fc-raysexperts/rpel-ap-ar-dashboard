import { NextRequest, NextResponse } from 'next/server';
import ExcelJS from 'exceljs';
import { computeARSummary } from '@/lib/ar-calculator';
import { computeAPSummary } from '@/lib/ap-calculator';
import { getMockARSummary, getMockAPSummary, isMockMode } from '@/lib/mock-data';

export const dynamic = 'force-dynamic';

const CURRENCY_FMT = '#,##0.00';

export async function GET(req: NextRequest) {
  const kind = req.nextUrl.searchParams.get('kind'); // 'ar' | 'ap'
  const since = req.nextUrl.searchParams.get('since') ?? undefined;

  if (kind !== 'ar' && kind !== 'ap') {
    return NextResponse.json({ error: "kind must be 'ar' or 'ap'" }, { status: 400 });
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'RPEL AP/AR Ledger';
  wb.created = new Date();

  if (kind === 'ar') {
    const summary = isMockMode() ? getMockARSummary() : await computeARSummary(since);
    const ws = wb.addWorksheet('Debtors (AR)');
    ws.columns = [
      { header: 'Sr. No.', key: 'sr', width: 8 },
      { header: 'Customer Name', key: 'name', width: 42 },
      { header: 'Less Than 180 Days (Rs.)', key: 'less180', width: 20, style: { numFmt: CURRENCY_FMT } },
      { header: 'More Than 180 Days (Rs.)', key: 'more180', width: 20, style: { numFmt: CURRENCY_FMT } },
      { header: 'Unapplied Credits (Rs.)', key: 'credits', width: 20, style: { numFmt: CURRENCY_FMT } },
      { header: 'Net Total (Rs.)', key: 'net', width: 20, style: { numFmt: CURRENCY_FMT } },
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
    const summary = isMockMode() ? getMockAPSummary() : await computeAPSummary(since);
    const ws = wb.addWorksheet('Creditors (AP)');
    ws.columns = [
      { header: 'Sr. No.', key: 'sr', width: 8 },
      { header: 'Vendor Name', key: 'name', width: 42 },
      { header: 'Billed Total (Rs.)', key: 'billed', width: 20, style: { numFmt: CURRENCY_FMT } },
      { header: 'Unapplied Credits (Rs.)', key: 'credits', width: 20, style: { numFmt: CURRENCY_FMT } },
      { header: 'Net Total (Rs.)', key: 'net', width: 20, style: { numFmt: CURRENCY_FMT } },
    ];
    ws.getRow(1).font = { bold: true };
    summary.vendors.forEach((v, i) => {
      ws.addRow({
        sr: i + 1,
        name: v.vendorName,
        billed: v.billedTotal,
        credits: v.unappliedCredits,
        net: v.netTotal,
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
  const filename = `RPEL_${kind.toUpperCase()}_${new Date().toISOString().slice(0, 10)}.xlsx`;

  return new NextResponse(new Blob([buffer]), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}

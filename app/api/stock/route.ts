import { NextRequest, NextResponse } from 'next/server';
import { getStock, todayIST } from '@/lib/stock-service';
import { clampStockRange } from '@/lib/stock-period';

export const dynamic = 'force-dynamic';
// The very first call ever (no daily copy saved yet) reads one report per month from Zoho; it hands back "still
// preparing" well before this limit and the page asks again, so this is only a safety net.
export const maxDuration = 300;

/**
 * The Stock Statement for a period, from the daily copy of Zoho's Stock Summary (read once a day at 07:45 IST).
 *   /api/stock?from=2026-09-01&to=2026-09-30
 * Answers { building: true, progress } only while that daily copy is being read for the very first time.
 * A custom period that is not made of whole months is read from Zoho directly (answer has source: "live").
 */
export async function GET(req: NextRequest) {
  try {
    const today = todayIST();
    const sp = req.nextUrl.searchParams;
    const range = clampStockRange(sp.get('from'), sp.get('to'), today);
    const res = await getStock(range.from, range.to, { today });
    if (res.building) return NextResponse.json({ building: true, progress: res.progress, busy: res.busy });
    return NextResponse.json({ ...res.data, rangeAdjusted: range.changed });
  } catch (err) {
    console.error('Stock statement failed:', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown error reading the stock statement' }, { status: 500 });
  }
}

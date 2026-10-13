import { NextRequest, NextResponse } from 'next/server';
import { getUnits } from '@/lib/stock-zoho';
import { ensureSnapshot } from '@/lib/stock-snapshot';
import { todayIST } from '@/lib/stock-service';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * THE daily Stock Statement refresh (vercel.json: 07:45 India time, after the Debtors / Creditors refresh has
 * finished, so the two never read Zoho at the same time). It reads Zoho's Stock Summary for EVERY month from April
 * 2026 to today (earlier months too, because Zoho lets them change), plus the item units, and saves them. Everyone
 * who opens the Stock Statement tab during the next 24 hours is shown that copy instantly.
 *
 *   ?force=1   read everything again even though it was already read today (use after a correction in Zoho,
 *              or for the very first load)
 *
 * - If anything fails or runs out of time, yesterday's copy is left exactly as it was (the page keeps showing it);
 *   call this again and it carries on where it stopped.
 * - Protected by CRON_SECRET exactly like the 7 AM refresh.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const today = todayIST();
    const force = req.nextUrl.searchParams.get('force') === '1';
    const progress = await ensureSnapshot(today, 230_000, { force });
    // the units only change when items are added, so they are renewed whenever a snapshot is written
    const units = progress.complete && !progress.skipped ? await getUnits({ force: true }) : await getUnits({ staleOk: true });
    const meta = progress.meta;
    return NextResponse.json({
      ok: true,
      asOf: today,
      months: { done: progress.done, total: progress.total, complete: progress.complete, readThisRun: progress.builtNow, busy: progress.busy },
      note: progress.skipped
        ? 'The copy was already read today; add ?force=1 to read Zoho again anyway.'
        : progress.complete
          ? 'The copy is complete and is now what the Stock Statement tab shows.'
          : 'Not finished: call this again to carry on. The tab keeps showing the previous copy meanwhile.',
      snapshot: meta
        ? {
            builtAt: meta.builtAt,
            asOf: meta.asOf,
            productsOnTheList: Object.fromEntries(Object.entries(meta.lists).map(([fy, l]) => [`FY${String(Number(fy) + 1).slice(-2)}`, Object.keys(l).length])),
            monthsChainedChecked: meta.chain.pairs,
            monthsThatDoNotChain: meta.chain.breaks,
            chainExamples: meta.chain.examples,
          }
        : null,
      itemUnitsKnown: Object.keys(units.units).length,
    });
  } catch (err) {
    console.error('Stock cron failed (the previous copy is untouched):', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown error', previousCopyKept: true }, { status: 500 });
  }
}

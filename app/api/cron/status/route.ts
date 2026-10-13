import { NextResponse } from 'next/server';
import { getJournalJobProgress } from '@/lib/journal-job';
import { getCachedFetchedAt } from '@/lib/cache';
import { readSnapshot } from '@/lib/stock-snapshot';

export const dynamic = 'force-dynamic';

/**
 * Read-only: shows when the data the dashboard is displaying was last read from Zoho (it is refreshed once a
 * day, at 07:00 AM IST), where the journal step stands, and the Stock Statement's daily copy (read at 07:45 AM IST).
 * Does not start or advance anything.
 */
export async function GET() {
  const [progress, snapshotReadAt, stockSnap] = await Promise.all([getJournalJobProgress(), getCachedFetchedAt(), readSnapshot().catch(() => null)]);
  const hours = snapshotReadAt ? (Date.now() - new Date(snapshotReadAt).getTime()) / 3_600_000 : null;
  return NextResponse.json({
    snapshotReadAt,
    snapshotAgeHours: hours === null ? null : Math.round(hours * 10) / 10,
    refreshSchedule: 'once a day at 07:00 AM IST (01:30 UTC)',
    journalJob: progress,
    stockStatement: stockSnap
      ? {
          copyReadAt: stockSnap.builtAt,
          copyIsForDay: stockSnap.asOf,
          months: stockSnap.months.length,
          refreshSchedule: 'once a day at 07:45 AM IST (02:15 UTC)',
        }
      : { copyReadAt: null, note: 'No daily copy of the stock data has been read yet: call /api/cron/stock?force=1 once, or open the Stock Statement tab.' },
  });
}

import { NextResponse } from 'next/server';
import { getJournalJobProgress } from '@/lib/journal-job';
import { getCachedFetchedAt } from '@/lib/cache';

export const dynamic = 'force-dynamic';

/**
 * Read-only: shows when the data the dashboard is displaying was last read from Zoho (it is refreshed once a
 * day, at 07:00 AM IST) and where the journal step stands. Does not start or advance anything.
 */
export async function GET() {
  const [progress, snapshotReadAt] = await Promise.all([getJournalJobProgress(), getCachedFetchedAt()]);
  const hours = snapshotReadAt ? (Date.now() - new Date(snapshotReadAt).getTime()) / 3_600_000 : null;
  return NextResponse.json({
    snapshotReadAt,
    snapshotAgeHours: hours === null ? null : Math.round(hours * 10) / 10,
    refreshSchedule: 'once a day at 07:00 AM IST (01:30 UTC)',
    journalJob: progress,
  });
}

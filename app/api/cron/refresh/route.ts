import { NextRequest, NextResponse } from 'next/server';
import { fetchAllRawData } from '@/lib/zoho-raw-fetch';
import { setCachedRawData, getCachedFetchedAt, acquireRefreshLock, releaseRefreshLock } from '@/lib/cache';
import { advanceJournalJob } from '@/lib/journal-job';

export const dynamic = 'force-dynamic';
// The whole refresh has to fit in ONE run (it only happens once a day), so it is given the longest
// time Vercel allows on every plan (300 s). Typical use: well under 3 minutes.
export const maxDuration = 300;

/** A cache read less than this long ago is left alone unless ?force=1 is added (stops accidental or repeated hits from re-reading Zoho). */
const MIN_HOURS_BETWEEN_REFRESHES = 3;
/** Time the journal step may take; the rest of the 300 s is kept for everything that comes after it. */
const JOURNAL_BUDGET_MS = 100_000;

/**
 * THE daily refresh. vercel.json runs this once a day at 07:00 India time (01:30 UTC); nothing else in the
 * app ever reads from Zoho. Everyone who opens the dashboard during the next 24 hours is shown the snapshot
 * this run wrote, so every visitor sees the same figures and no page load waits on Zoho.
 *
 * The run does a full check every time: it compares Zoho's journal list with what is already stored (a
 * handful of new or changed journals on an ordinary day), fetches only those, then reads everything else
 * fresh and writes one new snapshot.
 *
 * - If anything fails or runs out of time, the previous snapshot is left exactly as it was -- viewers keep
 *   seeing yesterday's complete data, never a half-written one and never an error.
 * - Only one refresh runs at a time (a lock), because Vercel can occasionally deliver a scheduled run twice.
 * - A snapshot read less than 3 hours ago is not read again, unless ?force=1.
 *
 * Protected by CRON_SECRET: Vercel automatically sends `Authorization: Bearer <CRON_SECRET>` on scheduled
 * invocations once that env var is set on the project, so this checks for it and rejects anything else
 * (only this refresh trigger -- the dashboard itself stays open). To refresh by hand, send the same header.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get('authorization');
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const force = req.nextUrl.searchParams.get('force') === '1';

  try {
    if (!force) {
      const last = await getCachedFetchedAt();
      if (last) {
        const hours = (Date.now() - new Date(last).getTime()) / 3_600_000;
        if (hours >= 0 && hours < MIN_HOURS_BETWEEN_REFRESHES) {
          return NextResponse.json({
            ok: true,
            skipped: true,
            reason: `The snapshot was read ${hours.toFixed(1)} hours ago (less than ${MIN_HOURS_BETWEEN_REFRESHES}); add ?force=1 to read Zoho again anyway.`,
            fetchedAt: last,
          });
        }
      }
    }

    if (!(await acquireRefreshLock())) {
      return NextResponse.json({ ok: true, skipped: true, reason: 'Another refresh is already running.' });
    }

    try {
      const { progress, journals } = await advanceJournalJob({ forceNewCheck: true, budgetMs: JOURNAL_BUDGET_MS });

      if (!journals) {
        // The journal step ran out of time (only possible after a very long gap). What it fetched is
        // saved, so the next run carries on from there; the dashboard keeps the last complete snapshot.
        return NextResponse.json({ ok: true, journalJob: progress, cacheUpdated: false });
      }

      // All journals are in hand: read everything else, combine, and write the new snapshot in one go.
      const raw = await fetchAllRawData(journals);
      await setCachedRawData(raw);

      return NextResponse.json({
        ok: true,
        journalJob: progress,
        cacheUpdated: true,
        fetchedAt: raw.fetchedAt,
        counts: {
          activeCustomers: raw.activeCustomers.length,
          activeVendors: raw.activeVendors.length,
          invoices: raw.invoices.length,
          bills: raw.bills.length,
          customerPayments: raw.customerPayments.length,
          vendorPayments: raw.vendorPayments.length,
          creditNotes: raw.creditNotes.length,
          vendorCredits: raw.vendorCredits.length,
          journals: raw.journals.length,
        },
      });
    } finally {
      await releaseRefreshLock();
    }
  } catch (err) {
    console.error('Daily refresh failed (the previous snapshot is untouched):', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error during refresh', previousSnapshotKept: true },
      { status: 500 }
    );
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { computeAPSummary } from '@/lib/ap-calculator';
import { getRawData } from '@/lib/get-raw-data';
import { getLedgerFor, effectiveAsOf, cacheDay } from '@/lib/ledger';
import { memoKey, memoGet, memoSet } from '@/lib/response-memo';
import { getMockAPSummary, isMockMode } from '@/lib/mock-data';
import { ZB_EARLIEST_DATE, clampISO, rangeFrom } from '@/lib/period';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const requested = req.nextUrl.searchParams.get('asOf') ?? new Date().toISOString().slice(0, 10);

    if (isMockMode()) {
      return NextResponse.json({ ...getMockAPSummary(), mock: true, fromCache: false });
    }

    const raw = await getRawData();
    // The data is read once a day, so a date after the snapshot's own day is answered as of that day:
    // the figures and age buckets stay the same for all 24 hours.
    // ...and never earlier than the day the books begin (a date before it could only give an empty page).
    const asOf = clampISO(effectiveAsOf(requested, raw), ZB_EARLIEST_DATE, cacheDay(raw.fetchedAt));
    // Custom range: only documents dated From..To. Without a real From this is the ordinary "up to this date" answer.
    const from = rangeFrom(req.nextUrl.searchParams.get('from'), asOf);
    const isToday = asOf >= cacheDay(raw.fetchedAt);
    const key = memoKey('ap', raw.fetchedAt, from ? `${from}..${asOf}` : asOf);
    if (isToday || from) {
      const hit = memoGet<object>(key);
      if (hit) return NextResponse.json(hit);
    }
    if (from) {
      // The documents are the whole answer here: Zoho's ledger is per contact, not per document date, so it cannot check a range.
      const summary = computeAPSummary(raw, asOf, { from });
      const body = {
        ...summary,
        mock: false,
        fromCache: raw.fromCache,
        cachedAt: raw.fetchedAt,
        ledgerBasis: 'range' as const,
        jnCleanLoaded: raw.jnClean !== undefined,
        jnApplicationsRead: (raw.jnCleanStats?.applications ?? 0) > 0,
      };
      memoSet(key, body);
      return NextResponse.json(body);
    }
    // Totals come from Zoho's own ledger balance for the date asked: the
    // contact records for today, a stored report snapshot for an earlier
    // date. If neither exists the figures fall back to what the documents
    // add up to, and `ledgerBasis: 'unavailable'` tells the page to say so.
    const got = await getLedgerFor(asOf, raw);
    // A stored snapshot may hold only one side (e.g. customers but not vendors yet).
    const basis = got.basis === 'snapshot' && (got.ledger?.vendors.size ?? 0) === 0 ? 'unavailable' : got.basis;
    const ledger = basis === 'unavailable' ? null : got.ledger;
    const summary = computeAPSummary(raw, asOf, { ledger, historical: basis === 'snapshot' });
    const body = {
      ...summary,
      mock: false,
      fromCache: raw.fromCache,
      cachedAt: raw.fetchedAt,
      ledgerBasis: basis,
      jnCleanLoaded: raw.jnClean !== undefined,
      jnApplicationsRead: (raw.jnCleanStats?.applications ?? 0) > 0,
    };
    if (isToday && basis === 'current') memoSet(key, body);
    return NextResponse.json(body);
  } catch (err) {
    console.error('AP summary failed:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error computing AP summary' },
      { status: 500 }
    );
  }
}

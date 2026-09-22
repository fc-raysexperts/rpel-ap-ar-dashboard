import { NextRequest, NextResponse } from 'next/server';
import { computeAPSummary } from '@/lib/ap-calculator';
import { getMockAPSummary, isMockMode } from '@/lib/mock-data';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    if (isMockMode()) {
      return NextResponse.json({ ...getMockAPSummary(), mock: true });
    }
    const since = req.nextUrl.searchParams.get('since') ?? undefined;
    const summary = await computeAPSummary(since);
    return NextResponse.json({ ...summary, mock: false });
  } catch (err) {
    console.error('AP summary failed:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error computing AP summary' },
      { status: 500 }
    );
  }
}

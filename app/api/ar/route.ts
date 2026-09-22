import { NextRequest, NextResponse } from 'next/server';
import { computeARSummary } from '@/lib/ar-calculator';
import { getMockARSummary, isMockMode } from '@/lib/mock-data';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    if (isMockMode()) {
      return NextResponse.json({ ...getMockARSummary(), mock: true });
    }
    const since = req.nextUrl.searchParams.get('since') ?? undefined;
    const summary = await computeARSummary(since);
    return NextResponse.json({ ...summary, mock: false });
  } catch (err) {
    console.error('AR summary failed:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error computing AR summary' },
      { status: 500 }
    );
  }
}

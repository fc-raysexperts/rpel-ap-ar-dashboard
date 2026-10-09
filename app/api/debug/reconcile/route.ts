import { NextRequest, NextResponse } from 'next/server';
import { getCachedRawData } from '@/lib/cache';
import { getLedgerFor } from '@/lib/ledger';
import { reconcile, contactBreakdown, rereadFlagged } from '@/lib/reconcile';
import { auditVendors, auditCustomers } from '@/lib/audit';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Debug-only proof layer.
//
//   /api/debug/reconcile                       does every contact's paperwork add up to Zoho's ledger?
//   /api/debug/reconcile?reread=1              re-reads the biggest flagged contacts from Zoho (makes API calls)
//   /api/debug/reconcile?jn=1                  lists EVERY contact where JN-Clean does not cancel (Statement balance vs dashboard balance)
//   /api/debug/reconcile?tds=1                 checks EVERY vendor's balance report figure against contact record + TDS,
//                                              and (one live call) every customer's report figure against ours
//   /api/debug/reconcile?name=Wonder           everything behind one contact (add &limit=10 for shorter lists)
//   add &asOf=2026-08-31 for an earlier date (needs a stored ledger snapshot for that date)
//
// Without ?reread this reads the cache only and makes NO Zoho calls.

function localToday(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export async function GET(req: NextRequest) {
  const raw = await getCachedRawData();
  if (!raw) {
    return NextResponse.json({ error: 'No cached data found. Run npm run sync-cache first.' }, { status: 409 });
  }
  const asOf = req.nextUrl.searchParams.get('asOf') ?? localToday();
  const name = req.nextUrl.searchParams.get('name');
  const { ledger, basis } = await getLedgerFor(asOf, raw);

  if (name) {
    const limit = Number(req.nextUrl.searchParams.get('limit') ?? 40);
    const found = contactBreakdown(raw, asOf, ledger, name, limit);
    if (found.length === 0) {
      return NextResponse.json({ error: `No active customer or vendor name contains "${name}"` });
    }
    return NextResponse.json({ cacheFetchedAt: raw.fetchedAt, asOf, ledgerBasis: basis, results: found });
  }

  if (req.nextUrl.searchParams.get('tds') === '1') {
    const customers = await auditCustomers(raw, asOf, ledger);
    return NextResponse.json({ cacheFetchedAt: raw.fetchedAt, asOf, ledgerBasis: basis, vendors: auditVendors(raw), customers });
  }

  if (req.nextUrl.searchParams.get('reread') === '1') {
    const reread = await rereadFlagged(raw, asOf, ledger);
    return NextResponse.json({ cacheFetchedAt: raw.fetchedAt, asOf, ledgerBasis: basis, reread });
  }

  return NextResponse.json({ cacheFetchedAt: raw.fetchedAt, asOf, ledgerBasis: basis, ...reconcile(raw, asOf, ledger, { jnAll: req.nextUrl.searchParams.get('jn') === '1' }) });
}

import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { listAllContactsAnyStatus, listAllBills, listAllInvoices, type ZohoContact } from '@/lib/zoho-client';
import { isExcludedStatus } from '@/lib/status-filter';
import type { TrimmedJournal } from '@/lib/journal-job';

// Debug-only tool, answering one specific question before trusting the
// active-vs-all-contacts change: do any INACTIVE contacts actually carry
// a real, nonzero balance? Checks Bills/Invoices directly (cheap, no
// extra API cost beyond what the dashboard already fetches) and, if a
// journal cache already exists from a prior sync, cross-references that
// too (free -- just a Redis read, no fresh Zoho calls). Not linked from
// the UI; safe to delete once you've got your answer.
//
// Usage: GET /api/debug/inactive-contacts

const JOURNAL_STORE_KEY = 'rpel-apar:journal-details-store';

async function readPersistedJournals(): Promise<TrimmedJournal[] | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const redis = new Redis({ url, token });
  const store = await redis.get<Record<string, { detail: TrimmedJournal }>>(JOURNAL_STORE_KEY);
  if (!store) return null;
  return Object.values(store).map((entry) => entry.detail);
}

function isInactive(c: ZohoContact): boolean {
  return c.status?.toLowerCase() !== 'active';
}

export async function GET() {
  try {
    const [allCustomers, allVendors, invoices, bills, persistedJournals] = await Promise.all([
      listAllContactsAnyStatus('customer'),
      listAllContactsAnyStatus('vendor'),
      listAllInvoices(),
      listAllBills(),
      readPersistedJournals(),
    ]);

    const inactiveCustomers = allCustomers.filter(isInactive);
    const inactiveVendors = allVendors.filter(isInactive);

    const inactiveCustomerIds = new Set(inactiveCustomers.map((c) => c.contact_id));
    const inactiveVendorIds = new Set(inactiveVendors.map((c) => c.contact_id));

    const nameByCustomerId = new Map(inactiveCustomers.map((c) => [c.contact_id, c.contact_name] as const));
    const nameByVendorId = new Map(inactiveVendors.map((c) => [c.contact_id, c.contact_name] as const));

    // --- Invoices tied to inactive customers ---
    const inactiveCustomerBalances = new Map<string, number>();
    for (const inv of invoices) {
      if (!inactiveCustomerIds.has(inv.customer_id)) continue;
      if (!inv.balance || inv.balance <= 0) continue;
      if (isExcludedStatus(inv.status)) continue;
      inactiveCustomerBalances.set(
        inv.customer_id,
        (inactiveCustomerBalances.get(inv.customer_id) ?? 0) + inv.balance
      );
    }

    // --- Bills tied to inactive vendors ---
    const inactiveVendorBalances = new Map<string, number>();
    for (const b of bills) {
      if (!inactiveVendorIds.has(b.vendor_id)) continue;
      if (!b.balance || b.balance <= 0) continue;
      if (isExcludedStatus(b.status)) continue;
      inactiveVendorBalances.set(b.vendor_id, (inactiveVendorBalances.get(b.vendor_id) ?? 0) + b.balance);
    }

    // --- Journals touching inactive contacts (only if a journal cache already exists) ---
    let journalNoteForCustomers: Record<string, number> | null = null;
    let journalNoteForVendors: Record<string, number> | null = null;
    if (persistedJournals) {
      const custTotals = new Map<string, number>();
      const vendTotals = new Map<string, number>();
      for (const j of persistedJournals) {
        for (const line of j.line_items) {
          if (!line.contact_id) continue;
          if (inactiveCustomerIds.has(line.contact_id)) {
            const delta = line.debit_or_credit === 'debit' ? line.amount : -line.amount;
            custTotals.set(line.contact_id, (custTotals.get(line.contact_id) ?? 0) + delta);
          }
          if (inactiveVendorIds.has(line.contact_id)) {
            const delta = line.debit_or_credit === 'credit' ? line.amount : -line.amount;
            vendTotals.set(line.contact_id, (vendTotals.get(line.contact_id) ?? 0) + delta);
          }
        }
      }
      journalNoteForCustomers = Object.fromEntries(
        [...custTotals.entries()].map(([id, amt]) => [nameByCustomerId.get(id) ?? id, Math.round(amt)])
      );
      journalNoteForVendors = Object.fromEntries(
        [...vendTotals.entries()].map(([id, amt]) => [nameByVendorId.get(id) ?? id, Math.round(amt)])
      );
    }

    const inactiveCustomersWithBalance = [...inactiveCustomerBalances.entries()]
      .map(([id, amount]) => ({ name: nameByCustomerId.get(id) ?? id, amount: Math.round(amount) }))
      .sort((a, b) => b.amount - a.amount);

    const inactiveVendorsWithBalance = [...inactiveVendorBalances.entries()]
      .map(([id, amount]) => ({ name: nameByVendorId.get(id) ?? id, amount: Math.round(amount) }))
      .sort((a, b) => b.amount - a.amount);

    return NextResponse.json({
      customers: {
        totalContacts: allCustomers.length,
        inactiveCount: inactiveCustomers.length,
        inactiveWithNonzeroInvoiceBalance: inactiveCustomersWithBalance.length,
        totalAmountAtStake_fromInvoices: inactiveCustomersWithBalance.reduce((s, c) => s + c.amount, 0),
        examples: inactiveCustomersWithBalance.slice(0, 15),
        journalContributions_ifCacheExists: journalNoteForCustomers,
      },
      vendors: {
        totalContacts: allVendors.length,
        inactiveCount: inactiveVendors.length,
        inactiveWithNonzeroBillBalance: inactiveVendorsWithBalance.length,
        totalAmountAtStake_fromBills: inactiveVendorsWithBalance.reduce((s, v) => s + v.amount, 0),
        examples: inactiveVendorsWithBalance.slice(0, 15),
        journalContributions_ifCacheExists: journalNoteForVendors,
      },
      note:
        persistedJournals === null
          ? 'No journal cache found yet (run npm run sync-cache first for the journal cross-check too) -- this result only covers Bills/Invoices, not journal-only balances like the Indian Customs case.'
          : `Journal cache found (${persistedJournals.length} entries) -- cross-checked inactive contacts against it at no extra API cost.`,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

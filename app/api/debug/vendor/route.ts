import { NextRequest, NextResponse } from 'next/server';

// Debug-only tool. Not linked from the UI, not meant to ship long-term --
// its whole purpose is to answer one question directly from Zoho's raw
// API responses: "what data actually produced the old, wrong number for a
// given contact?" Usage: GET /api/debug/vendor?name=Indian%20Customs
// (or ?id=<contact_id> if you already know it). Safe to delete once
// you've got your answer.

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;
  const url = new URL(`${requireEnv('ZOHO_ACCOUNTS_BASE')}/oauth/v2/token`);
  url.searchParams.set('refresh_token', requireEnv('ZOHO_REFRESH_TOKEN'));
  url.searchParams.set('client_id', requireEnv('ZOHO_CLIENT_ID'));
  url.searchParams.set('client_secret', requireEnv('ZOHO_CLIENT_SECRET'));
  url.searchParams.set('grant_type', 'refresh_token');
  const res = await fetch(url.toString(), { method: 'POST' });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);
  cachedToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
  return cachedToken.token;
}

async function zohoGet(path: string, params: Record<string, string | number> = {}) {
  const token = await getAccessToken();
  const url = new URL(`${requireEnv('ZOHO_API_BASE')}${path}`);
  url.searchParams.set('organization_id', requireEnv('ZOHO_ORGANIZATION_ID'));
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`${path} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

async function zohoGetAll(path: string, arrayField: string, params: Record<string, string | number> = {}) {
  const results: Record<string, unknown>[] = [];
  let page = 1;
  for (let i = 0; i < 200; i++) {
    const data = await zohoGet(path, { ...params, page, per_page: 200 });
    const chunk = (data[arrayField] as Record<string, unknown>[]) ?? [];
    results.push(...chunk);
    if (!data.page_context?.has_more_page) break;
    page += 1;
  }
  return results;
}

export async function GET(req: NextRequest) {
  const nameQuery = req.nextUrl.searchParams.get('name');
  const idQuery = req.nextUrl.searchParams.get('id');

  if (!nameQuery && !idQuery) {
    return NextResponse.json(
      { error: 'Pass ?name=<search text> or ?id=<contact_id>' },
      { status: 400 }
    );
  }

  try {
    let matchingContacts: Record<string, unknown>[];

    if (idQuery) {
      const data = await zohoGet(`/contacts/${idQuery}`);
      matchingContacts = [data.contact as Record<string, unknown>];
    } else {
      // Client-side name filtering over EVERY vendor contact regardless of
      // status (active, inactive, all of them) -- specifically to catch a
      // possible duplicate contact that a normal Status.Active-filtered
      // fetch would never surface.
      const allVendors = await zohoGetAll('/contacts', 'contacts', { contact_type: 'vendor' });
      const needle = nameQuery!.toLowerCase();
      matchingContacts = allVendors.filter((c) =>
        String(c.contact_name ?? '').toLowerCase().includes(needle)
      );
    }

    if (matchingContacts.length === 0) {
      return NextResponse.json({ error: 'No matching vendor contact found', searched: nameQuery ?? idQuery });
    }

    const results = [];
    for (const contact of matchingContacts) {
      const vendorId = contact.contact_id as string;

      const [allBills, allPayments, allCredits] = await Promise.all([
        zohoGetAll('/bills', 'bills', { vendor_id: vendorId }),
        zohoGetAll('/vendorpayments', 'vendorpayments', { vendor_id: vendorId }),
        zohoGetAll('/vendorcredits', 'vendor_credits', { vendor_id: vendorId }),
      ]);

      // Journals aren't filterable by vendor_id server-side (Zoho's
      // Journals list endpoint doesn't support it), so pull everything
      // and filter client-side by line-item contact_id -- fine for a
      // one-off debug call, not how the real app fetches journals.
      const allJournals = await zohoGetAll('/journals', 'journals');
      const journalsForVendor = (allJournals as Array<{ line_items?: Array<{ contact_id?: string }> }>).filter(
        (j) => j.line_items?.some((li) => li.contact_id === vendorId)
      );

      // DIAGNOSTIC: the LIST response's raw shape, unfiltered, for the
      // first couple of journals -- to see directly whether line_items is
      // even present here, or only on the single "Get journal" response.
      const rawJournalListSample = (allJournals as Record<string, unknown>[]).slice(0, 2);

      // DIAGNOSTIC: fetch ONE journal's full detail via the single-record
      // endpoint, for direct comparison against its list-response shape
      // above. If the list sample has no (or empty) line_items but this
      // does, that confirms the list endpoint just doesn't return them.
      let sampleJournalDetail: unknown = null;
      if (allJournals.length > 0) {
        const sampleId = (allJournals[0] as Record<string, unknown>).journal_id as string;
        const detail = await zohoGet(`/journals/${sampleId}`);
        sampleJournalDetail = detail.journal ?? detail;
      }

      const oldLogicTotal = allBills.reduce(
        (sum, b) => sum + (typeof b.balance === 'number' && b.balance > 0 ? b.balance : 0),
        0
      );

      results.push({
        contact_id: vendorId,
        contact_name: contact.contact_name,
        status: contact.status,
        bills: {
          count: allBills.length,
          rows: allBills.map((b) => ({
            bill_id: b.bill_id,
            bill_number: b.bill_number,
            date: b.date,
            due_date: b.due_date,
            status: b.status,
            total: b.total,
            balance: b.balance,
          })),
        },
        vendor_payments: {
          count: allPayments.length,
          rows: allPayments.map((p) => ({
            payment_id: p.payment_id,
            date: p.date,
            amount: p.amount,
            unused_amount: p.unused_amount,
          })),
        },
        vendor_credits: {
          count: allCredits.length,
          rows: allCredits,
        },
        journals_touching_this_vendor: {
          count: journalsForVendor.length,
          rows: journalsForVendor.map((j) => ({
            journal_id: (j as Record<string, unknown>).journal_id,
            journal_date: (j as Record<string, unknown>).journal_date,
            reference_number: (j as Record<string, unknown>).reference_number,
            line_items_for_this_vendor: j.line_items?.filter((li) => li.contact_id === vendorId),
          })),
        },
        journal_endpoint_diagnostic: {
          total_journals_in_org: allJournals.length,
          raw_list_response_sample: rawJournalListSample,
          single_journal_detail_sample: sampleJournalDetail,
          note: 'Compare whether "line_items" appears (and is non-empty) in raw_list_response_sample vs single_journal_detail_sample. If the list sample lacks it but the detail sample has it, the list endpoint does not return line items at all -- meaning journal-based contact matching needs individual per-journal detail calls, not the bulk list.',
        },
        diagnosis: {
          old_logic_bills_only_total: oldLogicTotal,
          note:
            oldLogicTotal > 0
              ? `The OLD (pre-fix) dashboard logic would have shown Rs ${oldLogicTotal.toLocaleString('en-IN')} for this contact, entirely from the ${allBills.length} bill row(s) above with a nonzero balance. Check their "status" field -- if any show void/draft, that's Zoho still carrying a balance on a bill that shouldn't count.`
              : 'No bills with a nonzero balance exist for this contact -- the old logic would have shown Rs 0 for it. If the dashboard showed something else under this name, there is likely a SEPARATE contact_id with a similar/identical name -- check if matchingContacts (top level of this response) has more than one entry.',
        },
      });
    }

    return NextResponse.json({
      searched: nameQuery ?? idQuery,
      matchingContactsFound: matchingContacts.length,
      warning:
        matchingContacts.length > 1
          ? 'MULTIPLE vendor contacts matched this name -- this alone may explain the discrepancy. See each entry below.'
          : undefined,
      results,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

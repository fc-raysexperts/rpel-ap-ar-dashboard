import { Redis } from '@upstash/redis';
import { getContactOpeningBalance } from './zoho-client';

// A contact that was carried over from the old books has an OPENING BALANCE:
// Zoho stores it as a special opening-balance invoice / bill that never
// appears in the normal invoice or bill list, so the documents we fetch
// cannot see it -- yet it is part of the contact's Statement (the
// "Opening Balance" row). Confirmed on RE0047 Shreya Petrochem
// (Rs 2,20,98,612) and NDMC (Rs 3,49,65,291): each equals that contact's
// entire gap between the documents and Zoho's ledger.
//
// The contact LIST does not carry it; the single-contact lookup does
// (outstanding_ob_receivable_amount / outstanding_ob_payable_amount and the
// opening-balance invoice id). That is one call per contact, so we only look
// up contacts whose documents do not already explain their ledger balance,
// remember what we find, and afterwards refresh only the contacts known to
// carry one (their outstanding amount drops as it is paid).

export interface OpeningBalanceRec {
  receivable: number;
  payable: number;
  docId?: string;
  checkedAt: string;
}
export type OpeningBalances = Record<string, OpeningBalanceRec>;

export interface OpeningBalanceStats {
  contactsLookedUp: number;
  contactsWithOpeningBalance: number;
  failed: number;
  partial: boolean;
}

const STORE_KEY = 'rpel-apar:ob-store-v1';
const CONCURRENCY = 5;

function getClient(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

const hasOB = (r: OpeningBalanceRec) => r.receivable > 0 || r.payable > 0 || Boolean(r.docId);

export async function syncOpeningBalances(
  flaggedContactIds: string[],
  opts: { onProgress?: (done: number, total: number) => void; timeBudgetMs?: number } = {}
): Promise<{ balances: OpeningBalances; stats: OpeningBalanceStats }> {
  const redis = getClient();
  const store: OpeningBalances = redis ? ((await redis.get<OpeningBalances>(STORE_KEY)) ?? {}) : {};

  // Look up: contacts never checked that are flagged now, plus contacts already
  // known to carry an opening balance (its outstanding amount changes).
  const todo = new Set<string>();
  for (const id of flaggedContactIds) if (!store[id]) todo.add(id);
  for (const [id, rec] of Object.entries(store)) if (hasOB(rec)) todo.add(id);
  const ids = [...todo];

  const deadline = opts.timeBudgetMs ? Date.now() + opts.timeBudgetMs : Infinity;
  let done = 0;
  let failed = 0;
  let partial = false;
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    if (Date.now() > deadline) {
      partial = true;
      break;
    }
    const chunk = ids.slice(i, i + CONCURRENCY);
    await Promise.all(
      chunk.map(async (id) => {
        try {
          const ob = await getContactOpeningBalance(id);
          store[id] = { receivable: ob.receivable, payable: ob.payable, docId: ob.docId, checkedAt: new Date().toISOString() };
        } catch (err) {
          failed += 1;
          console.error(`Opening-balance lookup failed for contact ${id}, will retry next run:`, err);
        }
      })
    );
    done += chunk.length;
    opts.onProgress?.(done, ids.length);
  }
  if (redis) await redis.set(STORE_KEY, JSON.stringify(store));

  const balances: OpeningBalances = {};
  for (const [id, rec] of Object.entries(store)) if (hasOB(rec)) balances[id] = rec;
  return {
    balances,
    stats: { contactsLookedUp: done, contactsWithOpeningBalance: Object.keys(balances).length, failed, partial },
  };
}

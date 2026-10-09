import { Redis } from '@upstash/redis';
import { getVendorPaymentTds, type ZohoVendorPayment } from './zoho-client';
import { isExcludedStatus } from './status-filter';

// TDS ON ADVANCE PAYMENTS.
//
// When a payment is made to a vendor with TDS withheld (say Rs 94,500 paid and
// Rs 10,500 deducted on Rs 1,05,000), the vendor's account is credited with the
// GROSS Rs 1,05,000: the Statement and Zoho's vendor balance report both say so.
// But the payment's own balance, and Zoho's contact-level "unused credits", keep
// only the net Rs 94,500. For an advance that has not been applied to a bill the
// missing Rs 10,500 is the whole difference (ITCOT: -1,05,000 on the Statement,
// -94,500 on the contact; Lal Singh: unused 8,39,702 + TDS 93,298 = 9,33,000, which
// is what brings his Statement to Rs 0 where the contact record said Rs 93,298).
//
// The list of payments does not carry the TDS; each payment's own record does
// (`balance_tax_amount_withheld`). So for every payment that still has an unused
// balance we look that up once, remember it, and look again only if the unused
// balance changes (e.g. part of the advance is applied to a bill).

const STORE_KEY = 'rpel-apar:payment-tds-store-v1';
const CONCURRENCY = 5;

interface Rec {
  unused: number;
  tds: number;
}
type Store = Record<string, Rec>;

export interface PaymentTdsStats {
  candidates: number;
  lookedUp: number;
  withTds: number;
  failed: number;
  partial: boolean;
}

function getClient(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

export async function syncPaymentTds(
  payments: ZohoVendorPayment[],
  opts: { onProgress?: (done: number, total: number) => void; timeBudgetMs?: number } = {}
): Promise<{ tds: Record<string, number>; stats: PaymentTdsStats }> {
  const redis = getClient();
  const store: Store = redis ? ((await redis.get<Store>(STORE_KEY)) ?? {}) : {};
  const candidates = payments.filter((p) => (p.unused_amount ?? 0) > 0 && !isExcludedStatus(p.status));
  const todo = candidates.filter((p) => {
    const r = store[p.payment_id];
    return !r || Math.abs(r.unused - (p.unused_amount ?? 0)) > 0.005;
  });

  const deadline = opts.timeBudgetMs ? Date.now() + opts.timeBudgetMs : Infinity;
  let done = 0;
  let failed = 0;
  let partial = false;
  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    if (Date.now() > deadline) {
      partial = true;
      break;
    }
    const chunk = todo.slice(i, i + CONCURRENCY);
    await Promise.all(
      chunk.map(async (p) => {
        try {
          store[p.payment_id] = { unused: p.unused_amount ?? 0, tds: await getVendorPaymentTds(p.payment_id) };
        } catch (err) {
          failed += 1;
          console.error(`TDS lookup failed for payment ${p.payment_id}, will retry next run:`, err);
        }
      })
    );
    done += chunk.length;
    opts.onProgress?.(done, todo.length);
  }
  if (redis && todo.length > 0) await redis.set(STORE_KEY, JSON.stringify(store));

  const tds: Record<string, number> = {};
  for (const p of candidates) {
    const r = store[p.payment_id];
    if (r && r.tds > 0 && Math.abs(r.unused - (p.unused_amount ?? 0)) <= 0.005) tds[p.payment_id] = r.tds;
  }
  return { tds, stats: { candidates: candidates.length, lookedUp: done, withTds: Object.keys(tds).length, failed, partial } };
}

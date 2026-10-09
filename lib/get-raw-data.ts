import { fetchAllRawData, type RawZohoData } from './zoho-raw-fetch';
import { getCachedRawData, isCacheConfigured } from './cache';

/**
 * Cache-first: returns the cached snapshot (written once a day, at 07:00 AM
 * IST, by the cron job) and never calls Zoho for a page load.
 *
 * If Redis IS configured but hasn't been populated yet, this throws a
 * clear error directing to the cron endpoint, rather than attempting a
 * full live fetch inline. That inline fallback used to be the default
 * here, and in practice it caused real problems: a page load fires
 * /api/ar and /api/ap at the same time, each independently triggering a
 * full fetch (including the 2,000+-journal synchronous path) -- enough
 * simultaneous requests to trip Zoho's concurrent-request limit, and to
 * expose a token-refresh race condition (now also fixed, but this path
 * was always going to be risky for routine page loads regardless).
 *
 * If Redis isn't configured AT ALL, there's no cache to populate, so this
 * still falls back to a live fetch -- that's the deliberate
 * uncached/manual-testing path, not the steady-state one.
 */
export async function getRawData(): Promise<RawZohoData & { fromCache: boolean }> {
  const cached = await getCachedRawData();
  if (cached) return { ...cached, fromCache: true };

  if (isCacheConfigured()) {
    throw new Error(
      'No data has been loaded yet. The dashboard reads Zoho once a day (07:00 AM IST) and shows that snapshot ' +
        'all day. For the very first load, run "npm run sync-cache" on the computer that has the Zoho keys, ' +
        'or call GET /api/cron/refresh?force=1 (with the CRON_SECRET header if one is set), then reload this page.'
    );
  }

  const fresh = await fetchAllRawData();
  return { ...fresh, fromCache: false };
}

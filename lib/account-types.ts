import { Redis } from '@upstash/redis';
import { getAccountInfoDetailed } from './zoho-client';
import type { LedgerAccounts } from './accounts';

// Which accounts are Accounts Receivable / Payable? Zoho's chart-of-accounts
// LIST cannot answer that reliably: unfiltered, it returns only top-level
// accounts and hides every child account (e.g. all of "Sundry Creditors-
// Others", "-Employees", "-Foreign Supplier" sit under "Trade Payables"), and
// it stops after the first page. Looking an account up BY ID does return it,
// children and inactive accounts included.
//
// So we look up only the accounts that actually appear on a journal line
// tagged to a customer or vendor, once each, and remember the answer (an
// account's type does not change). Any lookup that fails is recorded as
// "unknown" and treated as reaching the ledger -- the old behaviour -- so a
// failed lookup can never silently remove a line.

const STORE_KEY = 'rpel-apar:account-types-v1';
const CONCURRENCY = 5;

type Store = Record<string, { type: string; name: string }>;

export interface AccountTypeStats {
  distinctAccounts: number;
  lookedUp: number;
  receivable: number;
  payable: number;
  other: number;
  unknown: number;
  /** why the first few failed lookups failed, so a problem is visible rather than a mystery */
  failureSamples: string[];
}

function getClient(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

export async function syncAccountTypes(
  accountIds: string[],
  opts: { onProgress?: (done: number, total: number) => void; timeBudgetMs?: number } = {}
): Promise<{ ledgerAccounts: LedgerAccounts; stats: AccountTypeStats }> {
  const redis = getClient();
  const store: Store = redis ? ((await redis.get<Store>(STORE_KEY)) ?? {}) : {};
  const ids = [...new Set(accountIds)];
  const todo = ids.filter((id) => !store[id]);

  const deadline = opts.timeBudgetMs ? Date.now() + opts.timeBudgetMs : Infinity;
  let done = 0;
  const failureSamples: string[] = [];
  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    if (Date.now() > deadline) break;
    const chunk = todo.slice(i, i + CONCURRENCY);
    await Promise.all(
      chunk.map(async (id) => {
        const { info, reason } = await getAccountInfoDetailed(id);
        if (info && info.account_type) store[id] = { type: info.account_type, name: info.account_name };
        else if (failureSamples.length < 3) failureSamples.push(`${id}: ${reason ?? 'no account type returned'}`);
      })
    );
    done += chunk.length;
    opts.onProgress?.(done, todo.length);
  }
  if (redis && todo.length > 0) await redis.set(STORE_KEY, JSON.stringify(store));

  const receivable: string[] = [];
  const payable: string[] = [];
  const unknown: string[] = [];
  let other = 0;
  for (const id of ids) {
    const t = store[id]?.type;
    if (!t) unknown.push(id);
    else if (t === 'accounts_receivable') receivable.push(id);
    else if (t === 'accounts_payable') payable.push(id);
    else other += 1;
  }
  return {
    ledgerAccounts: { receivable, payable, unknown },
    stats: { distinctAccounts: ids.length, lookedUp: done, receivable: receivable.length, payable: payable.length, other, unknown: unknown.length, failureSamples },
  };
}

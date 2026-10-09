// A small in-memory memo for finished dashboard answers. The data behind "today's" figures is fixed for a
// whole day (one snapshot, read at 7 AM), so the same answer is simply handed back instead of being worked
// out again for every visitor. Keyed by the snapshot's own fetchedAt, so a new snapshot can never be answered
// from an old entry. Only ever used for today's figures; a past date is worked out every time.

const store = new Map<string, unknown>();
const MAX_ENTRIES = 24;

export const memoKey = (kind: string, fetchedAt: string, asOf: string) => `${kind}|${fetchedAt}|${asOf}`;

export function memoGet<T>(key: string): T | undefined {
  return store.get(key) as T | undefined;
}

export function memoSet(key: string, value: unknown): void {
  if (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(key, value);
}

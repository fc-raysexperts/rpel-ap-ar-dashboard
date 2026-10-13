// Shared by the page (client) and the API routes (server): which dates the dashboard accepts.
// Nothing in here may import server-only code.

/**
 * The first day the Zoho Books data can answer for. Looked up in Zoho on 12 Oct 2026: the books were opened on
 * 21 Mar 2025 and carry the old books' closing position as at 31 Mar 2025 (the opening balances). Nothing that
 * touches a debtor or a creditor is dated earlier, apart from a few old bills keyed in later (rejected or already
 * paid, so they never show a balance) and stray typos (an expense dated 2015, one dated 2020).
 *   first customer payment  30 Mar 2025     first vendor payment  31 Mar 2025
 *   first journal           31 Mar 2025     first invoice          4 Apr 2025
 * A date before this would give an empty page, so the date pickers do not offer one.
 */
export const ZB_EARLIEST_DATE = '2025-03-31';

export function isISODate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Keep a date inside [min, max]. */
export function clampISO(s: string, min: string, max: string): string {
  return s < min ? min : s > max ? max : s;
}

/**
 * The "From" of a custom range, as the server will use it. Returns undefined when there is no real restriction
 * (nothing given, not a date, or on/before the first day of the books), so such a request is answered exactly
 * like a plain "up to this date" one. A From after the To is pulled back to the To.
 */
export function rangeFrom(from: string | null | undefined, asOf: string): string | undefined {
  if (!isISODate(from)) return undefined;
  if (from <= ZB_EARLIEST_DATE) return undefined;
  return from > asOf ? asOf : from;
}

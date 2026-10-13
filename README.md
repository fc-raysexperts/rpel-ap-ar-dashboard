# RPEL — AP / AR Ledger

Live Creditors (AP) and Debtors (AR) dashboard for Rays Power Experts Ltd., built directly
on the Zoho Books API. Deployed as a standalone Next.js app (same pattern as the Finance
Command Centre and MIS dashboards), not dependent on any Claude connector.

## Why this exists — the short version

The bank-submission Creditors/Debtors statements were previously built from Zoho's *AR/AP
Aging Summary* reports, which include a `unused_credits_...` figure that turned out to be
contaminated by "JN-Clean" ledger-migration journal entries (large, real-looking credits
that were actually just balance transfers between old and new chart-of-accounts codes, not
real usable credit). Filtering those out from an aggregate report proved unreliable.

This dashboard sidesteps the problem by construction: it sums each individual invoice's /
bill's own `balance` field, which Zoho maintains directly as payments and credit notes are
applied to it. **Journal entries — JN-Clean or otherwise — never touch that field**, so
there's nothing to filter. The one thing invoice-level balances can't see (a payment or
credit note that hasn't been matched to a specific invoice yet) is shown as its own
transparent "Unapplied Credits" line rather than force-fit into an aging bucket.

## A note on API call volume (read this before wiring in real credentials)

Zoho Books enforces its rate limit **per organization** — 100 requests/minute, and a daily
cap of 1,000-10,000 depending on plan — shared across every app hitting this Zoho org,
including any other dashboard (e.g. the MIS one) using the same or a different token. An
early version of the AR/AP calculators here looped one API call per active customer/vendor
(3 calls each), which would have cost roughly **1,800 calls for a single page load** at
RPEL's scale (~220 active customers, ~380 active vendors) — enough to exhaust a full day's
quota in one refresh and degrade every other Zoho-connected tool for the org.

The current version fetches each transaction type **once for the whole org** (paginated,
~200 records/call — Invoices, Customer Payments, Credit Notes, Bills, Vendor Payments,
Vendor Credits) and groups results by contact in memory. Call count now scales with total
transaction volume, not with contact headcount — typically a few dozen calls per refresh
rather than thousands.

**Still worth doing before relying on this for anything real:** there's no caching layer
yet, so every dashboard page load triggers a fresh fetch. If this ends up being loaded
often, add a cache (e.g. re-fetch on a schedule — hourly or daily — and serve the cached
result to page loads in between) rather than hitting Zoho live on every visit. Flagging
this now rather than after it causes a 429 in production.

## Stack

- Next.js 16 (App Router) + React 19 + TypeScript
- Tailwind CSS
- `exceljs` for the Excel download
- Deployed on Vercel

## Local development

```bash
npm install
cp .env.local.example .env.local
npm run dev
```

Open http://localhost:3000 (or whichever port you choose with `-p`).

**Without Zoho credentials filled in**, the app automatically runs in mock mode, showing
sample data (including our two hand-validated real figures — Wonder Cement Limited and
Abhishek Enterprises — so you can confirm the math is right even offline). A banner on the
page tells you when you're looking at mock data.

## Going live: Zoho credentials

You need a **Self Client (Server-based Application)** in the
[Zoho API Console](https://api-console.zoho.com):

1. Create a new "Server-based Application".
2. Note the **Client ID** and **Client Secret**.
3. Generate a refresh token via Zoho's OAuth flow, granting read access to Books —
   `ZohoBooks.fullaccess.all` is simplest to start with; you can narrow this later to
   just the read scopes this app actually uses (contacts, invoices, customerpayments,
   creditnotes, bills, vendorpayments, vendorcredits).
4. Fill in `.env.local`:
   - `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`
   - `ZOHO_ORGANIZATION_ID` — from Zoho Books → Settings → Organization Profile
   - `ZOHO_ACCOUNTS_BASE` / `ZOHO_API_BASE` — set to the `.in` endpoints by default
     (matching RPEL's data center); change if that's ever not the case.

**Before trusting live numbers, verify one field name:** `lib/ar-calculator.ts` and
`lib/ap-calculator.ts` read a `p.unused_amount` field off each Customer/Vendor Payment
object to net out unapplied excess payments. That field name is correct per Zoho's
documented API, but hasn't been checked against a live response from this org yet — the
first time you connect real credentials, sanity-check one customer with a known excess
payment (Wonder Cement is a good candidate — its statement had several) against the
`/api/ar` JSON output before relying on the dashboard for a bank submission.

## Deploying

Push to a new (private) Git repo, import it into a new Vercel project, and copy the values from
`.env.local` into **Settings → Environment Variables** before the first deploy (paste the whole
block). `.env.local` is gitignored and never committed.

```bash
git init
git add .
git commit -m "RPEL AP/AR ledger dashboard"
git branch -M main
git remote add origin <your-new-repo-url>
git push -u origin main
```

Variables on Vercel: the `ZOHO_*` ones, `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`
(the same Redis the local `npm run sync-cache` fills, so the site has data from the first load) and
`CRON_SECRET` (any long random string; it only protects the refresh trigger, not the dashboard).

### How the data is refreshed

Zoho Books is read **once a day, at 07:00 AM IST** (`vercel.json`: `30 1 * * *`, UTC). Everything shown for
the next 24 hours is that one snapshot: page loads never call Zoho, every visitor sees the same figures, and
a date later than the snapshot's day is answered as of the snapshot day. If a refresh fails, the previous
snapshot stays exactly as it was. `GET /api/cron/status` shows when the data was last read.

To refresh by hand: `npm run sync-cache` on a computer with the Zoho keys, or call
`/api/cron/refresh?force=1` with the header `Authorization: Bearer <CRON_SECRET>`.

On Vercel's Hobby plan a daily cron fires at some point within the hour (06:30 to 07:29 IST) and Hobby is for
non-commercial use; on Pro it fires within the minute.

#### The Stock Statement tab

The Stock Statement works the same way, on its own job: **`/api/cron/stock` at 07:45 AM IST** (`15 2 * * *`, UTC)
reads Zoho's Stock Summary for **every month from April 2026 to today** (the running month up to today) and saves
each month in Redis. Every earlier month is read again each day, because Zoho lets earlier months change. A page
load, a period switch and the Excel download only add up those saved months, so they never wait on Zoho. The list
of products shown on their own line (above Rs 5 lakhs at any month-end of the year) is worked out again from the
same data every day.

- The very first time (no copy saved yet), call `/api/cron/stock?force=1` once with the header
  `Authorization: Bearer <CRON_SECRET>`, or just open the tab: it reads the months and shows its progress.
- If a month fails, yesterday's copy stays on screen and the next call carries on where the job stopped.
- Custom dates that are not whole months (for example 5 Sep to 20 Sep) cannot be added up from months, so
  those are read from Zoho directly (kept 5 minutes) and the top-right label says **Live**.
- `GET /api/cron/status` also shows when the stock copy was read and which day it is for.
- A local `npm run dev` reads the months again on the first visit of each new day (there is no 07:45 job locally).

## Known limitations / next steps

- **Aging is invoice/bill-level, not the old Aging-Summary bucket structure.** AR shows
  <180/>180 days from each invoice's own due date; AP currently shows only a total (per
  the original spec) but bill-level due dates are already being fetched, so an aging split
  can be added to the AP table trivially if wanted.
- **Journals aren't fetched yet.** The `zoho-client.ts` module already includes
  `listJournals()`, ready to wire in once needed — e.g. for a future audit view showing
  actual JN-Clean entries directly rather than relying on manual exports.
- **`uuid` transitive advisory (moderate)** via `exceljs`'s internal ZIP writer — not
  triggered by anything this app does (we never parse untrusted buffers), and the
  `npm audit fix` path would downgrade exceljs to a much older release, so it's left as-is
  pending an exceljs update.

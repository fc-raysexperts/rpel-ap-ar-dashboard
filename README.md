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

This repo is structured to push straight to a new Git repo and deploy on Vercel, same as
the other two dashboards:

```bash
git init
git add .
git commit -m "Initial commit: RPEL AP/AR ledger dashboard"
git remote add origin <your-new-repo-url>
git push -u origin main
```

Then in Vercel: **New Project → Import** the repo, and add the same environment variables
from `.env.local` under **Settings → Environment Variables** before the first deploy.
`.env.local` itself is gitignored and never committed — credentials only ever live in
Vercel's environment variable store and your own local `.env.local`.

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

'use client';

import { useEffect, useState } from 'react';
import { SummaryStrip } from '@/components/SummaryStrip';
import { ARLedgerTable, APLedgerTable } from '@/components/LedgerTable';
import { PeriodSelector } from '@/components/PeriodSelector';
import type { ARSummary } from '@/lib/ar-calculator';
import type { APSummary } from '@/lib/ap-calculator';

function todayISO(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export default function DashboardPage() {
  const [asOf, setAsOf] = useState(todayISO());
  type Meta = {
    mock?: boolean;
    fromCache?: boolean;
    cachedAt?: string;
    ledgerBasis?: 'current' | 'snapshot' | 'unavailable';
    agingBasis?: 'report' | 'approximate';
    jnCleanLoaded?: boolean;
    jnApplicationsRead?: boolean;
  };
  const [ar, setAr] = useState<(ARSummary & Meta) | null>(null);
  const [ap, setAp] = useState<(APSummary & Meta) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      fetch(`/api/ar?asOf=${asOf}`).then((r) => r.json()),
      fetch(`/api/ap?asOf=${asOf}`).then((r) => r.json()),
    ])
      .then(([arData, apData]) => {
        if (cancelled) return;
        if (arData.error) throw new Error(arData.error);
        if (apData.error) throw new Error(apData.error);
        setAr(arData);
        setAp(apData);
      })
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [asOf]);

  const isToDate = asOf === todayISO();

  return (
    <div className="min-h-screen bg-paper">
      <div className="border-b border-ink/10 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4 sm:px-10">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-sm bg-ledger font-serif text-base font-semibold text-paper">
              R
            </div>
            <div>
              <p className="font-serif text-[15px] font-semibold leading-tight text-ink">
                Rays Power Experts Ltd.
              </p>
              <p className="text-[11px] leading-tight text-ink/45">Finance &amp; Compliance</p>
            </div>
          </div>
          <div className="hidden items-center gap-1 font-mono text-[11px] text-ink/40 sm:flex">
            <span className={`h-1.5 w-1.5 rounded-full ${ar?.mock ? 'bg-brass' : 'bg-ledger'}`} />
            {ar?.mock
              ? 'Sample data'
              : ar?.fromCache
                ? `Zoho Books data as of ${ar.cachedAt ? new Date(ar.cachedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''} IST · refreshed daily at 7:00 AM`
                : 'Live · Zoho Books (uncached)'}
          </div>
        </div>
      </div>

      <main className="mx-auto max-w-6xl px-6 py-10 sm:px-10 sm:py-12">
        <header className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-wider text-ink/40">
              Accounts Payable &amp; Receivable
            </p>
            <h1 className="mt-1 font-serif text-4xl font-semibold text-ink sm:text-[2.75rem]">
              AP / AR Ledger
            </h1>
          </div>
          <PeriodSelector asOf={asOf} onChange={setAsOf} />
        </header>

        {ar?.mock && (
          <p className="mt-6 border border-brass/40 bg-brass/[0.08] px-4 py-2.5 text-sm text-ink/70">
            Showing sample data — connect live Zoho Books credentials (see README) to replace
            this with your organization&rsquo;s actual figures.
          </p>
        )}

        {!ar?.mock && !error && ar?.ledgerBasis === 'snapshot' && ar?.agingBasis === 'report' && (
          <p className="mt-6 border border-brass/40 bg-brass/[0.08] px-4 py-2.5 text-sm text-ink/70">
            Totals and age buckets for {asOf} come from Zoho&rsquo;s own ledger and aging reports for that
            day, with JN-Clean&rsquo;s spend added back. A &#9873; marks a customer whose buckets fall short
            of its ledger balance and could not be fully explained.
          </p>
        )}

        {!ar?.mock && !error && ar?.ledgerBasis === 'snapshot' && ar?.agingBasis !== 'report' && (
          <p className="mt-6 border border-brass/40 bg-brass/[0.08] px-4 py-2.5 text-sm text-ink/70">
            Totals for {asOf} come from a stored Zoho ledger snapshot for that date (the Statement
            balance on that day). Age buckets still use today&rsquo;s invoice balances, so treat the
            &lt;180 / &gt;180 split as approximate.
          </p>
        )}

        {!ar?.mock && !isToDate && !error && ar?.ledgerBasis === 'unavailable' && (
          <p className="mt-6 border border-brass/40 bg-brass/[0.08] px-4 py-2.5 text-sm text-ink/70">
            No ledger snapshot is stored for {asOf}, so this shows what was invoiced/billed by that
            date and is <em>still unpaid as of right now</em> — an approximation, not the Statement
            balance on that day. Run <code>npm run sync-ledger -- {asOf}</code> to store it.
          </p>
        )}

        {!ar?.mock && !error && ar && ar.jnCleanLoaded === false && (
          <p className="mt-6 border border-brass/40 bg-brass/[0.08] px-4 py-2.5 text-sm text-ink/70">
            JN-Clean data has not been loaded yet. Totals are unaffected, but the age buckets can be
            understated. Run <code>npm run sync-cache</code> to load it.
          </p>
        )}

        {!ar?.mock && !error && ar && ar.jnCleanLoaded && ar.jnApplicationsRead === false && (
          <p className="mt-6 border border-brass/40 bg-brass/[0.08] px-4 py-2.5 text-sm text-ink/70">
            JN-Clean journals were loaded but what they were spent on could not be read. Totals are
            unaffected; rows whose age buckets fall short are flagged ⚑. Open{' '}
            <code>/api/debug/probe</code> to see what Zoho returns.
          </p>
        )}

        {error && (
          <p className="mt-6 border border-rust/40 bg-rust/[0.06] px-4 py-2.5 text-sm text-rust">
            {error}
          </p>
        )}

        <div className="mt-8">
          <SummaryStrip
            arNet={ar?.grandTotal.netTotal ?? 0}
            arLess180={ar?.grandTotal.less180 ?? 0}
            arMore180={ar?.grandTotal.more180 ?? 0}
            arCount={ar?.customers.length ?? 0}
            apNet={ap?.grandTotal.netTotal ?? 0}
            apCount={ap?.vendors.length ?? 0}
            loading={loading}
          />
        </div>

        <div className="mt-14 space-y-16">
          {ar && <ARLedgerTable data={ar} asOf={asOf} />}
          {ap && <APLedgerTable data={ap} asOf={asOf} />}
        </div>

        <footer className="mt-16 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-6 font-mono text-[11px] text-ink/40">
          <span>As of {ar?.asOfDate ?? asOf}{isToDate ? ' · latest 7:00 AM refresh' : ''}</span>
          <span>
            {ar?.ledgerGrandTotal !== undefined && ap?.ledgerGrandTotal !== undefined
              ? ar.unreconciledCount + ap.unreconciledCount === 0
                ? 'Totals are the sum of invoices, bills and journals · they match Zoho\u2019s ledger for every contact'
                : `Totals are the sum of invoices, bills and journals · ⚑ ${ar.unreconciledCount + ap.unreconciledCount} contact(s) differ from Zoho\u2019s ledger`
              : 'Totals are the sum of invoices, bills and journals · no Zoho ledger figure to check them against for this date'}
          </span>
        </footer>
      </main>
    </div>
  );
}

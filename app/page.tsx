'use client';

import { useEffect, useState } from 'react';
import { SummaryStrip } from '@/components/SummaryStrip';
import { ARLedgerTable, APLedgerTable } from '@/components/LedgerTable';
import { PeriodSelector } from '@/components/PeriodSelector';
import type { ARSummary } from '@/lib/ar-calculator';
import type { APSummary } from '@/lib/ap-calculator';

export default function DashboardPage() {
  const [since, setSince] = useState('2025-04-01');
  const [ar, setAr] = useState<(ARSummary & { mock?: boolean }) | null>(null);
  const [ap, setAp] = useState<(APSummary & { mock?: boolean }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      fetch(`/api/ar?since=${since}`).then((r) => r.json()),
      fetch(`/api/ap?since=${since}`).then((r) => r.json()),
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
  }, [since]);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10 sm:px-10 sm:py-14">
      <header className="flex flex-col justify-between gap-4 border-b-2 border-ink pb-6 sm:flex-row sm:items-end">
        <div>
          <p className="font-mono text-xs uppercase tracking-wide text-ink/50">
            Rays Power Experts Ltd.
          </p>
          <h1 className="font-serif text-3xl font-semibold text-ink sm:text-4xl">
            AP / AR Ledger
          </h1>
        </div>
        <PeriodSelector since={since} onChange={setSince} />
      </header>

      {ar?.mock && (
        <p className="mt-6 border border-brass/40 bg-brass/10 px-4 py-2 text-sm text-ink/70">
          Showing sample data — connect live Zoho Books credentials (see README) to replace this
          with your organization&rsquo;s actual figures.
        </p>
      )}

      {error && (
        <p className="mt-6 border border-rust/40 bg-rust/10 px-4 py-2 text-sm text-rust">
          {error}
        </p>
      )}

      <div className="mt-8 border border-line">
        <SummaryStrip
          arNet={ar?.grandTotal.netTotal ?? 0}
          arLess180={ar?.grandTotal.less180 ?? 0}
          arMore180={ar?.grandTotal.more180 ?? 0}
          apNet={ap?.grandTotal.netTotal ?? 0}
          loading={loading}
        />
      </div>

      <div className="mt-12 space-y-14">
        {ar && <ARLedgerTable data={ar} since={since} />}
        {ap && <APLedgerTable data={ap} since={since} />}
      </div>

      <footer className="mt-16 border-t border-line pt-6 font-mono text-xs text-ink/40">
        As of {ar ? new Date(ar.asOfDate).toLocaleString('en-IN') : '—'} · Unapplied credits shown
        net of aging, not forced into a dated bucket
      </footer>
    </main>
  );
}

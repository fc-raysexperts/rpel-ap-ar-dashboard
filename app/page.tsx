'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { SummaryStrip } from '@/components/SummaryStrip';
import { ARLedgerTable, APLedgerTable } from '@/components/LedgerTable';
import { PeriodSelector } from '@/components/PeriodSelector';
import { DownloadButton } from '@/components/DownloadButton';
import { CreditsModal } from '@/components/CreditsModal';
import { StockPeriodSelector } from '@/components/StockPeriodSelector';
import { StockTable } from '@/components/StockTable';
import { StockSummary } from '@/components/StockSummary';
import { StockDownloadButton } from '@/components/StockDownloadButton';
import type { ARSummary } from '@/lib/ar-calculator';
import type { APSummary } from '@/lib/ap-calculator';
import type { StockApiData } from '@/lib/stock-calculator';
import { defaultStockRange } from '@/lib/stock-period';
import { APP_NAME, FIRM_NAME, TEAM_NAME } from '@/lib/brand';

function todayISO(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function prettyDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function Notice({ children, tone = 'warn' }: { children: ReactNode; tone?: 'warn' | 'error' }) {
  return (
    <p
      className={`mt-6 rounded-xl border px-4 py-3 text-[13.5px] leading-relaxed ${
        tone === 'error' ? 'border-rust/40 bg-rust/[0.06] text-rust' : 'border-brass/40 bg-brass/[0.08] text-ink/75'
      }`}
    >
      {children}
    </p>
  );
}

type Tab = 'ar' | 'ap' | 'stock';

/** Shown only when the daily copy of the stock data has not been read yet (the very first load, or a missed 07:45 refresh): every month of the year is being read from Zoho once. */
function StockBuilding({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className="px-6 py-10 sm:px-10" role="status">
      <p className="font-display text-[17px] font-bold text-navy">Reading this year&rsquo;s stock from Zoho Books…</p>
      <p className="mt-2 max-w-2xl text-[13.5px] leading-relaxed text-ink/65">
        The Stock Statement is read from Zoho Books once a day (7:45 AM) and that copy is shown all day, instantly. There is no copy yet, so every month of the year is being read once.
        This takes a minute or two, then the page opens by itself.
      </p>
      <div className="mt-5 h-2.5 max-w-md overflow-hidden rounded-full bg-line/80">
        <div className="h-full rounded-full bg-accent transition-all duration-500" style={{ width: `${Math.max(pct, 4)}%` }} />
      </div>
      <p className="mt-2 text-[12.5px] tabular text-ink/55">
        {done} of {total} {total === 1 ? 'month' : 'months'} read
      </p>
    </div>
  );
}

export default function DashboardPage() {
  const [asOf, setAsOf] = useState(todayISO());
  // start of a custom From-To range; null = everything from the start of the books up to asOf
  const [from, setFrom] = useState<string | null>(null);
  type Meta = {
    mock?: boolean;
    fromCache?: boolean;
    cachedAt?: string;
    ledgerBasis?: 'current' | 'snapshot' | 'unavailable' | 'range';
    agingBasis?: 'report' | 'approximate';
    jnCleanLoaded?: boolean;
    jnApplicationsRead?: boolean;
  };
  const [ar, setAr] = useState<(ARSummary & Meta) | null>(null);
  const [ap, setAp] = useState<(APSummary & Meta) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('ar');
  const [creditsOpen, setCreditsOpen] = useState(false);
  const closeCredits = useCallback(() => setCreditsOpen(false), []);

  // --- Stock Statement tab: its own period (literally From..To), its own data; read only while the tab is open
  const [stockRange, setStockRange] = useState(() => defaultStockRange(todayISO()));
  const [stock, setStock] = useState<(StockApiData & { rangeAdjusted?: boolean }) | null>(null);
  const [stockLoading, setStockLoading] = useState(false);
  const [stockError, setStockError] = useState<string | null>(null);
  const [stockBuild, setStockBuild] = useState<{ done: number; total: number } | null>(null);
  const changeStockPeriod = useCallback((f: string, t: string) => setStockRange({ from: f, to: t }), []);

  useEffect(() => {
    if (tab !== 'stock') return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setStockLoading(true);
    setStockError(null);

    const load = async () => {
      try {
        const res = await fetch(`/api/stock?from=${stockRange.from}&to=${stockRange.to}`);
        const body = await res.json();
        if (cancelled) return;
        if (body.error) throw new Error(body.error);
        if (body.building) {
          // the daily copy is being read for the first time: ask again in a moment
          setStockBuild(body.progress);
          timer = setTimeout(load, 2500);
          return;
        }
        setStockBuild(null);
        setStock(body);
        setStockLoading(false);
      } catch (e) {
        if (cancelled) return;
        setStockBuild(null);
        setStock(null);
        setStockError(e instanceof Error ? e.message : 'The stock statement could not be loaded.');
        setStockLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [tab, stockRange.from, stockRange.to]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const q = `asOf=${asOf}${from ? `&from=${from}` : ''}`;
    Promise.all([
      fetch(`/api/ar?${q}`).then((r) => r.json()),
      fetch(`/api/ap?${q}`).then((r) => r.json()),
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
  }, [asOf, from]);

  const changePeriod = useCallback((to: string, start: string | null) => {
    setAsOf(to);
    setFrom(start);
  }, []);

  const isToDate = asOf === todayISO();
  const shownDate = ar?.asOfDate ?? null;

  const refreshLine = ar?.mock
    ? 'Sample data'
    : ar?.fromCache
      ? `Zoho Books data as of ${ar.cachedAt ? new Date(ar.cachedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''} IST · refreshed daily at 7:00 AM`
      : ar
        ? 'Live · Zoho Books (uncached)'
        : 'Loading data…';

  // --- what the header says on the Stock Statement tab
  const onStock = tab === 'stock';
  const stockLine = stock?.mock
    ? 'Sample data'
    : stock
      ? stock.source === 'live'
        ? `Live · Zoho Books Stock Summary · read ${new Date(stock.pulledAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })} IST · these dates are not whole months`
        : `Zoho Books data as of ${new Date(stock.pulledAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })} IST · refreshed daily at 7:45 AM`
      : stockError
        ? 'Zoho Books Stock Summary · could not be read'
        : 'Loading stock…';
  const stockMock = !!stock?.mock;

  const tabs: { key: Tab; label: string; tone: string; bar: string }[] = [
    { key: 'ar', label: 'Debtors AR - Customers', tone: 'text-ledger', bar: 'border-t-ledger' },
    { key: 'ap', label: 'Creditors AP - Vendors', tone: 'text-rust', bar: 'border-t-rust' },
    { key: 'stock', label: 'Stock Statement', tone: 'text-accent', bar: 'border-t-accent' },
  ];

  return (
    <div className="min-h-screen bg-paper">
      <header className="bg-gradient-to-r from-navy via-[#14305F] to-navy2 text-white shadow-md">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-y-3 px-5 py-4 sm:px-10">
          <div className="order-1 mr-auto flex items-center gap-3.5 pr-4">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white shadow-md ring-1 ring-white/40">
              {/* the "Ledger" emoji, same artwork as the browser-tab icon */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/icon.png" alt="" width={28} height={28} className="h-7 w-7" />
            </span>
            <div>
              <p className="font-display text-[17px] font-extrabold leading-tight tracking-tight sm:text-[1.2rem]">{FIRM_NAME}</p>
              <p className="mt-0.5 text-[12.5px] leading-tight text-white/70">{TEAM_NAME}</p>
            </div>
          </div>
          <p className="order-3 flex w-full flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px] font-medium text-white/90 md:order-2 md:w-auto md:pr-5 md:text-[13px]">
            {(() => {
              const sample = onStock ? stockMock : ar?.mock;
              return <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${sample ? 'bg-brass' : 'bg-emerald-400'} ring-4 ${sample ? 'ring-brass/25' : 'ring-emerald-400/25'}`} />;
            })()}
            {onStock ? stockLine : refreshLine}
          </p>
          <button
            onClick={() => setCreditsOpen(true)}
            className="order-2 rounded-lg border border-white/35 bg-white/10 px-3.5 py-1.5 text-[13px] font-semibold text-white transition hover:bg-white/20 md:order-3"
          >
            Credits
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-5 py-9 sm:px-10 sm:py-11">
        <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
          <div>
            <h1 className="font-display text-4xl font-extrabold tracking-tight text-navy sm:text-[2.75rem] sm:leading-[1.1]">{APP_NAME}</h1>
            <p className="mt-2 min-h-[1.5rem] text-[14px] text-ink/60">
              {onStock
                ? stock
                  ? `Stock from ${prettyDate(stock.from)} to ${prettyDate(stock.to)}`
                  : ''
                : shownDate
                  ? ar?.fromDate
                    ? `Invoices and bills dated ${prettyDate(ar.fromDate)} to ${prettyDate(shownDate)}, still unpaid`
                    : `Debtors and creditors position as of ${prettyDate(shownDate)}`
                  : ''}
            </p>
          </div>
          <div className="flex flex-wrap items-start gap-3">
            {/* both sets of controls stay mounted, so each tab keeps the period that was picked on it */}
            <div className={onStock ? 'hidden' : 'contents'}>
              <DownloadButton asOf={asOf} from={ar?.fromDate ?? from} />
              <PeriodSelector asOf={asOf} from={from} onChange={changePeriod} />
            </div>
            <div className={onStock ? 'contents' : 'hidden'}>
              <StockDownloadButton from={stock?.from ?? stockRange.from} to={stock?.to ?? stockRange.to} disabled={!stock || stockLoading || !!stockBuild} />
              <StockPeriodSelector from={stockRange.from} to={stockRange.to} onChange={changeStockPeriod} />
            </div>
          </div>
        </div>

        {!onStock && ar?.mock && (
          <Notice>
            Showing sample data — connect live Zoho Books credentials (see README) to replace this with your organization&rsquo;s actual figures.
          </Notice>
        )}

        {!onStock && !ar?.mock && !error && ar?.ledgerBasis === 'range' && ar.fromDate && (
          <Notice>
            Custom range: this lists the invoices, bills, journals, payments and credits dated {prettyDate(ar.fromDate)} to {prettyDate(ar.asOfDate)} that are still unpaid.
            Their balances are Zoho&rsquo;s as at the latest 7:00 AM refresh (Zoho keeps no day-by-day history on an invoice), and Zoho&rsquo;s own ledger is not split by document date,
            so there is no ledger check on a range. Use <b>Total till date</b>, Yearly, Quarterly or Monthly for figures that tie to Zoho&rsquo;s ledger.
          </Notice>
        )}

        {!onStock && !ar?.mock && !error && ar?.ledgerBasis === 'snapshot' && ar?.agingBasis === 'report' && (
          <Notice>
            Totals and age buckets for {asOf} come from Zoho&rsquo;s own ledger and aging reports for that day, with JN-Clean&rsquo;s spend added back. A &#9873; marks a customer whose buckets fall short of its ledger balance and could not be fully explained.
          </Notice>
        )}

        {!onStock && !ar?.mock && !error && ar?.ledgerBasis === 'snapshot' && ar?.agingBasis !== 'report' && (
          <Notice>
            Totals for {asOf} come from a stored Zoho ledger snapshot for that date (the Statement balance on that day). Age buckets still use today&rsquo;s invoice balances, so treat the &lt;180 / &gt;180 split as approximate.
          </Notice>
        )}

        {!onStock && !ar?.mock && !isToDate && !error && ar?.ledgerBasis === 'unavailable' && (
          <Notice>
            No ledger snapshot is stored for {asOf}, so this shows what was invoiced/billed by that date and is <em>still unpaid as of right now</em> — an approximation, not the Statement balance on that day. Run <code>npm run sync-ledger -- {asOf}</code> to store it.
          </Notice>
        )}

        {!onStock && !ar?.mock && !error && ar && ar.jnCleanLoaded === false && (
          <Notice>
            JN-Clean data has not been loaded yet. Totals are unaffected, but the age buckets can be understated. Run <code>npm run sync-cache</code> to load it.
          </Notice>
        )}

        {!onStock && !ar?.mock && !error && ar && ar.jnCleanLoaded && ar.jnApplicationsRead === false && (
          <Notice>
            JN-Clean journals were loaded but what they were spent on could not be read. Totals are unaffected; rows whose age buckets fall short are flagged ⚑. Open <code>/api/debug/probe</code> to see what Zoho returns.
          </Notice>
        )}

        {!onStock && error && <Notice tone="error">{error}</Notice>}

        {onStock && stockMock && (
          <Notice>
            Showing sample stock data — connect live Zoho Books credentials (see README) to replace this with your organization&rsquo;s actual stock.
          </Notice>
        )}

        {onStock && stock?.rangeAdjusted && (
          <Notice>
            The dates were moved to {prettyDate(stock.from)} – {prettyDate(stock.to)}: this tab starts on 1 Apr 2026 and cannot go past today.
          </Notice>
        )}

        {onStock && stockError && <Notice tone="error">{stockError}</Notice>}

        <div className="mt-8">
          {onStock ? (
            <StockSummary data={stock} loading={!stock && !stockError} />
          ) : (
            <SummaryStrip
              arNet={ar?.grandTotal.netTotal ?? 0}
              arLess180={ar?.grandTotal.less180 ?? 0}
              arMore180={ar?.grandTotal.more180 ?? 0}
              arCount={ar?.customers.length ?? 0}
              apNet={ap?.grandTotal.netTotal ?? 0}
              apCount={ap?.vendors.length ?? 0}
              loading={loading && !ar}
            />
          )}
        </div>

        <section className="mt-10" aria-busy={onStock ? stockLoading : loading}>
          <div role="tablist" aria-label="Ledger" className="flex flex-wrap items-end gap-1.5 pl-1">
            {tabs.map((t) => {
              const active = tab === t.key;
              return (
                <button
                  key={t.key}
                  role="tab"
                  id={`tab-${t.key}`}
                  aria-selected={active}
                  aria-controls={`panel-${t.key}`}
                  onClick={() => setTab(t.key)}
                  className={`relative rounded-t-xl border border-b-0 border-t-[3px] px-5 py-2.5 font-display text-[14px] font-bold transition ${
                    active
                      ? `z-10 -mb-px border-line bg-white ${t.tone} ${t.bar} shadow-[0_-6px_16px_-10px_rgba(15,37,71,0.35)]`
                      : 'border-transparent border-t-transparent bg-navy/[0.06] text-ink/55 hover:bg-navy/10 hover:text-navy'
                  }`}
                >
                  {t.label}
                </button>
              );
            })}
          </div>

          <div
            role="tabpanel"
            id={`panel-${tab}`}
            aria-labelledby={`tab-${tab}`}
            className={`overflow-hidden rounded-b-2xl rounded-tr-2xl border border-line bg-white shadow-card transition-opacity ${
              (onStock ? stockLoading && stock : loading && ar) ? 'opacity-60' : ''
            }`}
          >
            {onStock ? (
              stockBuild ? (
                <StockBuilding done={stockBuild.done} total={stockBuild.total} />
              ) : stock ? (
                <StockTable data={stock} />
              ) : stockError ? (
                <p className="px-6 py-10 text-[14px] text-ink/65">The stock statement could not be loaded. Reload the page to try again.</p>
              ) : (
                <div className="space-y-3 p-6">
                  {[0, 1, 2, 3, 4, 5].map((i) => (
                    <div key={i} className="h-9 animate-pulse rounded-lg bg-line/60" />
                  ))}
                </div>
              )
            ) : !ar || !ap ? (
              <div className="space-y-3 p-6">
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <div key={i} className="h-9 animate-pulse rounded-lg bg-line/60" />
                ))}
              </div>
            ) : tab === 'ar' ? (
              <ARLedgerTable data={ar} asOf={asOf} />
            ) : (
              <APLedgerTable data={ap} asOf={asOf} />
            )}
          </div>
        </section>

        <footer className="mt-10 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-5 text-[12px] text-ink/50">
          <span>
            {onStock
              ? stock
                ? `Stock ${stock.from} to ${stock.to}`
                : ''
              : shownDate
                ? ar?.fromDate
                  ? `Range ${ar.fromDate} to ${shownDate}`
                  : `As of ${shownDate}${isToDate ? ' · latest 7:00 AM refresh' : ''}`
                : ''}
          </span>
          <span>
            {onStock
              ? stock
                ? stock.quantitiesTie
                  ? 'Quantities are Zoho’s own and match its Stock Summary exactly · amounts are Zoho’s own, except that amounts on negative stock are subtracted (see the working under the table)'
                  : '⚑ Quantities differ from Zoho’s Stock Summary · see the working under the table'
                : ''
              : ar?.fromDate
              ? 'Totals are the sum of the invoices, bills and journals in the range · no Zoho ledger check for a range'
              : ar?.ledgerGrandTotal !== undefined && ap?.ledgerGrandTotal !== undefined
              ? ar.unreconciledCount + ap.unreconciledCount === 0
                ? 'Totals are the sum of invoices, bills and journals · they match Zoho’s ledger for every contact'
                : `Totals are the sum of invoices, bills and journals · ⚑ ${ar.unreconciledCount + ap.unreconciledCount} contact(s) differ from Zoho’s ledger`
              : ar
                ? 'Totals are the sum of invoices, bills and journals · no Zoho ledger figure to check them against for this date'
                : ''}
          </span>
        </footer>
      </main>

      <CreditsModal open={creditsOpen} onClose={closeCredits} />
    </div>
  );
}

import { formatINR } from './SummaryStrip';
import type { ARSummary } from '@/lib/ar-calculator';
import type { APSummary } from '@/lib/ap-calculator';

function DownloadLink({ kind, asOf }: { kind: 'ar' | 'ap'; asOf?: string }) {
  const href = `/api/export?kind=${kind}${asOf ? `&asOf=${asOf}` : ''}`;
  return (
    <a
      href={href}
      className="inline-flex items-center gap-2 border border-ink/15 bg-white px-3.5 py-2 text-xs font-medium text-ink/70 shadow-sm transition hover:border-ledger hover:text-ledger"
    >
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M8 1v9m0 0L4.5 6.5M8 10l3.5-3.5M2 12.5V14a1 1 0 001 1h10a1 1 0 001-1v-1.5"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      Download .xlsx
    </a>
  );
}

function SectionHeader({
  title,
  count,
  kind,
  asOf,
  flagged = 0,
}: {
  title: string;
  count: number;
  kind: 'ar' | 'ap';
  asOf?: string;
  flagged?: number;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3 border-b-2 border-ink pb-3">
      <div className="flex items-baseline gap-3">
        <h2 className="font-serif text-2xl font-semibold text-ink">{title}</h2>
        <span className="font-mono text-xs text-ink/40">{count} active</span>
        {flagged > 0 && (
          <span
            className="font-mono text-xs text-brass"
            title="The invoices/bills and journals add up to the figure shown, but Zoho's own ledger balance for these contacts is different. Hover the flag on a row for both figures."
          >
            ⚑ {flagged} to review
          </span>
        )}
      </div>
      <DownloadLink kind={kind} asOf={asOf} />
    </div>
  );
}

export function ARLedgerTable({ data, asOf }: { data: ARSummary; asOf?: string }) {
  return (
    <section>
      <SectionHeader title="Debtors ledger" count={data.customers.length} kind="ar" asOf={asOf} flagged={data.unreconciledCount} />
      <div className="overflow-x-auto border border-line bg-white shadow-sm">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <thead>
            <tr className="bg-paper/70 text-left text-[10px] uppercase tracking-wider text-ink/45">
              <th className="py-3 pl-5 pr-3 font-semibold">#</th>
              <th className="py-3 pr-3 font-semibold">Customer</th>
              <th className="py-3 pr-3 text-right font-semibold">&lt;180 days</th>
              <th className="py-3 pr-3 text-right font-semibold">&gt;180 days</th>
              <th className="py-3 pr-3 text-right font-semibold">Unapplied credits</th>
              <th className="py-3 pr-5 text-right font-semibold">Net</th>
            </tr>
          </thead>
          <tbody className="font-mono tabular">
            {data.customers.map((c, i) => (
              <tr
                key={c.customerId}
                className={`border-t border-line/70 transition-colors hover:bg-ledger/[0.04] ${
                  i % 2 === 1 ? 'bg-paper/40' : ''
                }`}
              >
                <td className="py-3 pl-5 pr-3 text-ink/35">{i + 1}</td>
                <td className="py-3 pr-3 font-sans text-[13.5px] text-ink">{c.customerName}</td>
                <td className="py-3 pr-3 text-right text-ink/80">
                  {c.less180 ? formatINR(c.less180) : '—'}
                </td>
                <td className="py-3 pr-3 text-right text-ink/80">
                  {c.more180 ? formatINR(c.more180) : '—'}
                </td>
                <td className="py-3 pr-3 text-right text-ink/45">
                  {c.unappliedCredits ? `(${formatINR(c.unappliedCredits)})` : '—'}
                </td>
                <td className="py-3 pr-5 text-right font-semibold text-ledger">
                  {c.gap !== 0 && (
                    <span
                      className="mr-1.5 cursor-help font-sans text-brass"
                      title={`The invoices/bills and journals add up to the figure shown. Zoho's own ledger balance for this contact is ${formatINR(c.ledgerTotal ?? 0)} (${formatINR(Math.abs(c.gap))} ${c.gap > 0 ? 'higher' : 'lower'}). Possible causes: timing while Zoho is being edited, an item type not fetched, or JN-Clean data not read.`}
                    >
                      ⚑
                    </span>
                  )}
                  {formatINR(c.netTotal)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-ink bg-ledger/[0.06] font-semibold">
              <td className="py-4 pl-5 pr-3" colSpan={2}>
                Grand Total
              </td>
              <td className="py-4 pr-3 text-right font-mono tabular">
                {formatINR(data.grandTotal.less180)}
              </td>
              <td className="py-4 pr-3 text-right font-mono tabular">
                {formatINR(data.grandTotal.more180)}
              </td>
              <td className="py-4 pr-3 text-right font-mono tabular text-ink/45">
                {data.grandTotal.unappliedCredits
                  ? `(${formatINR(data.grandTotal.unappliedCredits)})`
                  : '—'}
              </td>
              <td className="py-4 pr-5 text-right font-mono tabular text-ledger">
                {formatINR(data.grandTotal.netTotal)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}

export function APLedgerTable({ data, asOf }: { data: APSummary; asOf?: string }) {
  return (
    <section>
      <SectionHeader title="Creditors ledger" count={data.vendors.length} kind="ap" asOf={asOf} flagged={data.unreconciledCount} />
      <div className="overflow-x-auto border border-line bg-white shadow-sm">
        <table className="w-full min-w-[520px] border-collapse text-sm">
          <thead>
            <tr className="bg-paper/70 text-left text-[10px] uppercase tracking-wider text-ink/45">
              <th className="py-3 pl-5 pr-3 font-semibold">#</th>
              <th className="py-3 pr-3 font-semibold">Vendor</th>
              <th className="py-3 pr-3 text-right font-semibold">Billed</th>
              <th className="py-3 pr-3 text-right font-semibold">Unapplied credits</th>
              <th className="py-3 pr-5 text-right font-semibold">Net</th>
            </tr>
          </thead>
          <tbody className="font-mono tabular">
            {data.vendors.map((v, i) => (
              <tr
                key={v.vendorId}
                className={`border-t border-line/70 transition-colors hover:bg-rust/[0.04] ${
                  i % 2 === 1 ? 'bg-paper/40' : ''
                }`}
              >
                <td className="py-3 pl-5 pr-3 text-ink/35">{i + 1}</td>
                <td className="py-3 pr-3 font-sans text-[13.5px] text-ink">{v.vendorName}</td>
                <td className="py-3 pr-3 text-right text-ink/80">{formatINR(v.billedTotal)}</td>
                <td className="py-3 pr-3 text-right text-ink/45">
                  {v.unappliedCredits ? `(${formatINR(v.unappliedCredits)})` : '—'}
                </td>
                <td className="py-3 pr-5 text-right font-semibold text-rust">
                  {v.gap !== 0 && (
                    <span
                      className="mr-1.5 cursor-help font-sans text-brass"
                      title={`The invoices/bills and journals add up to the figure shown. Zoho's own ledger balance for this contact is ${formatINR(v.ledgerTotal ?? 0)} (${formatINR(Math.abs(v.gap))} ${v.gap > 0 ? 'higher' : 'lower'}). Possible causes: timing while Zoho is being edited, an item type not fetched, or JN-Clean data not read.`}
                    >
                      ⚑
                    </span>
                  )}
                  {formatINR(v.netTotal)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-ink bg-rust/[0.05] font-semibold">
              <td className="py-4 pl-5 pr-3" colSpan={2}>
                Grand Total
              </td>
              <td className="py-4 pr-3 text-right font-mono tabular">
                {formatINR(data.grandTotal.billedTotal)}
              </td>
              <td className="py-4 pr-3 text-right font-mono tabular text-ink/45">
                {data.grandTotal.unappliedCredits
                  ? `(${formatINR(data.grandTotal.unappliedCredits)})`
                  : '—'}
              </td>
              <td className="py-4 pr-5 text-right font-mono tabular text-rust">
                {formatINR(data.grandTotal.netTotal)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}

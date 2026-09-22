import { formatINR } from './SummaryStrip';
import type { ARSummary } from '@/lib/ar-calculator';
import type { APSummary } from '@/lib/ap-calculator';

function DownloadLink({ kind, since }: { kind: 'ar' | 'ap'; since?: string }) {
  const href = `/api/export?kind=${kind}${since ? `&since=${since}` : ''}`;
  return (
    <a
      href={href}
      className="inline-flex items-center gap-1.5 border border-ink/20 px-3 py-1.5 text-xs font-medium text-ink/70 transition hover:border-ledger hover:text-ledger"
    >
      Download .xlsx
    </a>
  );
}

export function ARLedgerTable({ data, since }: { data: ARSummary; since?: string }) {
  return (
    <section>
      <div className="mb-4 flex items-baseline justify-between border-b border-line pb-3">
        <h2 className="font-serif text-xl font-semibold text-ink">Debtors ledger</h2>
        <DownloadLink kind="ar" since={since} />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-ink/15 text-left text-xs uppercase tracking-wide text-ink/50">
              <th className="py-2 pr-3 font-medium">#</th>
              <th className="py-2 pr-3 font-medium">Customer</th>
              <th className="py-2 pr-3 text-right font-medium">&lt;180 days</th>
              <th className="py-2 pr-3 text-right font-medium">&gt;180 days</th>
              <th className="py-2 pr-3 text-right font-medium">Unapplied credits</th>
              <th className="py-2 pr-0 text-right font-medium">Net</th>
            </tr>
          </thead>
          <tbody className="font-mono tabular">
            {data.customers.map((c, i) => (
              <tr key={c.customerId} className="border-b border-line/70">
                <td className="py-2 pr-3 text-ink/40">{i + 1}</td>
                <td className="py-2 pr-3 font-sans text-ink">{c.customerName}</td>
                <td className="py-2 pr-3 text-right text-ink/80">
                  {c.less180 ? formatINR(c.less180) : '—'}
                </td>
                <td className="py-2 pr-3 text-right text-ink/80">
                  {c.more180 ? formatINR(c.more180) : '—'}
                </td>
                <td className="py-2 pr-3 text-right text-ink/50">
                  {c.unappliedCredits ? `(${formatINR(c.unappliedCredits)})` : '—'}
                </td>
                <td className="py-2 pr-0 text-right font-medium text-ledger">
                  {formatINR(c.netTotal)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-ink/20 font-medium">
              <td className="py-3 pr-3" colSpan={2}>
                Grand Total
              </td>
              <td className="py-3 pr-3 text-right tabular">{formatINR(data.grandTotal.less180)}</td>
              <td className="py-3 pr-3 text-right tabular">{formatINR(data.grandTotal.more180)}</td>
              <td className="py-3 pr-3 text-right tabular text-ink/50">
                {data.grandTotal.unappliedCredits ? `(${formatINR(data.grandTotal.unappliedCredits)})` : '—'}
              </td>
              <td className="py-3 pr-0 text-right tabular text-ledger">
                {formatINR(data.grandTotal.netTotal)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}

export function APLedgerTable({ data, since }: { data: APSummary; since?: string }) {
  return (
    <section>
      <div className="mb-4 flex items-baseline justify-between border-b border-line pb-3">
        <h2 className="font-serif text-xl font-semibold text-ink">Creditors ledger</h2>
        <DownloadLink kind="ap" since={since} />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-ink/15 text-left text-xs uppercase tracking-wide text-ink/50">
              <th className="py-2 pr-3 font-medium">#</th>
              <th className="py-2 pr-3 font-medium">Vendor</th>
              <th className="py-2 pr-3 text-right font-medium">Billed</th>
              <th className="py-2 pr-3 text-right font-medium">Unapplied credits</th>
              <th className="py-2 pr-0 text-right font-medium">Net</th>
            </tr>
          </thead>
          <tbody className="font-mono tabular">
            {data.vendors.map((v, i) => (
              <tr key={v.vendorId} className="border-b border-line/70">
                <td className="py-2 pr-3 text-ink/40">{i + 1}</td>
                <td className="py-2 pr-3 font-sans text-ink">{v.vendorName}</td>
                <td className="py-2 pr-3 text-right text-ink/80">{formatINR(v.billedTotal)}</td>
                <td className="py-2 pr-3 text-right text-ink/50">
                  {v.unappliedCredits ? `(${formatINR(v.unappliedCredits)})` : '—'}
                </td>
                <td className="py-2 pr-0 text-right font-medium text-rust">
                  {formatINR(v.netTotal)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-ink/20 font-medium">
              <td className="py-3 pr-3" colSpan={2}>
                Grand Total
              </td>
              <td className="py-3 pr-3 text-right tabular">{formatINR(data.grandTotal.billedTotal)}</td>
              <td className="py-3 pr-3 text-right tabular text-ink/50">
                {data.grandTotal.unappliedCredits ? `(${formatINR(data.grandTotal.unappliedCredits)})` : '—'}
              </td>
              <td className="py-3 pr-0 text-right tabular text-rust">
                {formatINR(data.grandTotal.netTotal)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}

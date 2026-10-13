import { formatINR } from './SummaryStrip';
import type { ARSummary } from '@/lib/ar-calculator';
import type { APSummary } from '@/lib/ap-calculator';

const FLAG_NOTE = (ledger: number, gap: number) =>
  `The invoices/bills and journals add up to the figure shown. Zoho's own ledger balance for this contact is ${formatINR(ledger)} (${formatINR(Math.abs(gap))} ${gap > 0 ? 'higher' : 'lower'}). Possible causes: timing while Zoho is being edited, an item type not fetched, or JN-Clean data not read.`;

function SectionHeader({ title, count, flagged = 0 }: { title: string; count: number; flagged?: number }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-6 pb-4 pt-5">
      <h2 className="font-display text-[20px] font-bold text-navy">{title}</h2>
      <span className="text-[14px] font-medium text-ink/55">({count} active)</span>
      {flagged > 0 && (
        <span
          className="ml-auto cursor-help rounded-full bg-brass/10 px-3 py-1 text-[12px] font-medium text-brass"
          title="The invoices/bills and journals add up to the figure shown, but Zoho's own ledger balance for these contacts is different. Hover the flag on a row for both figures."
        >
          ⚑ {flagged} to review
        </span>
      )}
    </div>
  );
}

// Headings: bigger, bold, capitals. Names wrap onto a second line instead of running into the numbers.
const TH = 'sticky top-0 z-20 bg-navy px-4 py-3.5 text-[12px] font-bold uppercase tracking-wider text-white whitespace-nowrap';
const NUM = 'whitespace-nowrap px-4 py-3 text-right text-[14px] tabular';
const NAME = 'min-w-[230px] whitespace-normal break-words px-4 py-3 text-[14px] font-medium leading-snug text-ink';
const FOOT = 'sticky bottom-0 z-20 px-4 py-3.5 text-[14.5px] font-bold uppercase tracking-wide';

function Flag({ ledger, gap }: { ledger: number; gap: number }) {
  return (
    <span className="mr-1.5 cursor-help font-sans text-brass" title={FLAG_NOTE(ledger, gap)}>
      ⚑
    </span>
  );
}

export function ARLedgerTable({ data }: { data: ARSummary; asOf?: string }) {
  return (
    <>
      <SectionHeader title="Debtors Ledger" count={data.customers.length} flagged={data.unreconciledCount} />
      <div className="max-h-[72vh] overflow-auto border-t border-line">
        <table className="w-full min-w-[720px] border-separate border-spacing-0">
          <caption className="sr-only">Debtors ledger, one row per customer</caption>
          <thead>
            <tr className="text-left">
              <th className={`${TH} w-14 pl-6`}>#</th>
              <th className={TH}>Customer</th>
              <th className={`${TH} text-right`}>&lt;180 days</th>
              <th className={`${TH} text-right`}>&gt;180 days</th>
              <th className={`${TH} text-right`}>Credits</th>
              <th className={`${TH} pr-6 text-right`}>Net</th>
            </tr>
          </thead>
          <tbody>
            {data.customers.map((c, i) => (
              <tr key={c.customerId} className="group odd:bg-white even:bg-[#F6F9FD] hover:!bg-ledger/[0.07]">
                <td className="border-b border-line/70 py-3 pl-6 pr-3 align-top text-[12px] tabular text-ink/40">{i + 1}</td>
                <td className={`${NAME} border-b border-line/70`}>{c.customerName}</td>
                <td className={`${NUM} border-b border-line/70 align-top text-ink/85`}>{c.less180 ? formatINR(c.less180) : '—'}</td>
                <td className={`${NUM} border-b border-line/70 align-top text-ink/85`}>{c.more180 ? formatINR(c.more180) : '—'}</td>
                <td className={`${NUM} border-b border-line/70 align-top text-ink/50`}>
                  {c.unappliedCredits ? `(${formatINR(c.unappliedCredits)})` : '—'}
                </td>
                <td className={`${NUM} border-b border-line/70 pr-6 align-top font-semibold text-ledger`}>
                  {c.gap !== 0 && <Flag ledger={c.ledgerTotal ?? 0} gap={c.gap} />}
                  {formatINR(c.netTotal)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="text-ink">
              <td className={`${FOOT} border-t-2 border-navy bg-[#E3F1EC] pl-6`} colSpan={2}>
                Grand Total
              </td>
              <td className={`${FOOT} border-t-2 border-navy bg-[#E3F1EC] text-right tabular`}>{formatINR(data.grandTotal.less180)}</td>
              <td className={`${FOOT} border-t-2 border-navy bg-[#E3F1EC] text-right tabular`}>{formatINR(data.grandTotal.more180)}</td>
              <td className={`${FOOT} border-t-2 border-navy bg-[#E3F1EC] text-right tabular text-ink/60`}>
                {data.grandTotal.unappliedCredits ? `(${formatINR(data.grandTotal.unappliedCredits)})` : '—'}
              </td>
              <td className={`${FOOT} border-t-2 border-navy bg-[#E3F1EC] pr-6 text-right tabular text-ledger`}>{formatINR(data.grandTotal.netTotal)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  );
}

export function APLedgerTable({ data }: { data: APSummary; asOf?: string }) {
  return (
    <>
      <SectionHeader title="Creditors Ledger" count={data.vendors.length} flagged={data.unreconciledCount} />
      <div className="max-h-[72vh] overflow-auto border-t border-line">
        <table className="w-full min-w-[620px] border-separate border-spacing-0">
          <caption className="sr-only">Creditors ledger, one row per vendor</caption>
          <thead>
            <tr className="text-left">
              <th className={`${TH} w-14 pl-6`}>#</th>
              <th className={TH}>Vendor</th>
              <th className={`${TH} text-right`}>Billed</th>
              <th className={`${TH} text-right`}>Credits</th>
              <th className={`${TH} pr-6 text-right`}>Net</th>
            </tr>
          </thead>
          <tbody>
            {data.vendors.map((v, i) => (
              <tr key={v.vendorId} className="group odd:bg-white even:bg-[#FBF7F6] hover:!bg-rust/[0.06]">
                <td className="border-b border-line/70 py-3 pl-6 pr-3 align-top text-[12px] tabular text-ink/40">{i + 1}</td>
                <td className={`${NAME} border-b border-line/70`}>{v.vendorName}</td>
                <td className={`${NUM} border-b border-line/70 align-top text-ink/85`}>{formatINR(v.billedTotal)}</td>
                <td className={`${NUM} border-b border-line/70 align-top text-ink/50`}>
                  {v.unappliedCredits ? `(${formatINR(v.unappliedCredits)})` : '—'}
                </td>
                <td className={`${NUM} border-b border-line/70 pr-6 align-top font-semibold text-rust`}>
                  {v.gap !== 0 && <Flag ledger={v.ledgerTotal ?? 0} gap={v.gap} />}
                  {formatINR(v.netTotal)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="text-ink">
              <td className={`${FOOT} border-t-2 border-navy bg-[#F9E6E3] pl-6`} colSpan={2}>
                Grand Total
              </td>
              <td className={`${FOOT} border-t-2 border-navy bg-[#F9E6E3] text-right tabular`}>{formatINR(data.grandTotal.billedTotal)}</td>
              <td className={`${FOOT} border-t-2 border-navy bg-[#F9E6E3] text-right tabular text-ink/60`}>
                {data.grandTotal.unappliedCredits ? `(${formatINR(data.grandTotal.unappliedCredits)})` : '—'}
              </td>
              <td className={`${FOOT} border-t-2 border-navy bg-[#F9E6E3] pr-6 text-right tabular text-rust`}>{formatINR(data.grandTotal.netTotal)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  );
}

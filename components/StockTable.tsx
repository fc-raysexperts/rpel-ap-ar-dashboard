import { formatINR } from './SummaryStrip';
import { ADJUSTMENT_TEXT, OTHER_LABEL, type StockApiData, type StockLine } from '@/lib/stock-calculator';
import { prettyStockDate } from '@/lib/stock-period';

/** Stock quantities as Zoho holds them: up to three decimals, Indian grouping, a real minus sign. */
export function formatQty(n: number): string {
  if (Math.abs(n) < 0.0005) return '0';
  const s = Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 3 });
  return (n < 0 ? '−' : '') + s;
}

/** Rupees with the paise Zoho keeps (the working panel); the table itself shows whole rupees like the other tabs. */
function formatINR2(n: number): string {
  const sign = n < 0 ? '−' : '';
  return sign + Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Same look as the Debtors / Creditors tables.
const TH = 'sticky top-0 z-20 bg-navy px-4 py-3.5 text-[12px] font-bold uppercase tracking-wider text-white whitespace-nowrap';
const NUM = 'whitespace-nowrap px-4 py-3 text-right align-top text-[14px] tabular';
const NAME = 'min-w-[260px] whitespace-normal break-words px-4 py-3 align-top text-[14px] font-medium leading-snug text-ink';
const FOOT = 'sticky bottom-0 z-20 border-t-2 border-navy bg-[#E4ECFB] px-4 py-3.5 text-[14.5px] font-bold uppercase tracking-wide text-ink';

const neg = (n: number, base = 'text-ink/85') => (n < -0.0005 ? 'text-rust' : base);

function Cells({ l, strong = false }: { l: Pick<StockLine, 'opening' | 'qtyIn' | 'qtyOut' | 'closing' | 'closingValue'>; strong?: boolean }) {
  const cell = 'border-b border-line/70';
  return (
    <>
      <td className={`${NUM} ${cell} ${neg(l.opening)}`}>{formatQty(l.opening)}</td>
      <td className={`${NUM} ${cell} ${neg(l.qtyIn)}`}>{formatQty(l.qtyIn)}</td>
      <td className={`${NUM} ${cell} ${neg(l.qtyOut)}`}>{formatQty(l.qtyOut)}</td>
      <td className={`${NUM} ${cell} ${neg(l.closing, 'text-ink')} font-semibold`}>{formatQty(l.closing)}</td>
      <td className={`${NUM} ${cell} pr-6 ${neg(l.closingValue, strong ? 'text-accent' : 'text-ink')} font-semibold`}>{formatINR(l.closingValue)}</td>
    </>
  );
}

export function StockTable({ data }: { data: StockApiData }) {
  const { lines, other, total, zoho } = data;
  const diffs: { label: string; ours: number; theirs: number; money?: boolean }[] = [
    { label: 'Opening Stock', ours: total.opening, theirs: zoho.opening },
    { label: 'Quantity In', ours: total.qtyIn, theirs: zoho.qtyIn },
    { label: 'Quantity Out', ours: total.qtyOut, theirs: zoho.qtyOut },
    { label: 'Closing Stock', ours: total.closing, theirs: zoho.closing },
    { label: 'Closing Stock Amount (Rs.)', ours: total.closingValue, theirs: zoho.closingValue, money: true },
  ];
  const shownAdjustments = data.adjustments.slice(0, 100);

  return (
    <>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-6 pb-4 pt-5">
        <h2 className="font-display text-[20px] font-bold text-navy">Stock Statement</h2>
        <span className="text-[14px] font-medium text-ink/55">
          ({lines.length} {lines.length === 1 ? 'item' : 'items'} listed, the rest in the last line)
        </span>
        <span className="ml-auto text-[12.5px] text-ink/55">
          {prettyStockDate(data.from)} to {prettyStockDate(data.to)}
        </span>
      </div>

      <div className="max-h-[72vh] overflow-auto border-t border-line">
        <table className="w-full min-w-[860px] border-separate border-spacing-0">
          <caption className="sr-only">Stock statement, one row per item, then the last line for smaller items, then the grand total</caption>
          <thead>
            <tr className="text-left">
              <th className={`${TH} pl-6`}>Item Name</th>
              <th className={TH}>Unit</th>
              <th className={`${TH} text-right`}>Opening Stock</th>
              <th className={`${TH} text-right`}>Quantity In</th>
              <th className={`${TH} text-right`}>Quantity Out</th>
              <th className={`${TH} text-right`}>Closing Stock</th>
              <th className={`${TH} pr-6 text-right`}>Closing Stock Amount</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.key} className="group odd:bg-white even:bg-[#F6F9FD] hover:!bg-accent/[0.07]">
                <td className={`${NAME} border-b border-line/70 pl-6`}>{l.name}</td>
                <td className="whitespace-nowrap border-b border-line/70 px-4 py-3 align-top text-[14px] leading-snug text-ink/60">{l.unit || '—'}</td>
                <Cells l={l} />
              </tr>
            ))}
            {lines.length === 0 && (
              <tr>
                <td colSpan={7} className="px-6 py-8 text-center text-[14px] text-ink/55">
                  No item is listed separately for this period. Everything is in the last line.
                </td>
              </tr>
            )}
            <tr className="bg-brass/[0.09]">
              <td className={`${NAME} border-b border-t border-line pl-6 font-semibold`}>
                {OTHER_LABEL}
                <span className="mt-0.5 block text-[12px] font-normal text-ink/55">
                  {other.itemCount} {other.itemCount === 1 ? 'item' : 'items'}
                  {other.negativeCount > 0 ? `, ${other.negativeCount} with negative stock` : ''}
                </span>
              </td>
              <td className="border-b border-t border-line px-4 py-3 align-top text-[14px] leading-snug text-ink/60">—</td>
              <Cells l={other} />
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <td className={`${FOOT} pl-6`} colSpan={2}>
                Grand Total
              </td>
              <td className={`${FOOT} text-right tabular ${neg(total.opening, 'text-ink')}`}>{formatQty(total.opening)}</td>
              <td className={`${FOOT} text-right tabular`}>{formatQty(total.qtyIn)}</td>
              <td className={`${FOOT} text-right tabular`}>{formatQty(total.qtyOut)}</td>
              <td className={`${FOOT} text-right tabular ${neg(total.closing, 'text-ink')}`}>{formatQty(total.closing)}</td>
              <td className={`${FOOT} pr-6 text-right tabular ${neg(total.closingValue, 'text-accent')}`}>{formatINR(total.closingValue)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="space-y-3 border-t border-line px-6 py-5 text-[13px] leading-relaxed text-ink/70">
        <p>
          <b className="font-semibold text-ink/85">Which items are listed.</b> An item gets its own line when its Closing Stock Amount went above Rs 5,00,000 at any
          month-end of {data.fy} (or today). That list ({data.listCount} items this year) is worked out again every morning from Zoho&rsquo;s figures, stays the same whichever period you pick, and starts afresh next
          April; an item on it with no closing stock and no closing amount in the period is not shown on its own. Everything else, and any item whose opening or closing stock is negative, is added into the last line
          {other.itemCount > 0 ? (
            <>
              : {other.itemCount} {other.itemCount === 1 ? 'item' : 'items'} this time
              {other.negativeCount > 0 ? `, of which ${other.negativeCount} ${other.negativeCount === 1 ? 'has' : 'have'} negative stock` : ''}.
            </>
          ) : (
            '.'
          )}
        </p>

        <details className="group rounded-xl border border-line bg-paper/60 open:bg-white">
          <summary className="flex cursor-pointer select-none items-center gap-2 px-4 py-3 font-display text-[14px] font-bold text-navy">
            <span className="inline-block transition group-open:rotate-90" aria-hidden="true">
              ▸
            </span>
            How the totals were worked out
            <span
              className={`ml-auto rounded-full px-3 py-1 text-[11.5px] font-semibold ${
                data.quantitiesTie ? 'bg-ledger/10 text-ledger' : 'bg-rust/10 text-rust'
              }`}
            >
              {data.quantitiesTie ? 'Quantities match Zoho' : 'Quantities differ from Zoho'}
            </span>
          </summary>

          <div className="space-y-5 border-t border-line px-4 py-4">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] border-separate border-spacing-0 text-[13px]">
                <thead>
                  <tr className="text-left text-ink/55">
                    <th className="px-3 py-2 font-semibold">Grand Total</th>
                    <th className="px-3 py-2 text-right font-semibold">This statement</th>
                    <th className="px-3 py-2 text-right font-semibold">Zoho&rsquo;s report</th>
                    <th className="px-3 py-2 text-right font-semibold">Difference</th>
                  </tr>
                </thead>
                <tbody>
                  {diffs.map((d) => {
                    const diff = Math.round((d.ours - d.theirs) * 1000) / 1000;
                    const same = Math.abs(diff) < 0.005;
                    const fmt = d.money ? formatINR2 : formatQty;
                    return (
                      <tr key={d.label} className="border-t border-line/70">
                        <td className="border-t border-line/70 px-3 py-2 font-medium text-ink/85">{d.label}</td>
                        <td className="border-t border-line/70 px-3 py-2 text-right tabular">{fmt(d.ours)}</td>
                        <td className="border-t border-line/70 px-3 py-2 text-right tabular">{fmt(d.theirs)}</td>
                        <td className={`border-t border-line/70 px-3 py-2 text-right tabular ${same ? 'text-ledger' : 'font-semibold text-brass'}`}>
                          {same ? 'same' : fmt(diff)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <p>
              Every quantity is Zoho&rsquo;s own, simply added up, so Opening, In, Out and Closing Stock agree with Zoho&rsquo;s report to the last decimal. The two SKUs of one item
              (old and &ldquo;_New&rdquo;) are clubbed into one line by adding their stock. Only the <b className="font-semibold text-ink/85">Closing Stock Amount</b> can differ. It is Zoho&rsquo;s own too, SKU by SKU (an amount that Zoho still shows on nil stock is shown here as well), with
              one change: a SKU with negative stock has the modulus of its amount subtracted, so a positive Zoho amount on negative stock is subtracted and a negative one is counted as it is.
              An item left with negative stock goes into the last line, where its amount is likewise subtracted, so it lowers the Grand Total.
            </p>

            {data.adjustments.length === 0 ? (
              <p className="font-medium text-ledger">No item needed an adjustment in this period.</p>
            ) : (
              <div>
                <p className="mb-2 font-semibold text-ink/85">
                  {data.adjustments.length} {data.adjustments.length === 1 ? 'item' : 'items'} whose amount differs from Zoho&rsquo;s
                  {data.adjustments.length > shownAdjustments.length ? ` (largest ${shownAdjustments.length} shown, all of them are in the Excel download)` : ''}
                </p>
                <div className="max-h-80 overflow-auto rounded-lg border border-line">
                  <table className="w-full min-w-[820px] border-separate border-spacing-0 text-[12.5px]">
                    <thead>
                      <tr className="text-left">
                        {['Item', 'Closing stock', 'Zoho amount', 'Amount used', 'Where', 'Why'].map((h, i) => (
                          <th
                            key={h}
                            className={`sticky top-0 bg-paper px-3 py-2 font-semibold text-ink/60 ${i >= 1 && i <= 3 ? 'text-right' : ''}`}
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {shownAdjustments.map((a) => (
                        <tr key={a.key} className="align-top">
                          <td className="border-t border-line/70 px-3 py-2 font-medium text-ink/85">{a.name}</td>
                          <td className={`border-t border-line/70 px-3 py-2 text-right tabular ${neg(a.closing)}`}>{formatQty(a.closing)}</td>
                          <td className={`border-t border-line/70 px-3 py-2 text-right tabular ${neg(a.zohoValue)}`}>{formatINR2(a.zohoValue)}</td>
                          <td className={`border-t border-line/70 px-3 py-2 text-right tabular ${neg(a.usedValue)}`}>{formatINR2(a.usedValue)}</td>
                          <td className="whitespace-nowrap border-t border-line/70 px-3 py-2 text-ink/70">{a.inOtherLine ? 'Last line' : 'Own line'}</td>
                          <td className="border-t border-line/70 px-3 py-2 text-ink/70">{ADJUSTMENT_TEXT[a.reason]}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </details>
      </div>
    </>
  );
}

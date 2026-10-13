import type { ReactNode } from 'react';
import { formatINR } from './SummaryStrip';
import { formatQty } from './StockTable';
import type { StockApiData } from '@/lib/stock-calculator';
import { prettyStockDate } from '@/lib/stock-period';

type Tone = 'accent' | 'ledger' | 'brass';

const TONES: Record<Tone, { bar: string; chip: string; text: string }> = {
  accent: { bar: 'bg-accent', chip: 'bg-accent/10 text-accent', text: 'text-accent' },
  ledger: { bar: 'bg-ledger', chip: 'bg-ledger/10 text-ledger', text: 'text-ledger' },
  brass: { bar: 'bg-brass', chip: 'bg-brass/10 text-brass', text: 'text-brass' },
};

// Same card as the Debtors / Creditors strip.
function Card({
  tone,
  icon,
  title,
  note,
  value,
  rupee = true,
  loading,
  children,
}: {
  tone: Tone;
  icon: ReactNode;
  title: string;
  note?: string;
  value: string;
  rupee?: boolean;
  loading?: boolean;
  children?: ReactNode;
}) {
  const t = TONES[tone];
  return (
    <div className="relative overflow-hidden rounded-2xl border border-line bg-white p-6 shadow-card">
      <span className={`absolute inset-y-0 left-0 w-1.5 ${t.bar}`} aria-hidden="true" />
      <div className="flex items-center gap-3">
        <span className={`flex h-10 w-10 items-center justify-center rounded-xl ${t.chip}`}>{icon}</span>
        <div className="leading-tight">
          <p className="font-display text-[15px] font-bold text-navy">{title}</p>
          {note && <p className="mt-0.5 text-[12px] text-ink/55">{note}</p>}
        </div>
      </div>
      <p className={`mt-5 font-display text-[2.15rem] font-extrabold leading-none tracking-tight tabular ${t.text}`}>
        {loading ? (
          <span className="inline-block h-9 w-44 animate-pulse rounded-lg bg-line/70 align-middle" />
        ) : (
          <>
            {rupee && <span className="mr-1 text-[0.62em] font-bold opacity-60">₹</span>}
            {value}
          </>
        )}
      </p>
      {!loading && children}
    </div>
  );
}

const iconProps = { width: 20, height: 20, viewBox: '0 0 20 20', fill: 'none', 'aria-hidden': true } as const;

export function StockSummary({ data, loading }: { data: StockApiData | null; loading?: boolean }) {
  const asAt = data ? `As at ${prettyStockDate(data.to)}` : undefined;
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
      <Card
        tone="ledger"
        title="Items listed"
        note="Each on its own line"
        value={String(data?.lines.length ?? 0)}
        rupee={false}
        loading={loading}
        icon={
          <svg {...iconProps}>
            <path d="M6 5h10M6 10h10M6 15h10M3 5h.01M3 10h.01M3 15h.01" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        }
      >
        <p className="mt-5 text-[12px] tabular text-ink/60">
          {data ? (
            <>
              Last line: {data.other.itemCount} {data.other.itemCount === 1 ? 'item' : 'items'}, <b className="font-semibold text-ink/85">₹{formatINR(data.other.closingValue)}</b>
            </>
          ) : null}
        </p>
      </Card>

      <Card
        tone="brass"
        title="Closing Stock"
        note={asAt ?? 'Closing Stock'}
        value={formatQty(data?.total.closing ?? 0)}
        rupee={false}
        loading={loading}
        icon={
          <svg {...iconProps}>
            <path d="M3 7l7-4 7 4v7l-7 4-7-4V7zm0 0l7 4m0 0l7-4m-7 4v7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        }
      >
        <p className="mt-5 text-[12px] text-ink/60">Grand Total of the Closing Stock column</p>
      </Card>

      <Card
        tone="accent"
        title="Closing Stock Amount"
        note={asAt ?? 'Closing Stock Amount'}
        value={formatINR(data?.total.closingValue ?? 0)}
        loading={loading}
        icon={
          <svg {...iconProps}>
            <path d="M4 4h12v12H4V4zm0 4h12M8 8v8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        }
      >
        <p className="mt-5 text-[12px] text-ink/60">Grand Total of the Closing Stock Amount column</p>
      </Card>
    </div>
  );
}

import type { ReactNode } from 'react';

function formatINR(n: number): string {
  const neg = n < 0;
  const abs = Math.round(Math.abs(n));
  const s = String(abs);
  let grouped: string;
  if (s.length <= 3) {
    grouped = s;
  } else {
    const last3 = s.slice(-3);
    let rest = s.slice(0, -3);
    const parts: string[] = [];
    while (rest.length > 2) {
      parts.unshift(rest.slice(-2));
      rest = rest.slice(0, -2);
    }
    if (rest) parts.unshift(rest);
    grouped = parts.join(',') + ',' + last3;
  }
  return (neg ? '−' : '') + grouped;
}

interface SummaryStripProps {
  arNet: number;
  arLess180: number;
  arMore180: number;
  arCount: number;
  apNet: number;
  apCount: number;
  loading?: boolean;
}

type Tone = 'ledger' | 'rust' | 'accent';

const TONES: Record<Tone, { bar: string; chip: string; text: string }> = {
  ledger: { bar: 'bg-ledger', chip: 'bg-ledger/10 text-ledger', text: 'text-ledger' },
  rust: { bar: 'bg-rust', chip: 'bg-rust/10 text-rust', text: 'text-rust' },
  accent: { bar: 'bg-accent', chip: 'bg-accent/10 text-accent', text: 'text-accent' },
};

function Card({
  tone,
  icon,
  title,
  note,
  value,
  loading,
  children,
}: {
  tone: Tone;
  icon: ReactNode;
  title: string;
  note?: string;
  value: string;
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
            <span className="mr-1 text-[0.62em] font-bold opacity-60">₹</span>
            {value}
          </>
        )}
      </p>
      {!loading && children}
    </div>
  );
}

const iconProps = { width: 20, height: 20, viewBox: '0 0 20 20', fill: 'none', 'aria-hidden': true } as const;

export function SummaryStrip({ arNet, arLess180, arMore180, arCount, apNet, apCount, loading }: SummaryStripProps) {
  const net = arNet - apNet;
  const aged = arLess180 + arMore180;
  const youngShare = aged > 0 ? Math.max(0, Math.min(100, (arLess180 / aged) * 100)) : 100;
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
      <Card
        tone="ledger"
        title="Debtors"
        note={`${arCount} ${arCount === 1 ? 'account' : 'accounts'}`}
        value={formatINR(arNet)}
        loading={loading}
        icon={
          <svg {...iconProps}>
            <path d="M15 5L5 15M5 8v7h7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        }
      >
        <div className="mt-5" title="Share of the debtors balance that is within 180 days, and past 180 days">
          <div className="flex h-2 overflow-hidden rounded-full bg-brass/70">
            <div className="h-full bg-ledger" style={{ width: `${youngShare}%` }} />
          </div>
          <div className="mt-2.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[12px] tabular text-ink/60">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-ledger" />
              &lt;180d <b className="font-semibold text-ink/85">₹{formatINR(arLess180)}</b>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-brass/70" />
              &gt;180d <b className="font-semibold text-ink/85">₹{formatINR(arMore180)}</b>
            </span>
          </div>
        </div>
      </Card>

      <Card
        tone="rust"
        title="Creditors"
        note={`${apCount} ${apCount === 1 ? 'account' : 'accounts'}`}
        value={formatINR(apNet)}
        loading={loading}
        icon={
          <svg {...iconProps}>
            <path d="M5 15L15 5M8 5h7v7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        }
      >
        <p className="mt-5 text-[12px] text-ink/60">Net of vendor credits</p>
      </Card>

      <Card
        tone="accent"
        title="Net position"
        note="Debtors less creditors"
        value={formatINR(Math.abs(net))}
        loading={loading}
        icon={
          <svg {...iconProps}>
            <path d="M10 3v14M5 17h10M4 6h12M4 6l-2 5a2.5 2.5 0 005 0L4 6zm12 0l-2 5a2.5 2.5 0 005 0l-3-5z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        }
      >
        <p className="mt-5 text-[12px] text-ink/60">{net >= 0 ? 'Debtors exceed creditors' : 'Creditors exceed debtors'}</p>
      </Card>
    </div>
  );
}

export { formatINR };

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

export function SummaryStrip({
  arNet,
  arLess180,
  arMore180,
  arCount,
  apNet,
  apCount,
  loading,
}: SummaryStripProps) {
  const net = arNet - apNet;
  return (
    <div className="grid grid-cols-1 divide-y divide-line border border-line bg-white sm:grid-cols-3 sm:divide-x sm:divide-y-0">
      <div className="px-7 py-7 sm:px-8 sm:py-9">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-ledger" />
          <p className="text-[11px] font-semibold uppercase tracking-wider text-ink/50">
            Debtors · {arCount} {arCount === 1 ? 'account' : 'accounts'}
          </p>
        </div>
        <p className="mt-3 font-serif text-[2.6rem] leading-none font-semibold text-ledger tabular">
          {loading ? '—' : `₹${formatINR(arNet)}`}
        </p>
        {!loading && (
          <p className="mt-4 font-mono text-xs text-ink/55">
            &lt;180d&nbsp;
            <span className="text-ink/75">₹{formatINR(arLess180)}</span>
            <span className="mx-2 text-ink/25">/</span>
            &gt;180d&nbsp;
            <span className="text-ink/75">₹{formatINR(arMore180)}</span>
          </p>
        )}
      </div>

      <div className="px-7 py-7 sm:px-8 sm:py-9">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-rust" />
          <p className="text-[11px] font-semibold uppercase tracking-wider text-ink/50">
            Creditors · {apCount} {apCount === 1 ? 'account' : 'accounts'}
          </p>
        </div>
        <p className="mt-3 font-serif text-[2.6rem] leading-none font-semibold text-rust tabular">
          {loading ? '—' : `₹${formatINR(apNet)}`}
        </p>
        {!loading && <p className="mt-4 font-mono text-xs text-ink/55">Net of vendor credits</p>}
      </div>

      <div className="px-7 py-7 sm:px-8 sm:py-9">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-brass" />
          <p className="text-[11px] font-semibold uppercase tracking-wider text-ink/50">
            Net position
          </p>
        </div>
        <p className="mt-3 font-serif text-[2.6rem] leading-none font-semibold text-ink tabular">
          {loading ? '—' : `₹${formatINR(Math.abs(net))}`}
        </p>
        {!loading && (
          <p className="mt-4 font-mono text-xs text-ink/55">
            {net >= 0 ? 'Debtors exceed creditors' : 'Creditors exceed debtors'}
          </p>
        )}
      </div>
    </div>
  );
}

export { formatINR };

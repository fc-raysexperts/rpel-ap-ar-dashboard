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
  apNet: number;
  loading?: boolean;
}

export function SummaryStrip({ arNet, arLess180, arMore180, apNet, loading }: SummaryStripProps) {
  return (
    <div className="grid grid-cols-1 gap-px bg-line sm:grid-cols-2">
      <div className="bg-paper px-6 py-8 sm:px-10 sm:py-10">
        <p className="text-sm uppercase tracking-wide text-ink/50">Debtors</p>
        <p className="mt-2 font-serif text-4xl font-semibold text-ledger tabular sm:text-5xl">
          {loading ? '—' : `₹ ${formatINR(arNet)}`}
        </p>
        {!loading && (
          <p className="mt-3 font-mono text-sm text-ink/60">
            &lt;180d ₹{formatINR(arLess180)} &nbsp;·&nbsp; &gt;180d ₹{formatINR(arMore180)}
          </p>
        )}
      </div>
      <div className="bg-paper px-6 py-8 sm:px-10 sm:py-10">
        <p className="text-sm uppercase tracking-wide text-ink/50">Creditors</p>
        <p className="mt-2 font-serif text-4xl font-semibold text-rust tabular sm:text-5xl">
          {loading ? '—' : `₹ ${formatINR(apNet)}`}
        </p>
        {!loading && <p className="mt-3 font-mono text-sm text-ink/60">Billed, net of vendor credits</p>}
      </div>
    </div>
  );
}

export { formatINR };

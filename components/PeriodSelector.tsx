'use client';

interface PeriodSelectorProps {
  since: string;
  onChange: (since: string) => void;
}

const PRESETS = [
  { label: 'FY26 → now', value: '2025-04-01' },
  { label: 'FY27 → now', value: '2026-04-01' },
  { label: 'This quarter', value: quarterStart() },
];

function quarterStart(): string {
  const now = new Date();
  const q = Math.floor(now.getMonth() / 3);
  const d = new Date(now.getFullYear(), q * 3, 1);
  return d.toISOString().slice(0, 10);
}

export function PeriodSelector({ since, onChange }: PeriodSelectorProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {PRESETS.map((p) => (
        <button
          key={p.value}
          onClick={() => onChange(p.value)}
          className={`border px-3 py-1.5 text-xs font-medium transition ${
            since === p.value
              ? 'border-ledger bg-ledger text-paper'
              : 'border-ink/20 text-ink/70 hover:border-ledger hover:text-ledger'
          }`}
        >
          {p.label}
        </button>
      ))}
      <input
        type="date"
        value={since}
        onChange={(e) => onChange(e.target.value)}
        className="border border-ink/20 bg-paper px-3 py-1.5 text-xs text-ink/70 focus:border-ledger focus:outline-none"
      />
    </div>
  );
}

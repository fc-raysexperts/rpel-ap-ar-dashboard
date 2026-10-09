'use client';

import { useState } from 'react';

// India FY: April-March.
function fyEnd(fyStartYear: number): Date {
  return new Date(fyStartYear + 1, 2, 31); // March 31
}
function fyLabel(fyStartYear: number): string {
  return `FY${String(fyStartYear + 1).slice(-2)}`;
}

function todayISO(): string {
  return toISO(new Date());
}
function toISO(d: Date): string {
  // Deliberately NOT using d.toISOString() here -- that converts to UTC
  // first, which silently shifts the date back a day for any local
  // timezone ahead of UTC (e.g. IST, UTC+5:30) whenever the local time is
  // past midnight but before the UTC rollover. Reading the local
  // year/month/day components directly avoids that entirely.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function buildYearlyOptions(): { label: string; value: string }[] {
  const today = new Date();
  const currentFYStart = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;
  const opts: { label: string; value: string }[] = [];
  for (let i = 0; i < 4; i++) {
    const fyStart = currentFYStart - i;
    const end = fyEnd(fyStart);
    const isCurrent = i === 0;
    opts.push({
      label: isCurrent ? `${fyLabel(fyStart)} (to date)` : fyLabel(fyStart),
      value: isCurrent ? todayISO() : toISO(end),
    });
  }
  return opts;
}

function buildQuarterlyOptions(): { label: string; value: string }[] {
  const today = new Date();
  const opts: { label: string; value: string }[] = [];
  // Walk backward through calendar-quarter-end months, mapping each to its
  // India-FY quarter number/year (FY = Apr-Mar, so Jun/Sep/Dec/Mar are the
  // FY quarter-end months, Q1..Q4 respectively).
  const calQ = Math.floor(today.getMonth() / 3);
  let cursorEnd = new Date(today.getFullYear(), calQ * 3 + 2 + 1, 0);

  for (let i = 0; i < 8; i++) {
    const isCurrent = i === 0;
    const m = cursorEnd.getMonth();
    const y = cursorEnd.getFullYear();
    let fyQuarterNum: number;
    let fyYearEnd: number;
    if (m === 2) { fyQuarterNum = 4; fyYearEnd = y; }
    else if (m === 5) { fyQuarterNum = 1; fyYearEnd = y + 1; }
    else if (m === 8) { fyQuarterNum = 2; fyYearEnd = y + 1; }
    else { fyQuarterNum = 3; fyYearEnd = y + 1; }

    const label = `Q${fyQuarterNum} FY${String(fyYearEnd).slice(-2)}`;
    opts.push({
      label: isCurrent ? `${label} (to date)` : label,
      value: isCurrent ? todayISO() : toISO(cursorEnd),
    });
    cursorEnd = new Date(cursorEnd.getFullYear(), cursorEnd.getMonth() - 3 + 1, 0);
  }
  return opts;
}

function buildMonthlyOptions(): { label: string; value: string }[] {
  const today = new Date();
  const opts: { label: string; value: string }[] = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const monthEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    const isCurrent = i === 0;
    const label = d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
    opts.push({
      label: isCurrent ? `${label} (to date)` : label,
      value: isCurrent ? todayISO() : toISO(monthEnd),
    });
  }
  return opts;
}

type Category = 'total' | 'yearly' | 'quarterly' | 'monthly' | 'custom';

interface PeriodSelectorProps {
  asOf: string;
  onChange: (asOf: string) => void;
}

export function PeriodSelector({ asOf, onChange }: PeriodSelectorProps) {
  const [category, setCategory] = useState<Category>('total');

  const yearlyOptions = buildYearlyOptions();
  const quarterlyOptions = buildQuarterlyOptions();
  const monthlyOptions = buildMonthlyOptions();

  function selectCategory(c: Category) {
    setCategory(c);
    if (c === 'total') onChange(todayISO());
    else if (c === 'yearly') onChange(yearlyOptions[0].value);
    else if (c === 'quarterly') onChange(quarterlyOptions[0].value);
    else if (c === 'monthly') onChange(monthlyOptions[0].value);
    // 'custom' leaves asOf as-is until the date input is used
  }

  const categories: { key: Category; label: string }[] = [
    { key: 'total', label: 'Total till date' },
    { key: 'yearly', label: 'Yearly' },
    { key: 'quarterly', label: 'Quarterly' },
    { key: 'monthly', label: 'Monthly' },
    { key: 'custom', label: 'Custom' },
  ];

  const secondaryOptions =
    category === 'yearly' ? yearlyOptions : category === 'quarterly' ? quarterlyOptions : category === 'monthly' ? monthlyOptions : null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex flex-wrap border border-ink/15 bg-white p-0.5">
        {categories.map((c) => (
          <button
            key={c.key}
            onClick={() => selectCategory(c.key)}
            className={`px-3.5 py-1.5 text-xs font-medium transition ${
              category === c.key
                ? 'bg-ledger text-paper'
                : 'text-ink/65 hover:bg-ledger/[0.08] hover:text-ledger'
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>

      {secondaryOptions && (
        <select
          value={asOf}
          onChange={(e) => onChange(e.target.value)}
          className="border border-ink/15 bg-white px-3 py-[7px] text-xs text-ink focus:border-ledger focus:outline-none"
        >
          {secondaryOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}

      {category === 'custom' && (
        <input
          type="date"
          value={asOf}
          max={todayISO()}
          onChange={(e) => onChange(e.target.value)}
          className="border border-brass/50 bg-white px-3 py-[7px] text-xs text-ink focus:border-ledger focus:outline-none"
        />
      )}
    </div>
  );
}

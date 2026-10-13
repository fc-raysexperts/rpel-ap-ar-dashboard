'use client';

import { useEffect, useState } from 'react';
import { isISODate } from '@/lib/period';
import {
  STOCK_FIRST_DATE,
  fyStartISO,
  fyStartYearOf,
  prettyStockDate,
  stockMonthOptions,
  stockQuarterOptions,
  stockYearOptions,
  type StockPeriod,
} from '@/lib/stock-period';

// On the Stock Statement tab a period is exactly its own dates: "September 2026" is 1 Sep to 30 Sep, a quarter is its
// three months, a year is its twelve, and Custom is whatever From and To are picked. Nothing before 1 Apr 2026 is offered.

function toISO(d: Date): string {
  // local year/month/day, not toISOString(): that goes through UTC and shifts the date for a timezone ahead of it (IST)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

type Category = 'yearly' | 'quarterly' | 'monthly' | 'custom';

/**
 * One date box. It keeps what the person is typing in a draft and only passes a date on when it is a whole, valid
 * date inside [min, max] (typing a year goes through 0002, 0020, 0202 on the way to 2026). A date outside the limits
 * is refused when the box is left, and the box goes back to the last good date.
 */
function DateField({
  label,
  value,
  min,
  max,
  onCommit,
  onRefuse,
}: {
  label: string;
  value: string;
  min: string;
  max: string;
  onCommit: (v: string) => void;
  onRefuse: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11.5px] font-semibold tracking-wide text-ink/55">{label}</span>
      <input
        type="date"
        value={draft}
        min={min}
        max={max}
        onChange={(e) => {
          const v = e.target.value;
          setDraft(v);
          if (isISODate(v) && v >= min && v <= max) onCommit(v);
        }}
        onBlur={() => {
          if (draft === value) return;
          if (isISODate(draft)) onRefuse(draft);
          setDraft(value);
        }}
        className="rounded-xl border border-accent/50 bg-white px-3 py-2 text-[13px] text-ink shadow-sm focus:border-accent focus:outline-none"
      />
    </label>
  );
}

export function StockPeriodSelector({ from, to, onChange }: { from: string; to: string; onChange: (from: string, to: string) => void }) {
  const [category, setCategory] = useState<Category>('yearly');
  const [note, setNote] = useState('');

  const today = toISO(new Date());
  const options: Record<Exclude<Category, 'custom'>, StockPeriod[]> = {
    yearly: stockYearOptions(today),
    quarterly: stockQuarterOptions(today),
    monthly: stockMonthOptions(today),
  };

  function selectCategory(c: Category) {
    setCategory(c);
    setNote('');
    if (c !== 'custom') onChange(options[c][0].from, options[c][0].to);
  }

  const categories: { key: Category; label: string }[] = [
    { key: 'yearly', label: 'Yearly' },
    { key: 'quarterly', label: 'Quarterly' },
    { key: 'monthly', label: 'Monthly' },
    { key: 'custom', label: 'Custom' },
  ];

  const list = category === 'custom' ? null : options[category];

  // --- custom range: both dates always inside [1 Apr 2026, today], From never after To
  const commitRange = (f: string, t: string, message = '') => {
    setNote(message);
    onChange(f, t);
  };
  const setFrom = (v: string) => (v > to ? commitRange(v, v, 'The To date was moved up to match your From date.') : commitRange(v, to));
  const setTo = (v: string) => (v < from ? commitRange(v, v, 'The From date was moved back to match your To date.') : commitRange(from, v));
  const refuse = (v: string) =>
    setNote(
      v < STOCK_FIRST_DATE
        ? `This tab starts on ${prettyStockDate(STOCK_FIRST_DATE)} (the start of FY27), so there is nothing earlier to show. Pick ${prettyStockDate(STOCK_FIRST_DATE)} or later.`
        : 'That date has not happened yet. Pick today or an earlier date.'
    );

  const atLeastFirst = (d: string) => (d < STOCK_FIRST_DATE ? STOCK_FIRST_DATE : d);
  const thisMonth = atLeastFirst(`${today.slice(0, 8)}01`);
  const last30 = (() => {
    const d = new Date();
    d.setDate(d.getDate() - 29);
    return atLeastFirst(toISO(d));
  })();
  const thisFY = atLeastFirst(fyStartISO(fyStartYearOf(today)));
  const chips: { label: string; f: string }[] = [
    { label: 'This month', f: thisMonth },
    { label: 'Last 30 days', f: last30 },
    { label: 'This FY so far', f: thisFY },
  ];

  return (
    <div className="flex flex-col gap-3 lg:items-end">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-0.5 rounded-xl border border-line bg-white p-1 shadow-sm">
          {categories.map((c) => (
            <button
              key={c.key}
              onClick={() => selectCategory(c.key)}
              className={`rounded-lg px-3.5 py-2 text-[13px] font-medium transition ${
                category === c.key ? 'bg-navy text-white shadow-sm' : 'text-ink/65 hover:bg-navy/[0.07] hover:text-navy'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>

        {list && (
          <select
            aria-label="Period"
            value={`${from}|${to}`}
            onChange={(e) => {
              const [f, t] = e.target.value.split('|');
              onChange(f, t);
            }}
            className="rounded-xl border border-line bg-white px-3 py-2.5 text-[13px] font-medium text-ink shadow-sm focus:border-accent focus:outline-none"
          >
            {list.map((o) => (
              <option key={`${o.from}|${o.to}`} value={`${o.from}|${o.to}`}>
                {o.label}
              </option>
            ))}
          </select>
        )}
      </div>

      {category === 'custom' && (
        <div className="rounded-2xl border border-line bg-white p-3.5 shadow-sm lg:w-[27rem]">
          <div className="flex flex-wrap items-end gap-3">
            <DateField label="From" value={from} min={STOCK_FIRST_DATE} max={today} onCommit={setFrom} onRefuse={refuse} />
            <DateField label="To" value={to} min={STOCK_FIRST_DATE} max={today} onCommit={setTo} onRefuse={refuse} />
            <div className="flex flex-wrap gap-1.5 pb-0.5">
              {chips.map((c) => (
                <button
                  key={c.label}
                  type="button"
                  onClick={() => commitRange(c.f, today)}
                  className="rounded-full border border-line bg-paper px-3 py-1.5 text-[12px] font-medium text-ink/70 transition hover:border-accent/60 hover:text-navy"
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>
          <p className="mt-2.5 text-[12px] leading-snug text-ink/55" aria-live="polite">
            {note ? (
              <span className="font-medium text-brass">{note}</span>
            ) : (
              <>
                Runs from {prettyStockDate(STOCK_FIRST_DATE)} to today. Opening stock is as at the start of From; closing stock is as at the end of To.
              </>
            )}
          </p>
        </div>
      )}
    </div>
  );
}

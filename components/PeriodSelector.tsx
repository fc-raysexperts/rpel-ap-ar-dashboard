'use client';

import { useEffect, useState } from 'react';
import { ZB_EARLIEST_DATE, isISODate } from '@/lib/period';

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
function prettyDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

type Option = { label: string; value: string };

// The presets stop where the Zoho Books data stops: a period that ended before the books began has nothing to show.
function buildYearlyOptions(): Option[] {
  const today = new Date();
  const currentFYStart = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;
  const opts: Option[] = [];
  for (let i = 0; i < 10; i++) {
    const fyStart = currentFYStart - i;
    const end = fyEnd(fyStart);
    if (i > 0 && toISO(end) < ZB_EARLIEST_DATE) break;
    const isCurrent = i === 0;
    opts.push({
      label: isCurrent ? `${fyLabel(fyStart)} (to date)` : fyLabel(fyStart),
      value: isCurrent ? todayISO() : toISO(end),
    });
  }
  return opts;
}

function buildQuarterlyOptions(): Option[] {
  const today = new Date();
  const opts: Option[] = [];
  // Walk backward through calendar-quarter-end months, mapping each to its
  // India-FY quarter number/year (FY = Apr-Mar, so Jun/Sep/Dec/Mar are the
  // FY quarter-end months, Q1..Q4 respectively).
  const calQ = Math.floor(today.getMonth() / 3);
  let cursorEnd = new Date(today.getFullYear(), calQ * 3 + 2 + 1, 0);

  for (let i = 0; i < 40; i++) {
    const isCurrent = i === 0;
    if (!isCurrent && toISO(cursorEnd) < ZB_EARLIEST_DATE) break;
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

function buildMonthlyOptions(): Option[] {
  const today = new Date();
  const opts: Option[] = [];
  for (let i = 0; i < 120; i++) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const monthEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    if (i > 0 && toISO(monthEnd) < ZB_EARLIEST_DATE) break;
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
  /** the "to" date (balances up to and including this day) */
  asOf: string;
  /** the "from" date of a custom range, or null when the view simply runs from the start of the books */
  from: string | null;
  onChange: (asOf: string, from: string | null) => void;
}

/**
 * One date box. It keeps what the person is typing in a draft and only passes a date on when it is a whole, valid
 * date inside [min, max]: typing a year digit by digit goes through 0002, 0020, 0202 on the way to 2026, and none
 * of those may be acted on. A date outside the limits is refused when the box is left, and the box goes back to
 * the last good date.
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
          if (isISODate(draft)) onRefuse(draft); // a whole date, but outside the limits
          setDraft(value);
        }}
        className="rounded-xl border border-accent/50 bg-white px-3 py-2 text-[13px] text-ink shadow-sm focus:border-accent focus:outline-none"
      />
    </label>
  );
}

export function PeriodSelector({ asOf, from, onChange }: PeriodSelectorProps) {
  const [category, setCategory] = useState<Category>('total');
  const [note, setNote] = useState('');

  const yearlyOptions = buildYearlyOptions();
  const quarterlyOptions = buildQuarterlyOptions();
  const monthlyOptions = buildMonthlyOptions();
  const today = todayISO();

  function selectCategory(c: Category) {
    setCategory(c);
    setNote('');
    if (c === 'total') onChange(today, null);
    else if (c === 'yearly') onChange(yearlyOptions[0].value, null);
    else if (c === 'quarterly') onChange(quarterlyOptions[0].value, null);
    else if (c === 'monthly') onChange(monthlyOptions[0].value, null);
    else onChange(asOf, null); // custom starts as "everything up to the date shown", then the person narrows it
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

  // --- custom range: both dates always inside [first day of the books, today], From never after To
  const fromValue = from ?? ZB_EARLIEST_DATE;
  const toValue = asOf;
  const commitRange = (f: string, t: string, message = '') => {
    setNote(message);
    onChange(t, f <= ZB_EARLIEST_DATE ? null : f);
  };
  const setFrom = (v: string) => (v > toValue ? commitRange(v, v, 'The To date was moved up to match your From date.') : commitRange(v, toValue));
  const setTo = (v: string) => (v < fromValue ? commitRange(v, v, 'The From date was moved back to match your To date.') : commitRange(fromValue, v));
  const refuse = (v: string) =>
    setNote(
      v < ZB_EARLIEST_DATE
        ? `Zoho Books starts on ${prettyDate(ZB_EARLIEST_DATE)}, so there is no data before that. Pick ${prettyDate(ZB_EARLIEST_DATE)} or later.`
        : 'That date has not happened yet. Pick today or an earlier date.'
    );

  const last30 = (() => {
    const d = new Date();
    d.setDate(d.getDate() - 29);
    const f = toISO(d);
    return f < ZB_EARLIEST_DATE ? ZB_EARLIEST_DATE : f;
  })();
  const thisFYStart = (() => {
    const d = new Date();
    const f = toISO(new Date(d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1, 3, 1));
    return f < ZB_EARLIEST_DATE ? ZB_EARLIEST_DATE : f;
  })();
  const chips: { label: string; f: string }[] = [
    { label: 'Last 30 days', f: last30 },
    { label: 'This FY so far', f: thisFYStart },
    { label: 'All data', f: ZB_EARLIEST_DATE },
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
                category === c.key
                  ? 'bg-navy text-white shadow-sm'
                  : 'text-ink/65 hover:bg-navy/[0.07] hover:text-navy'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>

        {secondaryOptions && (
          <select
            value={asOf}
            onChange={(e) => onChange(e.target.value, null)}
            className="rounded-xl border border-line bg-white px-3 py-2.5 text-[13px] font-medium text-ink shadow-sm focus:border-accent focus:outline-none"
          >
            {secondaryOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        )}
      </div>

      {category === 'custom' && (
        <div className="rounded-2xl border border-line bg-white p-3.5 shadow-sm lg:w-[27rem]">
          <div className="flex flex-wrap items-end gap-3">
            <DateField label="From" value={fromValue} min={ZB_EARLIEST_DATE} max={today} onCommit={setFrom} onRefuse={refuse} />
            <DateField label="To" value={toValue} min={ZB_EARLIEST_DATE} max={today} onCommit={setTo} onRefuse={refuse} />
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
              <>Zoho Books data runs from {prettyDate(ZB_EARLIEST_DATE)} to today. Shows invoices and bills dated From to To that are still unpaid.</>
            )}
          </p>
        </div>
      )}
    </div>
  );
}

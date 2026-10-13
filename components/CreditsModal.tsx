'use client';

import { useEffect, useRef } from 'react';
import { DEVELOPER } from '@/lib/brand';

/** The "Credits" card: who built the dashboard. Closes with the button, the Esc key or a click outside the card. */
export function CreditsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  const rows: { label: string; value: string; strong?: boolean }[] = [
    { label: 'Name', value: DEVELOPER.name, strong: true },
    { label: 'Designation', value: DEVELOPER.designation },
    { label: 'Team', value: DEVELOPER.team },
    { label: 'Dept.', value: DEVELOPER.department },
    { label: 'Firm', value: DEVELOPER.firm },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-navy/55 p-4 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="credits-title"
        className="modal-in w-full max-w-[360px] rounded-2xl bg-white p-6 shadow-[0_24px_60px_-12px_rgba(15,37,71,0.45)]"
      >
        <div className="flex items-center gap-3">
          <span className="h-7 w-1 rounded-full bg-accent" aria-hidden="true" />
          <h2 id="credits-title" className="font-display text-[22px] font-extrabold text-navy">
            Credits
          </h2>
        </div>
        <dl className="mt-5 space-y-3.5 text-[15px]">
          {rows.map((r) => (
            <div key={r.label} className="flex flex-wrap gap-x-2">
              <dt className="text-ink/55">{r.label}:</dt>
              <dd className={r.strong ? 'font-bold text-navy' : 'text-ink/85'}>{r.value}</dd>
            </div>
          ))}
        </dl>
        <button
          ref={closeRef}
          onClick={onClose}
          className="mt-6 w-full rounded-xl bg-[#EDF1F7] py-3 text-[15px] font-bold text-navy transition hover:bg-[#E1E8F2]"
        >
          Close
        </button>
      </div>
    </div>
  );
}

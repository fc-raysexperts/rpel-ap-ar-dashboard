/** Excel download of the Stock Statement for the period on the page: the statement itself, plus a "Working" sheet that lists what was adjusted. */
export function StockDownloadButton({ from, to, disabled }: { from: string; to: string; disabled?: boolean }) {
  return (
    <a
      href={`/api/stock/export?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`}
      aria-disabled={disabled}
      className={`inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-[13.5px] font-semibold text-white shadow-sm transition hover:bg-[#2459C9] ${
        disabled ? 'pointer-events-none opacity-50' : ''
      }`}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M8 1.5v9m0 0L4.5 7M8 10.5L11.5 7M2.5 12.5V13a1.5 1.5 0 001.5 1.5h8a1.5 1.5 0 001.5-1.5v-.5"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      Download Stock Statement
    </a>
  );
}

/** One download for both ledgers: an Excel file with an "Accounts Receivable" and an "Accounts Payable" sheet, for the period selected on the page (a custom From-To range included). */
export function DownloadButton({ asOf, from }: { asOf: string; from?: string | null }) {
  return (
    <a
      href={`/api/export?asOf=${encodeURIComponent(asOf)}${from ? `&from=${encodeURIComponent(from)}` : ''}`}
      className="inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-[13.5px] font-semibold text-white shadow-sm transition hover:bg-[#2459C9]"
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
      Download AP &amp; AR Data
    </a>
  );
}

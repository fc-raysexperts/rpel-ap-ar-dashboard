import type { Metadata } from 'next';
import './globals.css';
import { APP_NAME, FIRM_NAME } from '@/lib/brand';

// The tab icon is app/icon.png (and app/apple-icon.png): Next.js adds the <link> tags for them by itself.
export const metadata: Metadata = {
  title: `${APP_NAME} | ${FIRM_NAME}`,
  description: 'Debtors and creditors position, refreshed daily from Zoho Books.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=Manrope:wght@600;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="bg-paper font-sans text-ink antialiased">{children}</body>
    </html>
  );
}

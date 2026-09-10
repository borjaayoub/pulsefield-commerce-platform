import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'PULSE//FIELD | Local Commerce Foundation',
  description: 'Technical foundation for the PULSE//FIELD modular commerce platform.',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

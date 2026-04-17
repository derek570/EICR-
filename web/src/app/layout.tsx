import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'CertMate — EICR-oMatic',
  description: 'Voice-driven EICR / EIC certificate authoring',
  applicationName: 'CertMate',
  appleWebApp: {
    capable: true,
    title: 'CertMate',
    statusBarStyle: 'black-translucent',
  },
  formatDetection: {
    telephone: false,
    email: false,
    address: false,
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  themeColor: '#0A0A0F',
  colorScheme: 'dark',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-dvh bg-[var(--color-surface-0)] text-[var(--color-text-primary)] antialiased">
        {children}
      </body>
    </html>
  );
}

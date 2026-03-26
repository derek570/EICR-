import type { Metadata, Viewport } from 'next';
import { Inter, Geist, Geist_Mono } from 'next/font/google';
import { Toaster } from '@/components/ui/sonner';
import { SyncProvider } from '@/components/sync-provider';
import { ErrorBoundary } from '@/components/error-boundary';
import './globals.css';

const inter = Inter({
  variable: '--font-inter',
  subsets: ['latin'],
  display: 'swap',
});

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'EICR-oMatic 3000',
  description: 'Electrical Installation Condition Report automation',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'EICR-oMatic',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#0A0A0F',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" style={{ colorScheme: 'dark' }}>
      <body
        className={`${inter.variable} ${geistSans.variable} ${geistMono.variable} antialiased min-h-screen bg-L0 text-foreground`}
      >
        <SyncProvider>
          <ErrorBoundary>{children}</ErrorBoundary>
          <Toaster position="top-center" richColors />
        </SyncProvider>
      </body>
    </html>
  );
}

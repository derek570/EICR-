import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { Toaster } from 'sonner';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'CertMate — Talk. Certify. Done.',
  description:
    'Voice-powered EICR certificate creation for UK electrical inspectors. Speak your findings on-site, AI fills the form, send the PDF before you leave.',
  keywords: [
    'EICR',
    'electrical certificate',
    'BS 7671',
    'electrical inspection',
    'CertMate',
    'voice to certificate',
  ],
  openGraph: {
    title: 'CertMate — Talk. Certify. Done.',
    description:
      "Speak your inspection findings — AI fills out the EICR certificate so it's ready to send before you leave site.",
    siteName: 'CertMate',
    type: 'website',
  },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#0F172A',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        {children}
        <Toaster position="top-right" richColors />
      </body>
    </html>
  );
}

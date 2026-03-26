import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { Toaster } from 'sonner';
import './globals.css';

const inter = Inter({
  variable: '--font-inter',
  subsets: ['latin'],
  display: 'swap',
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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" style={{ colorScheme: 'dark' }}>
      <body className={`${inter.variable} antialiased bg-L0 text-foreground`}>
        {children}
        <Toaster position="top-right" richColors />
      </body>
    </html>
  );
}

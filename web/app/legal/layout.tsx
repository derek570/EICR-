import Link from 'next/link';
import { CertMateLogo } from '@/components/brand/certmate-logo';

export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-[#0B1120]">
      {/* Header */}
      <header className="border-b border-gray-200 dark:border-white/5 bg-white dark:bg-[#0F172A]">
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/login">
            <CertMateLogo size="sm" />
          </Link>
          <nav className="flex items-center gap-6 text-sm">
            <Link
              href="/legal/terms"
              className="text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white transition-colors"
            >
              Terms
            </Link>
            <Link
              href="/legal/privacy"
              className="text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white transition-colors"
            >
              Privacy
            </Link>
            <Link
              href="/legal/eula"
              className="text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white transition-colors"
            >
              EULA
            </Link>
          </nav>
        </div>
      </header>
      {/* Content */}
      <main className="max-w-4xl mx-auto px-6 py-12">{children}</main>
      {/* Footer */}
      <footer className="border-t border-gray-200 dark:border-white/5 py-8">
        <div className="max-w-4xl mx-auto px-6 text-center text-sm text-gray-400 dark:text-gray-500">
          CertMate &middot; EICR-oMatic 3000 &middot; certomatic3000.co.uk
        </div>
      </footer>
    </div>
  );
}

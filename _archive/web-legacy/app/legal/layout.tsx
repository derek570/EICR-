import Link from 'next/link';
import { CertMateLogo } from '@/components/brand/certmate-logo';

export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#0B1120]">
      {/* Header */}
      <header className="border-b border-white/5 bg-[#0F172A]">
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/login">
            <CertMateLogo size="sm" />
          </Link>
          <nav className="flex items-center gap-6 text-sm">
            <Link href="/legal/terms" className="text-gray-400 hover:text-white transition-colors">
              Terms
            </Link>
            <Link
              href="/legal/privacy"
              className="text-gray-400 hover:text-white transition-colors"
            >
              Privacy
            </Link>
            <Link href="/legal/eula" className="text-gray-400 hover:text-white transition-colors">
              EULA
            </Link>
          </nav>
        </div>
      </header>
      {/* Content */}
      <main className="max-w-4xl mx-auto px-6 py-12">{children}</main>
      {/* Footer */}
      <footer className="border-t border-white/5 py-8">
        <div className="max-w-4xl mx-auto px-6 text-center text-sm text-gray-500">
          CertMate &middot; certmate.co.uk
        </div>
      </footer>
    </div>
  );
}

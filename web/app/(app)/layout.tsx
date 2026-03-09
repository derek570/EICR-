import { Sidebar } from '@/components/layout/sidebar';
import { Header } from '@/components/layout/header';
import { Breadcrumbs } from '@/components/layout/breadcrumbs';
import { SyncProvider } from '@/components/layout/sync-provider';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <SyncProvider>
      <div className="flex h-screen">
        <Sidebar />
        <div className="flex-1 flex flex-col min-w-0">
          <Header />
          <Breadcrumbs />
          <main className="flex-1 overflow-auto bg-gray-50/50 dark:bg-[#0F172A]">{children}</main>
        </div>
      </div>
    </SyncProvider>
  );
}

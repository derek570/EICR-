import { AppShell } from '@/components/layout/app-shell';
import { SyncProvider } from '@/components/layout/sync-provider';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <SyncProvider>
      <AppShell>{children}</AppShell>
    </SyncProvider>
  );
}

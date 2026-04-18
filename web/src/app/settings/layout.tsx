import { AppShell } from '@/components/layout/app-shell';

/**
 * All /settings/* screens share the same AppShell. Per-section chrome
 * (sub-nav, breadcrumbs) lives in each page rather than here because the
 * settings tree is shallow enough to not benefit from a persistent rail.
 */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}

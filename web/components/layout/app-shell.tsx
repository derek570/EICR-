'use client';

import { AppSidebar } from './app-sidebar';
import { AppHeader } from './app-header';
import { MobileTabBar } from './mobile-tab-bar';
import { Breadcrumbs } from './breadcrumbs';

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen bg-L0">
      {/* Desktop sidebar — hidden below md */}
      <AppSidebar />

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0">
        <AppHeader />
        <Breadcrumbs />
        <main className="flex-1 overflow-auto bg-L0 pb-14 md:pb-0">{children}</main>
      </div>

      {/* Mobile bottom tab bar — visible below md */}
      <MobileTabBar />
    </div>
  );
}

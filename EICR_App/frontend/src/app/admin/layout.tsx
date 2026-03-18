'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Shield, Users, Activity } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { User } from '@/lib/api';
import { OfflineIndicator } from '@/components/offline-indicator';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    const storedUser = localStorage.getItem('user');
    if (!storedUser) {
      router.push('/login');
      return;
    }
    const userData = JSON.parse(storedUser) as User;
    if (userData.role !== 'admin') {
      router.push('/dashboard');
      return;
    }
    setUser(userData);
  }, [router]);

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    );
  }

  const tabs = [
    { href: '/admin/users', label: 'Users', icon: Users },
    { href: '/admin/system', label: 'System', icon: Activity },
  ];

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="bg-card border-b border-border sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/dashboard">
              <Button variant="ghost" size="sm">
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back
              </Button>
            </Link>
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-red-600">
                <Shield className="h-4 w-4 text-white" />
              </div>
              <span className="font-semibold hidden sm:inline">Admin</span>
            </div>
          </div>
          <OfflineIndicator />
        </div>
      </header>

      {/* Tab navigation */}
      <nav className="bg-card border-b border-border">
        <div className="max-w-7xl mx-auto px-4">
          <div className="flex gap-1">
            {tabs.map((tab) => {
              const isActive = pathname.startsWith(tab.href);
              const Icon = tab.icon;
              return (
                <Link key={tab.href} href={tab.href}>
                  <Button
                    variant="ghost"
                    className={`rounded-none border-b-2 ${
                      isActive ? 'border-primary text-primary' : 'border-transparent'
                    }`}
                  >
                    <Icon className="h-4 w-4 mr-2" />
                    {tab.label}
                  </Button>
                </Link>
              );
            })}
          </div>
        </div>
      </nav>

      {/* Main content */}
      <main className="max-w-7xl mx-auto px-4 py-6">{children}</main>
    </div>
  );
}

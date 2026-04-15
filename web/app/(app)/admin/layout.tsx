'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import { Users, Activity } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { User } from '@/lib/types';

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
    <div className="p-6 space-y-6">
      {/* Tab navigation */}
      <div className="flex gap-1 border-b border-border">
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

      {children}
    </div>
  );
}

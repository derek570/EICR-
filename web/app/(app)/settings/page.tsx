'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  User,
  Building2,
  SlidersHorizontal,
  Users,
  Shield,
  Key,
  Bell,
  Info,
  CreditCard,
  ChevronRight,
} from 'lucide-react';
import { getUser } from '@/lib/auth';

interface SettingSection {
  title: string;
  items: SettingItem[];
}

interface SettingItem {
  icon: React.ElementType;
  iconColor: string;
  iconBg: string;
  label: string;
  description: string;
  href: string;
}

const sections: SettingSection[] = [
  {
    title: 'Account',
    items: [
      {
        icon: User,
        iconColor: '#3b82f6',
        iconBg: 'rgba(59,130,246,0.12)',
        label: 'Profile',
        description: 'Your name, email and account details',
        href: '/settings/profile',
      },
      {
        icon: Key,
        iconColor: '#8b5cf6',
        iconBg: 'rgba(139,92,246,0.12)',
        label: 'Change Password',
        description: 'Update your account password',
        href: '/settings/password',
      },
    ],
  },
  {
    title: 'Certificate Defaults',
    items: [
      {
        icon: SlidersHorizontal,
        iconColor: '#06b6d4',
        iconBg: 'rgba(6,182,212,0.12)',
        label: 'Defaults',
        description: 'Circuit field defaults applied to new jobs',
        href: '/defaults',
      },
    ],
  },
  {
    title: 'Company & Team',
    items: [
      {
        icon: Building2,
        iconColor: '#f59e0b',
        iconBg: 'rgba(245,158,11,0.12)',
        label: 'Company Details',
        description: 'Name, address, logo and contact info',
        href: '/settings/company',
      },
      {
        icon: Users,
        iconColor: '#22c55e',
        iconBg: 'rgba(34,197,94,0.12)',
        label: 'Staff',
        description: 'Manage inspectors and team members',
        href: '/staff',
      },
    ],
  },
  {
    title: 'Billing',
    items: [
      {
        icon: CreditCard,
        iconColor: '#10b981',
        iconBg: 'rgba(16,185,129,0.12)',
        label: 'Billing & Subscription',
        description: 'Manage your plan and payment details',
        href: '/settings/billing',
      },
    ],
  },
  {
    title: 'App',
    items: [
      {
        icon: Bell,
        iconColor: '#f97316',
        iconBg: 'rgba(249,115,22,0.12)',
        label: 'Notifications',
        description: 'Alert preferences and email notifications',
        href: '/settings/notifications',
      },
      {
        icon: Shield,
        iconColor: '#64748b',
        iconBg: 'rgba(100,116,139,0.12)',
        label: 'Privacy & Legal',
        description: 'Terms of service, privacy policy',
        href: '/legal',
      },
      {
        icon: Info,
        iconColor: '#94a3b8',
        iconBg: 'rgba(148,163,184,0.08)',
        label: 'About',
        description: 'CertMate v2.0 — AI-powered electrical certificates',
        href: '/settings/about',
      },
    ],
  },
];

export default function SettingsPage() {
  const user = getUser();

  return (
    <div className="p-6 max-w-2xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white">Settings</h1>
        {user?.email && <p className="text-sm text-gray-500 mt-1">{user.email}</p>}
      </div>

      {sections.map((section) => (
        <div key={section.title}>
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 px-1">
            {section.title}
          </h2>
          <div className="rounded-xl border border-white/[0.07] overflow-hidden divide-y divide-white/[0.05]">
            {section.items.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="flex items-center gap-4 px-4 py-3.5 bg-white/[0.02] hover:bg-white/[0.06] transition-colors group min-h-[56px]"
              >
                <div
                  className="flex items-center justify-center w-9 h-9 rounded-xl shrink-0"
                  style={{ backgroundColor: item.iconBg }}
                >
                  <item.icon className="w-4 h-4" style={{ color: item.iconColor }} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-white">{item.label}</p>
                  <p className="text-xs text-gray-500 truncate">{item.description}</p>
                </div>
                <ChevronRight className="h-4 w-4 text-gray-600 group-hover:text-gray-400 transition-colors shrink-0" />
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

'use client';

import type { LucideIcon } from 'lucide-react';

interface QuickActionButtonProps {
  label: string;
  icon: LucideIcon;
  onClick: () => void;
}

export function QuickActionButton({ label, icon: Icon, onClick }: QuickActionButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center justify-center gap-2 h-[52px] px-6 rounded-full font-semibold text-[16px] text-white bg-gradient-to-r from-brand-green to-brand-blue shadow-[0_4px_16px_rgba(0,102,255,0.30)] transition-all duration-200 hover:shadow-[0_6px_24px_rgba(0,102,255,0.40)] hover:brightness-110 active:animate-spring-press focus-visible:ring-2 focus-visible:ring-brand-blue/50 focus-visible:ring-offset-2 focus-visible:ring-offset-L0 outline-none"
    >
      <Icon className="w-5 h-5" />
      {label}
    </button>
  );
}

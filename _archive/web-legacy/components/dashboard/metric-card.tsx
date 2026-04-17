'use client';

import type { LucideIcon } from 'lucide-react';
import { GlassCard } from '@/components/ui/glass-card';
import { AnimatedCounter } from './animated-counter';

interface MetricCardProps {
  label: string;
  value: number;
  icon: LucideIcon;
  iconColor: string;
  iconBgColor: string;
}

export function MetricCard({ label, value, icon: Icon, iconColor, iconBgColor }: MetricCardProps) {
  return (
    <GlassCard className="flex items-center gap-4 p-4 animate-[stagger-in_0.4s_ease-out_both]">
      <div
        className="flex items-center justify-center w-11 h-11 rounded-xl"
        style={{ backgroundColor: iconBgColor }}
      >
        <Icon className="w-5 h-5" style={{ color: iconColor }} />
      </div>
      <div className="flex flex-col">
        <AnimatedCounter
          value={value}
          className="text-2xl font-bold text-foreground tabular-nums"
        />
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
    </GlassCard>
  );
}

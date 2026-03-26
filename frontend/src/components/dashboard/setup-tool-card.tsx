'use client';

import type { LucideIcon } from 'lucide-react';
import { GlassCard } from '@/components/ui/glass-card';

interface SetupToolCardProps {
  label: string;
  description: string;
  icon: LucideIcon;
  onClick: () => void;
  index: number;
}

export function SetupToolCard({
  label,
  description,
  icon: Icon,
  onClick,
  index,
}: SetupToolCardProps) {
  return (
    <GlassCard
      className="group cursor-pointer p-4 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_6px_20px_rgba(0,0,0,0.14)] hover:bg-[rgba(255,255,255,0.08)] active:animate-spring-press animate-[stagger-in_0.4s_ease-out_both]"
      style={{ animationDelay: `${index * 60}ms` }}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <div className="flex items-start gap-3">
        <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-white/8">
          <Icon className="w-5 h-5 text-brand-blue" />
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-semibold text-foreground group-hover:text-white transition-colors">
            {label}
          </span>
          <span className="text-xs text-muted-foreground leading-relaxed">{description}</span>
        </div>
      </div>
    </GlassCard>
  );
}

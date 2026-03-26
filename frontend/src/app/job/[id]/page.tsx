'use client';

import { useJob } from './layout';
import {
  GlassCard,
  GlassCardContent,
  GlassCardHeader,
  GlassCardTitle,
} from '@/components/ui/glass-card';
import { StatusBadge } from '@/components/ui/status-badge';
import { CircuitBoard, AlertTriangle, Zap, Building2 } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';

export default function JobOverviewPage() {
  const { job } = useJob();
  const params = useParams();
  const jobId = params.id as string;

  const c1Count = job.observations.filter((o) => o.code === 'C1').length;
  const c2Count = job.observations.filter((o) => o.code === 'C2').length;
  const c3Count = job.observations.filter((o) => o.code === 'C3').length;
  const fiCount = job.observations.filter((o) => o.code === 'FI').length;

  const hasDangerousObservations = c1Count > 0 || c2Count > 0;

  return (
    <div className="p-6 space-y-6 max-w-4xl stagger-in bg-L0 min-h-screen">
      {/* Status Banner */}
      <GlassCard className="animate-stagger-in" gradientBorder={!hasDangerousObservations}>
        <GlassCardContent className="py-4 px-5">
          <div className="flex items-center gap-3">
            {hasDangerousObservations ? (
              <>
                <div className="flex items-center justify-center h-10 w-10 rounded-full bg-status-red/15">
                  <AlertTriangle className="h-5 w-5 text-status-red" />
                </div>
                <div>
                  <StatusBadge status="unsatisfactory">Unsatisfactory</StatusBadge>
                  <p className="text-sm text-muted-foreground mt-1">
                    {c1Count > 0 && `${c1Count} danger present`}
                    {c1Count > 0 && c2Count > 0 && ', '}
                    {c2Count > 0 && `${c2Count} potentially dangerous`}
                  </p>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center justify-center h-10 w-10 rounded-full bg-status-green/15">
                  <CircuitBoard className="h-5 w-5 text-status-green" />
                </div>
                <div>
                  <StatusBadge status="satisfactory">Satisfactory</StatusBadge>
                  <p className="text-sm text-muted-foreground mt-1">
                    No dangerous observations found
                  </p>
                </div>
              </>
            )}
          </div>
        </GlassCardContent>
      </GlassCard>

      {/* Quick Stats */}
      <div className="grid grid-cols-2 gap-4 animate-stagger-in">
        <Link href={`/job/${jobId}/circuits`}>
          <GlassCard className="hover:bg-white/8 transition-all duration-200 hover:-translate-y-0.5 cursor-pointer">
            <GlassCardContent className="py-4 px-5">
              <div className="flex items-center gap-3">
                <div className="flex items-center justify-center h-9 w-9 rounded-xl bg-brand-blue/15">
                  <Zap className="h-4 w-4 text-brand-blue" />
                </div>
                <div>
                  <p className="text-2xl font-bold text-foreground">{job.circuits.length}</p>
                  <p className="text-xs text-muted-foreground">Circuits</p>
                </div>
              </div>
            </GlassCardContent>
          </GlassCard>
        </Link>
        <Link href={`/job/${jobId}/observations`}>
          <GlassCard className="hover:bg-white/8 transition-all duration-200 hover:-translate-y-0.5 cursor-pointer">
            <GlassCardContent className="py-4 px-5">
              <div className="flex items-center gap-3">
                <div className="flex items-center justify-center h-9 w-9 rounded-xl bg-status-amber/15">
                  <AlertTriangle className="h-4 w-4 text-status-amber" />
                </div>
                <div>
                  <p className="text-2xl font-bold text-foreground">{job.observations.length}</p>
                  <p className="text-xs text-muted-foreground">Observations</p>
                </div>
              </div>
            </GlassCardContent>
          </GlassCard>
        </Link>
      </div>

      {/* Observation Summary */}
      {job.observations.length > 0 && (
        <GlassCard className="animate-stagger-in">
          <GlassCardHeader>
            <GlassCardTitle>Observation Summary</GlassCardTitle>
          </GlassCardHeader>
          <GlassCardContent>
            <div className="grid grid-cols-4 gap-3 text-center">
              <div className="rounded-xl bg-status-c1/10 border border-status-c1/15 p-3">
                <p className="text-2xl font-bold text-status-c1">{c1Count}</p>
                <p className="text-[10px] font-bold uppercase tracking-wider text-status-c1">C1</p>
              </div>
              <div className="rounded-xl bg-status-c2/10 border border-status-c2/15 p-3">
                <p className="text-2xl font-bold text-status-c2">{c2Count}</p>
                <p className="text-[10px] font-bold uppercase tracking-wider text-status-c2">C2</p>
              </div>
              <div className="rounded-xl bg-status-c3/10 border border-status-c3/15 p-3">
                <p className="text-2xl font-bold text-status-c3">{c3Count}</p>
                <p className="text-[10px] font-bold uppercase tracking-wider text-status-c3">C3</p>
              </div>
              <div className="rounded-xl bg-status-fi/10 border border-status-fi/15 p-3">
                <p className="text-2xl font-bold text-status-fi">{fiCount}</p>
                <p className="text-[10px] font-bold uppercase tracking-wider text-status-fi">FI</p>
              </div>
            </div>
          </GlassCardContent>
        </GlassCard>
      )}

      {/* Board Information */}
      <GlassCard className="animate-stagger-in">
        <GlassCardHeader>
          <div className="flex items-center gap-2">
            <Building2 className="h-4 w-4 text-brand-blue" />
            <GlassCardTitle>Board Information</GlassCardTitle>
          </div>
        </GlassCardHeader>
        <GlassCardContent>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-lg bg-L2/50 px-3 py-2">
              <dt className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">
                Location
              </dt>
              <dd className="text-foreground">{job.board_info.location || '\u2014'}</dd>
            </div>
            <div className="rounded-lg bg-L2/50 px-3 py-2">
              <dt className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">
                Manufacturer
              </dt>
              <dd className="text-foreground">{job.board_info.manufacturer || '\u2014'}</dd>
            </div>
            <div className="rounded-lg bg-L2/50 px-3 py-2">
              <dt className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">
                Earthing
              </dt>
              <dd className="text-foreground">{job.board_info.earthing_arrangement || '\u2014'}</dd>
            </div>
            <div className="rounded-lg bg-L2/50 px-3 py-2">
              <dt className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">
                Ze
              </dt>
              <dd className="text-foreground">
                {job.board_info.ze ? `${job.board_info.ze} \u03A9` : '\u2014'}
              </dd>
            </div>
          </dl>
        </GlassCardContent>
      </GlassCard>
    </div>
  );
}

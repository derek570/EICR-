/**
 * Phase 3 — alert bucketing.
 *
 * Pure function, no IDB/React. Asserts:
 *   1. Jobs land in the correct bucket per status.
 *   2. Each bucket sorts most-recently-updated first.
 *   3. `recentlyCompleted` caps at 10 (iOS parity).
 *   4. Empty input returns empty buckets.
 */

import { describe, expect, it } from 'vitest';
import { bucketJobs } from '@/lib/alerts/buckets';
import type { Job } from '@/lib/types';

function mkJob(partial: Partial<Job> & Pick<Job, 'id' | 'status'>): Job {
  return {
    id: partial.id,
    status: partial.status,
    address: partial.address ?? `Job ${partial.id}`,
    created_at: partial.created_at ?? '2024-01-01T00:00:00Z',
    updated_at: partial.updated_at,
    certificate_type: partial.certificate_type,
  };
}

describe('bucketJobs', () => {
  it('returns empty buckets for an empty input', () => {
    const b = bucketJobs([]);
    expect(b.needsAttention).toEqual([]);
    expect(b.inProgress).toEqual([]);
    expect(b.recentlyCompleted).toEqual([]);
  });

  it('routes failed → needsAttention, pending/processing → inProgress, done → recentlyCompleted', () => {
    const jobs: Job[] = [
      mkJob({ id: '1', status: 'failed' }),
      mkJob({ id: '2', status: 'pending' }),
      mkJob({ id: '3', status: 'processing' }),
      mkJob({ id: '4', status: 'done' }),
    ];
    const b = bucketJobs(jobs);
    expect(b.needsAttention.map((j) => j.id)).toEqual(['1']);
    expect(b.inProgress.map((j) => j.id).sort()).toEqual(['2', '3']);
    expect(b.recentlyCompleted.map((j) => j.id)).toEqual(['4']);
  });

  it('sorts each bucket most-recently-updated first', () => {
    const jobs: Job[] = [
      mkJob({ id: 'old', status: 'failed', updated_at: '2024-01-01T00:00:00Z' }),
      mkJob({ id: 'new', status: 'failed', updated_at: '2024-06-01T00:00:00Z' }),
      mkJob({ id: 'mid', status: 'failed', updated_at: '2024-03-01T00:00:00Z' }),
    ];
    const b = bucketJobs(jobs);
    expect(b.needsAttention.map((j) => j.id)).toEqual(['new', 'mid', 'old']);
  });

  it('falls back to created_at when updated_at is missing', () => {
    const jobs: Job[] = [
      mkJob({ id: 'A', status: 'pending', created_at: '2024-01-01T00:00:00Z' }),
      mkJob({ id: 'B', status: 'pending', created_at: '2024-05-01T00:00:00Z' }),
    ];
    const b = bucketJobs(jobs);
    expect(b.inProgress.map((j) => j.id)).toEqual(['B', 'A']);
  });

  it('caps recentlyCompleted at 10 (iOS parity)', () => {
    const jobs: Job[] = Array.from({ length: 25 }, (_, i) =>
      mkJob({
        id: String(i),
        status: 'done',
        // ascending updated dates so the newest 10 land in the output
        updated_at: new Date(2024, 0, 1 + i).toISOString(),
      })
    );
    const b = bucketJobs(jobs);
    expect(b.recentlyCompleted).toHaveLength(10);
    // The 10 most recent are ids 15..24 (desc).
    expect(b.recentlyCompleted.map((j) => j.id)).toEqual([
      '24',
      '23',
      '22',
      '21',
      '20',
      '19',
      '18',
      '17',
      '16',
      '15',
    ]);
  });
});

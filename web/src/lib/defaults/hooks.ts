'use client';

/**
 * Phase B — Defaults React hooks (2026-05-03).
 *
 * Thin SWR-style wrappers around `service.ts`. Two hooks:
 *
 *   - `usePresets(userId, certificateType?)` — returns the preset list
 *     plus mutators (save/update/delete) that auto-refetch on success.
 *   - `useCableDefaults(userId)` — returns the cable defaults table
 *     plus a single `save(rows)` mutator. The hook auto-seeds on first
 *     load (via service.ts), so the editor never sees an empty table.
 *
 * No IDB caching here — Defaults is an admin surface that's already
 * wrapped in the loading state and a single network round-trip is
 * fast enough. If we add offline-first defaults later, lift the IDB
 * read-through pattern from `use-user-defaults.ts`.
 */

import * as React from 'react';
import {
  loadPresets,
  savePreset,
  updatePreset,
  deletePreset,
  loadCableDefaults,
  saveCableDefaults,
} from './service';
import type { CertificateDefaultPreset, CableDefault } from './types';
import type { JobDetail } from '../types';

export interface UsePresetsResult {
  presets: CertificateDefaultPreset[];
  loading: boolean;
  error: string | null;
  create: (input: {
    name: string;
    certificate_type: string;
    default_data: Partial<JobDetail>;
  }) => Promise<CertificateDefaultPreset>;
  update: (
    id: string,
    patch: { name?: string; default_data?: Partial<JobDetail> }
  ) => Promise<void>;
  remove: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
}

export function usePresets(userId: string | undefined, certificateType?: string): UsePresetsResult {
  const [presets, setPresets] = React.useState<CertificateDefaultPreset[]>([]);
  const [loading, setLoading] = React.useState<boolean>(Boolean(userId));
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    if (!userId) {
      setPresets([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const list = await loadPresets(userId, certificateType);
      setPresets(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load presets');
    } finally {
      setLoading(false);
    }
  }, [userId, certificateType]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = React.useCallback<UsePresetsResult['create']>(
    async (input) => {
      if (!userId) throw new Error('No signed-in user');
      const preset = await savePreset(userId, input);
      await refresh();
      return preset;
    },
    [userId, refresh]
  );

  const update = React.useCallback<UsePresetsResult['update']>(
    async (id, patch) => {
      if (!userId) throw new Error('No signed-in user');
      await updatePreset(userId, id, patch);
      await refresh();
    },
    [userId, refresh]
  );

  const remove = React.useCallback<UsePresetsResult['remove']>(
    async (id) => {
      if (!userId) throw new Error('No signed-in user');
      await deletePreset(userId, id);
      await refresh();
    },
    [userId, refresh]
  );

  return { presets, loading, error, create, update, remove, refresh };
}

export interface UseCableDefaultsResult {
  rows: CableDefault[];
  loading: boolean;
  error: string | null;
  save: (next: CableDefault[]) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useCableDefaults(userId: string | undefined): UseCableDefaultsResult {
  const [rows, setRows] = React.useState<CableDefault[]>([]);
  const [loading, setLoading] = React.useState<boolean>(Boolean(userId));
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    if (!userId) {
      setRows([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const list = await loadCableDefaults(userId);
      setRows(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load cable defaults');
    } finally {
      setLoading(false);
    }
  }, [userId]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = React.useCallback<UseCableDefaultsResult['save']>(
    async (next) => {
      if (!userId) throw new Error('No signed-in user');
      try {
        await saveCableDefaults(userId, next);
        setRows(next);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to save cable defaults');
        throw err;
      }
    },
    [userId]
  );

  return { rows, loading, error, save, refresh };
}

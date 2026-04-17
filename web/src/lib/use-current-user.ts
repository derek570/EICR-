'use client';

import * as React from 'react';
import { api } from './api-client';
import { getUser } from './auth';
import type { User } from './types';

/**
 * `useCurrentUser` — reactive view of the signed-in user.
 *
 * Why: role-gated rendering (see `lib/roles.ts`) needs the *live* user,
 * not the snapshot stashed in localStorage at login time. A system admin
 * who gets demoted mid-session should lose access on the next page
 * render, not at next login. We hydrate instantly from `getUser()` (so
 * the first paint already knows the role) and then revalidate via
 * `api.me()` in the background.
 *
 * The `refresh` callback lets callers force a re-read after an action
 * they know will have changed role/state (e.g. the admin UI updating
 * its own account).
 */
export function useCurrentUser(): {
  user: User | null;
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const [user, setUser] = React.useState<User | null>(() => getUser());
  const [loading, setLoading] = React.useState<boolean>(true);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      const fresh = await api.me();
      setUser(fresh);
      // Mirror into localStorage so subsequent first-paints reflect the
      // latest role (e.g. after a promotion) without re-hitting the API.
      if (typeof window !== 'undefined') {
        localStorage.setItem('cm_user', JSON.stringify(fresh));
      }
    } catch {
      // Silent — 401 falls through to the middleware redirect on next nav.
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  return { user, loading, refresh };
}

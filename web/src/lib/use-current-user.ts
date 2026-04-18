'use client';

import * as React from 'react';
import { api } from './api-client';
import { clearAuth, getUser } from './auth';
import { ApiError } from './types';
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
 *
 * Pre-deploy: on 401/403, clear the local cached user + token rather
 * than leaving a stale snapshot in place. Pre-fix, a revoked session
 * would continue to render admin chrome (driven by the cached role)
 * until the next full navigation gave the middleware a chance to
 * redirect. Clearing here makes the UI collapse to "signed out" on the
 * same tick the server rejects us.
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
    } catch (err) {
      // 401/403 → server has revoked or invalidated the session. Drop
      // the cached user + token so role-gated chrome can't render from
      // stale data. The middleware owns the actual redirect to /login;
      // this is just local hygiene so the UI stops showing admin bits.
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        clearAuth();
        setUser(null);
        return;
      }
      // Transient (5xx, offline) — keep whatever's already in state so
      // the inspector doesn't get kicked out of the UI on a network blip.
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  return { user, loading, refresh };
}

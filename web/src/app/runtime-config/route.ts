import { NextResponse } from 'next/server';

/**
 * Same-origin runtime-config endpoint — the web STT kill-switch (parity WS4).
 *
 * Serves `{ sttModel: <raw DEEPGRAM_STT_MODEL env value or null> }` read from
 * `process.env` at REQUEST time. The client (`web/src/lib/runtime-config.ts`)
 * normalises + resolves the raw value (nova3 / flux / fail-safe). Exposing the
 * raw value (not the resolved one) keeps all the fail-safe/normalisation logic
 * in one tested place on the client.
 *
 * ⚠️ This route lives at the TOP-LEVEL path `/runtime-config`, NOT under
 * `/api/*`. The production ALB has a priority-10 rule forwarding all `/api/*`
 * to the BACKEND target group (`infrastructure/setup-domain.sh:394-406`); an
 * `/api/runtime-config` route would 404 in prod and the client's fetch-failure
 * fail-safe would pin every session to nova3, so the Flux default could never
 * take effect. Keep it top-level so Next.js serves it.
 *
 * `force-dynamic` + `no-store` guarantee the value is read live on every
 * request (an emergency ECS env flip must take effect at the next
 * recording-session fetch, never a stale build-time snapshot or a cached
 * response). The service worker must NOT cache this path — enforced by an
 * explicit NetworkOnly matcher in `web/src/app/sw.ts`.
 *
 * The route sits BEHIND `web/src/middleware.ts`'s JWT gate (a top-level path,
 * not `/api/*`-early-returned). That is fine: recording only runs when
 * authenticated, so an authed request reaches this handler and gets the JSON;
 * an expired-token request is redirected to `/login` (HTML) and the client's
 * `.json()` parse fails → the fetch-failure branch resolves the fail-safe
 * nova3. See `tests/runtime-config-middleware.test.ts`.
 */
export const dynamic = 'force-dynamic';

export function GET() {
  const raw = process.env.DEEPGRAM_STT_MODEL ?? null;
  return NextResponse.json(
    { sttModel: raw },
    {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    }
  );
}

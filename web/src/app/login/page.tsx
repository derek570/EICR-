'use client';

import { useState, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Logo } from '@/components/brand/logo';
import { api } from '@/lib/api-client';
import { setAuth } from '@/lib/auth';
import { ApiError } from '@/lib/types';

/**
 * Login — ports the iOS LoginView look:
 *  - Dark gradient background with drifting brand-blue + brand-green orbs
 *  - Shimmer line under the hero
 *  - Glass card over the ambient background
 *  - 44 px tap targets on both fields and the button
 */
export default function LoginPage() {
  const router = useRouter();
  const params = useSearchParams();
  const redirect = params.get('redirect') ?? '/dashboard';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      try {
        const res = await api.login(email.trim(), password);
        setAuth(res.token, res.user);
        router.push(redirect);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          setError('Wrong email or password.');
        } else if (err instanceof ApiError && err.status === 423) {
          setError('Account locked — try again in a few minutes.');
        } else if (err instanceof Error) {
          setError(err.message || "Couldn't sign in. Try again.");
        } else {
          setError("Couldn't sign in. Try again.");
        }
      }
    });
  }

  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden px-6 py-16">
      {/* Ambient orbs */}
      <div
        className="cm-orb"
        style={{
          top: '-140px',
          left: '-80px',
          width: '480px',
          height: '480px',
          background: 'radial-gradient(circle, rgba(0,102,255,0.9), transparent 70%)',
        }}
        aria-hidden
      />
      <div
        className="cm-orb"
        style={{
          bottom: '-180px',
          right: '-120px',
          width: '560px',
          height: '560px',
          background: 'radial-gradient(circle, rgba(0,204,102,0.55), transparent 70%)',
          animationDelay: '-4s',
        }}
        aria-hidden
      />
      <div
        className="cm-orb"
        style={{
          top: '35%',
          right: '10%',
          width: '220px',
          height: '220px',
          background: 'radial-gradient(circle, rgba(191,90,242,0.35), transparent 70%)',
          animationDelay: '-2s',
        }}
        aria-hidden
      />

      {/* Card */}
      <div
        className="cm-glass relative w-full rounded-[var(--radius-xl)] p-7 md:p-9 shadow-[0_24px_60px_rgba(0,0,0,0.55)]"
        style={{ maxWidth: '420px' }}
      >
        <div className="mb-6 flex flex-col items-start gap-2">
          <Logo size="lg" />
          <h1 className="mt-3 text-[26px] font-bold tracking-tight">Sign in to CertMate</h1>
          <p className="text-sm text-[var(--color-text-secondary)]">
            Voice-driven EICR & EIC authoring.
          </p>
          <div className="cm-shimmer mt-2 h-px w-24 rounded-full" aria-hidden />
        </div>

        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          <div>
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              inputMode="email"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.co.uk"
            />
          </div>
          <div>
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>

          {error ? (
            <p
              role="alert"
              className="rounded-[var(--radius-md)] border border-[var(--color-status-failed)]/40 bg-[var(--color-status-failed)]/10 px-3 py-2 text-sm text-[var(--color-status-failed)]"
            >
              {error}
            </p>
          ) : null}

          <Button
            type="submit"
            size="lg"
            disabled={pending || !email || !password}
            className="mt-2 w-full"
          >
            {pending ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </div>
    </main>
  );
}

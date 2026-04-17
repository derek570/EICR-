import { Logo } from '@/components/brand/logo';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';

/**
 * Phase 0 showcase — verifies the design-token pipeline renders as expected
 * before we start assembling real screens. This page gets replaced with a
 * `/login` redirect in Phase 1.
 */
export default function Phase0Showcase() {
  return (
    <main className="relative min-h-dvh overflow-hidden px-6 py-12 md:px-12">
      {/* Ambient orbs (preview of login immersive background) */}
      <div
        className="cm-orb"
        style={{
          top: '-120px',
          left: '-80px',
          width: '420px',
          height: '420px',
          background: 'radial-gradient(circle, rgba(0,102,255,0.9), transparent 70%)',
          animationDelay: '0s',
        }}
        aria-hidden
      />
      <div
        className="cm-orb"
        style={{
          bottom: '-160px',
          right: '-120px',
          width: '520px',
          height: '520px',
          background: 'radial-gradient(circle, rgba(0,204,102,0.6), transparent 70%)',
          animationDelay: '-4.5s',
        }}
        aria-hidden
      />

      <div className="relative mx-auto flex w-full flex-col gap-10" style={{ maxWidth: '960px' }}>
        <header className="flex items-center justify-between">
          <Logo size="lg" />
          <span className="text-xs text-[var(--color-text-tertiary)]">Phase 0 · foundation</span>
        </header>

        <section className="flex flex-col gap-3">
          <h1 className="text-4xl font-black tracking-tight md:text-5xl">
            Voice-first EICR authoring.
          </h1>
          <p
            className="text-[17px] leading-relaxed text-[var(--color-text-secondary)]"
            style={{ maxWidth: '560px', width: '100%' }}
          >
            Web rebuild of the CertMate iOS app. Same backend, same transcript pipeline, same feel —
            now in a browser.
          </p>
          <div className="mt-2 flex gap-3">
            <Button size="lg">Primary</Button>
            <Button size="lg" variant="secondary">
              Secondary
            </Button>
            <Button size="lg" variant="ghost">
              Ghost
            </Button>
          </div>
        </section>

        {/* Surface hierarchy ribbon */}
        <section className="flex flex-col gap-3" data-testid="surface-ribbon">
          <h2 className="text-[13px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
            Surface hierarchy
          </h2>
          <div className="grid grid-cols-5 gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] p-2">
            {[0, 1, 2, 3, 4].map((level) => (
              <div
                key={level}
                className="flex h-16 items-center justify-center rounded-[var(--radius-sm)] text-xs font-medium text-[var(--color-text-secondary)]"
                style={{
                  background: `var(--color-surface-${level})`,
                }}
              >
                L{level}
              </div>
            ))}
          </div>
        </section>

        {/* Status dots */}
        <section className="flex flex-col gap-3" data-testid="status-dots">
          <h2 className="text-[13px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
            Recording states
          </h2>
          <div className="flex flex-wrap gap-4">
            {[
              { label: 'Idle', color: 'var(--color-rec-idle)' },
              { label: 'Listening', color: 'var(--color-rec-listening)' },
              { label: 'Speaking', color: 'var(--color-rec-speaking)', pulse: true },
              { label: 'Trailing', color: 'var(--color-rec-trailing)' },
              { label: 'Active', color: 'var(--color-rec-active)', pulse: true },
            ].map(({ label, color, pulse }) => (
              <div key={label} className="flex items-center gap-2">
                <span
                  className={'block h-3 w-3 rounded-full ' + (pulse ? 'cm-pulse-dot' : '')}
                  style={{ background: color }}
                />
                <span className="text-sm text-[var(--color-text-secondary)]">{label}</span>
              </div>
            ))}
          </div>
        </section>

        {/* Card variants */}
        <section className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Solid card</CardTitle>
              <CardDescription>Opaque surface-2 elevation.</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-[var(--color-text-secondary)]">Body text. 16px.</p>
            </CardContent>
          </Card>
          <Card glass>
            <CardHeader>
              <CardTitle>Glass card</CardTitle>
              <CardDescription>Used for the transcript strip.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="cm-shimmer h-2 w-full rounded-full bg-[var(--color-surface-3)]" />
            </CardContent>
          </Card>
        </section>
      </div>
    </main>
  );
}

'use client';

import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Placeholder tab body. Lets us ship the navigable shell in Phase 2 before
 * any tab's real form lands. Each subsequent phase replaces one of these
 * with the genuine editing UI.
 */
export function TabStub({
  title,
  summary,
  landsIn,
}: {
  title: string;
  summary: string;
  landsIn: string;
}) {
  return (
    <div
      className="mx-auto flex w-full flex-col gap-6 px-4 py-6 md:px-8 md:py-10"
      style={{ maxWidth: '960px' }}
    >
      <header className="flex flex-col gap-1">
        <p className="text-[11px] uppercase tracking-[0.14em] text-[var(--color-text-tertiary)]">
          {landsIn}
        </p>
        <h2 className="text-[24px] font-semibold text-[var(--color-text-primary)] md:text-[28px]">
          {title}
        </h2>
      </header>
      <Card>
        <CardHeader>
          <CardTitle>Coming soon</CardTitle>
          <CardDescription>{summary}</CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}

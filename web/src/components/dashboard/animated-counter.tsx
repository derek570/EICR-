'use client';

import * as React from 'react';

/**
 * Animated counter matching iOS hero metric behaviour:
 * counts from 0 to `value` over ~700 ms with an ease-out curve.
 */
export function AnimatedCounter({
  value,
  durationMs = 700,
  className,
  'aria-label': ariaLabel,
}: {
  value: number;
  durationMs?: number;
  className?: string;
  'aria-label'?: string;
}) {
  const [display, setDisplay] = React.useState(0);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) {
      setDisplay(value);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const from = 0;
    function tick(now: number) {
      const t = Math.min(1, (now - start) / durationMs);
      // ease-out cubic
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(Math.round(from + (value - from) * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, durationMs]);

  return (
    <span className={className} aria-label={ariaLabel}>
      {display}
    </span>
  );
}

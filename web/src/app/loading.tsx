import { BrandedSplash } from '@/components/brand/branded-splash';

/**
 * Root App Router loading UI — the branded CertMate splash shown while the
 * first/streaming segment resolves. WS7 launch continuity with iOS
 * `RootView`'s branded loading view (see BrandedSplash). Client-side
 * navigations between already-loaded segments don't trigger this; it's the
 * cold-launch / slow-segment splash, replacing a flash of empty surface-0.
 */
export default function Loading() {
  return <BrandedSplash />;
}

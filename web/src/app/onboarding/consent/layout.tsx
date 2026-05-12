/**
 * Shell for /onboarding/consent — deliberately bare. No AppShell, no
 * sidebar, no nav chrome. The user has signed in but hasn't yet
 * accepted the BTA, so we don't paint surfaces that imply they're
 * already in the product.
 *
 * The page itself handles its own header / footer / brand chrome.
 */
export default function ConsentLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

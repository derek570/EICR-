import { redirect } from 'next/navigation';

/**
 * Root — middleware redirects unauthenticated users to /login, so
 * reaching this page means the user is signed in. Forward to dashboard.
 */
export default function RootRedirect() {
  redirect('/dashboard');
}

import { requireAdmin } from '@/lib/auth';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/**
 * Server-side guard for the entire /admin route segment.
 * If the visitor is not an authorized admin, redirect them home.
 * This runs on every request — no client-side bypass possible.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await requireAdmin();
  if (!admin) redirect('/?admin=forbidden');

  return <>{children}</>;
}

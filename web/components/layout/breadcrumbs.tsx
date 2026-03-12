'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronRight } from 'lucide-react';

const labelMap: Record<string, string> = {
  dashboard: 'Dashboard',
  job: 'Job',
  settings: 'Settings',
  staff: 'Staff',
  login: 'Login',
  installation: 'Installation',
  supply: 'Supply',
  board: 'Board',
  circuits: 'Circuits',
  observations: 'Observations',
  inspection: 'Inspection',
  'eic-inspection': 'EIC Inspection',
  defaults: 'Circuit Defaults',
  inspector: 'Inspector',
  extent: 'Extent & Type',
  design: 'Design',
  pdf: 'PDF',
  company: 'Company',
};

export function Breadcrumbs() {
  const pathname = usePathname();
  const segments = pathname.split('/').filter(Boolean);

  if (segments.length <= 1) return null;

  const crumbs = segments.map((segment, index) => {
    const href = '/' + segments.slice(0, index + 1).join('/');
    const label = labelMap[segment] || segment;
    const isLast = index === segments.length - 1;

    return (
      <li key={href} className="flex items-center gap-1.5">
        <ChevronRight className="h-3.5 w-3.5 text-gray-400" />
        {isLast ? (
          <span className="text-sm text-foreground font-medium">{label}</span>
        ) : (
          <Link href={href} className="text-sm text-muted-foreground hover:text-foreground">
            {label}
          </Link>
        )}
      </li>
    );
  });

  return (
    <nav className="px-6 py-2 border-b border-border bg-card/50">
      <ol className="flex items-center gap-1.5">{crumbs}</ol>
    </nav>
  );
}

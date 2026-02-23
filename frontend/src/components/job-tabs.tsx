"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import type { CertificateType } from "@/lib/api";

interface JobTabsProps {
  jobId: string;
  certificateType?: CertificateType;
}

interface Tab {
  name: string;
  href: string;
}

// EICR tabs (10 tabs - matching Streamlit UI)
const eicrTabs: Tab[] = [
  { name: "Overview", href: "" },
  { name: "Installation", href: "/installation" },
  { name: "Supply", href: "/supply" },
  { name: "Board", href: "/board" },
  { name: "Circuits", href: "/circuits" },
  { name: "Observations", href: "/observations" },
  { name: "Inspection", href: "/inspection" },
  { name: "Defaults", href: "/defaults" },
  { name: "Inspector", href: "/inspector" },
  { name: "History", href: "/history" },
  { name: "PDF", href: "/pdf" },
  { name: "Debug", href: "/debug" },
];

// EIC tabs (12 tabs - matching Streamlit UI + History)
const eicTabs: Tab[] = [
  { name: "Overview", href: "" },
  { name: "Installation", href: "/installation" },
  { name: "Extent & Type", href: "/extent" },
  { name: "Supply", href: "/supply" },
  { name: "Board", href: "/board" },
  { name: "Circuits", href: "/circuits" },
  { name: "Inspection", href: "/eic-inspection" },
  { name: "Design", href: "/design" },
  { name: "Defaults", href: "/defaults" },
  { name: "Inspector", href: "/inspector" },
  { name: "History", href: "/history" },
  { name: "PDF", href: "/pdf" },
  { name: "Debug", href: "/debug" },
];

function getTabsForType(type: CertificateType): Tab[] {
  return type === "EIC" ? eicTabs : eicrTabs;
}

export function JobTabs({ jobId, certificateType = "EICR" }: JobTabsProps) {
  const pathname = usePathname();
  const basePath = `/job/${jobId}`;
  const tabs = getTabsForType(certificateType);

  return (
    <div className="border-b">
      <nav className="flex overflow-x-auto -mb-px" aria-label="Tabs">
        {tabs.map((tab) => {
          const href = `${basePath}${tab.href}`;
          const isActive = pathname === href || (tab.href === "" && pathname === basePath);

          return (
            <Link
              key={tab.name}
              href={href}
              className={cn(
                "shrink-0 border-b-2 px-4 py-3 text-sm font-medium transition-colors whitespace-nowrap",
                isActive
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:border-slate-300 hover:text-foreground"
              )}
            >
              {tab.name}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

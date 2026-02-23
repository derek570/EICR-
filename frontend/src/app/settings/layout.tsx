"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Zap, ArrowLeft, Settings, FileText, CreditCard, UserCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { User } from "@/lib/api";
import { OfflineIndicator } from "@/components/offline-indicator";

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    const storedUser = localStorage.getItem("user");
    if (!storedUser) {
      router.push("/login");
      return;
    }
    setUser(JSON.parse(storedUser) as User);
  }, [router]);

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="bg-white border-b sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/dashboard">
              <Button variant="ghost" size="sm">
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back
              </Button>
            </Link>
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary">
                <Zap className="h-4 w-4 text-primary-foreground" />
              </div>
              <span className="font-semibold hidden sm:inline">Settings</span>
            </div>
          </div>
          <OfflineIndicator />
        </div>
      </header>

      {/* Tab navigation */}
      <nav className="bg-white border-b">
        <div className="max-w-7xl mx-auto px-4">
          <div className="flex gap-1">
            <Link href="/settings/defaults">
              <Button variant="ghost" className="rounded-none border-b-2 border-transparent data-[active=true]:border-primary">
                <FileText className="h-4 w-4 mr-2" />
                Circuit Defaults
              </Button>
            </Link>
            <Link href="/settings/company">
              <Button variant="ghost" className="rounded-none border-b-2 border-transparent data-[active=true]:border-primary">
                <Settings className="h-4 w-4 mr-2" />
                Company Info
              </Button>
            </Link>
            <Link href="/settings/inspectors">
              <Button variant="ghost" className="rounded-none border-b-2 border-transparent data-[active=true]:border-primary">
                <UserCheck className="h-4 w-4 mr-2" />
                Inspectors
              </Button>
            </Link>
            <Link href="/settings/billing">
              <Button variant="ghost" className="rounded-none border-b-2 border-transparent data-[active=true]:border-primary">
                <CreditCard className="h-4 w-4 mr-2" />
                Billing
              </Button>
            </Link>
          </div>
        </div>
      </nav>

      {/* Main content */}
      <main className="max-w-7xl mx-auto px-4 py-6">{children}</main>
    </div>
  );
}

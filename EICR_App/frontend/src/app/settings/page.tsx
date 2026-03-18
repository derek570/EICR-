"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function SettingsPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/settings/defaults");
  }, [router]);

  return (
    <div className="flex items-center justify-center py-12">
      <div className="animate-pulse text-muted-foreground">Redirecting...</div>
    </div>
  );
}

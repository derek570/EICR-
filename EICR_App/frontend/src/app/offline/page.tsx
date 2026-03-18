import { WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { ReloadButton } from "./reload-button";

export default function OfflinePage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
      <div className="text-center max-w-md">
        <div className="bg-amber-100 w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-6">
          <WifiOff className="h-10 w-10 text-amber-600" />
        </div>
        <h1 className="text-2xl font-bold text-slate-900 mb-2">
          You&apos;re Offline
        </h1>
        <p className="text-slate-600 mb-6">
          Some features require an internet connection. Jobs you&apos;ve previously opened are still available for editing.
        </p>
        <div className="space-y-3">
          <Link href="/dashboard" className="block">
            <Button className="w-full">
              Go to Dashboard
            </Button>
          </Link>
          <ReloadButton />
        </div>
      </div>
    </div>
  );
}

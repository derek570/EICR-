"use client";

import { Button } from "@/components/ui/button";

export function ReloadButton() {
  return (
    <Button
      variant="outline"
      className="w-full"
      onClick={() => window.location.reload()}
    >
      Try Again
    </Button>
  );
}

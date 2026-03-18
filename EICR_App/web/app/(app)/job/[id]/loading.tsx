import { Loader2 } from "lucide-react";

export default function JobLoading() {
  return (
    <div className="flex items-center justify-center min-h-[50vh]">
      <div className="text-center">
        <Loader2 className="h-8 w-8 animate-spin text-brand-blue mx-auto mb-3" />
        <p className="text-sm text-gray-500 dark:text-gray-400">Loading certificate...</p>
      </div>
    </div>
  );
}

"use client";

import { AlertTriangle, HelpCircle, X } from "lucide-react";

interface AlertQuestion {
  field: string;
  circuit?: number;
  question: string;
  type: "orphaned" | "out_of_range" | "unclear";
  value?: string;
}

interface AlertCardProps {
  question: AlertQuestion | null;
  onDismiss: () => void;
}

export function AlertCard({ question, onDismiss }: AlertCardProps) {
  if (!question) return null;

  const isOutOfRange = question.type === "out_of_range";
  const borderColor = isOutOfRange ? "border-amber-500/50" : "border-blue-500/50";

  const Icon = isOutOfRange ? AlertTriangle : HelpCircle;
  const iconColor = isOutOfRange ? "text-amber-400" : "text-blue-400";

  return (
    <div
      className={`mx-4 mb-2 bg-zinc-900/95 backdrop-blur-md rounded-xl border ${borderColor} p-3 shadow-lg animate-in slide-in-from-bottom-2 duration-300`}
    >
      <div className="flex items-start gap-3">
        <Icon className={`h-5 w-5 ${iconColor} shrink-0 mt-0.5`} />

        <div className="flex-1 min-w-0">
          <p className="text-sm text-zinc-200">{question.question}</p>
          {(question.value || question.field) && (
            <p className="text-xs mt-1">
              {question.value && (
                <span className="text-zinc-300">{question.value}</span>
              )}
              {question.value && question.field && (
                <span className="text-zinc-500"> &middot; </span>
              )}
              {question.field && (
                <span className="text-zinc-500">
                  {question.field}
                  {question.circuit != null && ` (circuit ${question.circuit})`}
                </span>
              )}
            </p>
          )}
        </div>

        <button
          onClick={onDismiss}
          className="text-zinc-500 hover:text-zinc-300 transition-colors shrink-0"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

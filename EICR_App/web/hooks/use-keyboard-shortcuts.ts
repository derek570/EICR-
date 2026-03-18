"use client";

import { useEffect, useRef } from "react";

export function useKeyboardShortcuts(
  handlers: Record<string, () => void>,
) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) {
        const key = `ctrl+${e.key.toLowerCase()}`;
        if (handlersRef.current[key]) {
          e.preventDefault();
          handlersRef.current[key]();
        }
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
}

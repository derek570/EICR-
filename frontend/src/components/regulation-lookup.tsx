'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { api, Regulation } from '@/lib/api';
import { Input } from '@/components/ui/input';
import { Search, BookOpen, X, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

interface RegulationLookupProps {
  onSelect: (regulation: Regulation) => void;
  onClose?: () => void;
  className?: string;
}

export function RegulationLookup({ onSelect, onClose, className }: RegulationLookupProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Regulation[]>([]);
  const [loading, setLoading] = useState(false);
  const [expandedRef, setExpandedRef] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Load initial results (first 20)
  useEffect(() => {
    const loadInitial = async () => {
      setLoading(true);
      try {
        const data = await api.searchRegulations('');
        setResults(data);
      } catch (error) {
        console.error('Failed to load regulations:', error);
      } finally {
        setLoading(false);
      }
    };
    loadInitial();
  }, []);

  const handleSearch = useCallback(async (searchQuery: string) => {
    setLoading(true);
    try {
      const data = await api.searchRegulations(searchQuery);
      setResults(data);
    } catch (error) {
      console.error('Failed to search regulations:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleQueryChange = (value: string) => {
    setQuery(value);

    // Debounced search (300ms)
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }
    debounceTimer.current = setTimeout(() => {
      handleSearch(value);
    }, 300);
  };

  // Cleanup debounce timer
  useEffect(() => {
    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
    };
  }, []);

  const handleSelect = (regulation: Regulation) => {
    onSelect(regulation);
    if (onClose) onClose();
  };

  const toggleExpand = (ref: string) => {
    setExpandedRef(expandedRef === ref ? null : ref);
  };

  return (
    <div className={cn('bg-white border rounded-lg shadow-lg overflow-hidden', className)}>
      {/* Header */}
      <div className="flex items-center gap-2 p-3 border-b bg-slate-50">
        <BookOpen className="h-4 w-4 text-blue-600 shrink-0" />
        <span className="text-sm font-medium text-slate-700">BS 7671 Regulation Lookup</span>
        {onClose && (
          <button
            onClick={onClose}
            className="ml-auto text-slate-400 hover:text-slate-600 min-h-[44px] min-w-[44px] flex items-center justify-center"
            aria-label="Close regulation lookup"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Search input */}
      <div className="p-3 border-b">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => handleQueryChange(e.target.value)}
            placeholder="Search by regulation number, keyword, or description..."
            className="pl-9"
          />
        </div>
      </div>

      {/* Results list */}
      <div className="max-h-[400px] overflow-y-auto">
        {loading && results.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">Searching...</div>
        ) : results.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">
            No regulations found for &ldquo;{query}&rdquo;
          </div>
        ) : (
          <div className="divide-y">
            {results.map((reg) => {
              const isExpanded = expandedRef === reg.ref;
              return (
                <div key={reg.ref} className="hover:bg-slate-50 transition-colors">
                  {/* Main row */}
                  <div
                    className="flex items-start gap-3 p-3 cursor-pointer min-h-[44px]"
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        toggleExpand(reg.ref);
                      }
                    }}
                    onClick={() => toggleExpand(reg.ref)}
                  >
                    <span className="inline-flex items-center justify-center h-7 min-w-[60px] px-2 rounded bg-blue-100 text-blue-800 text-xs font-mono font-semibold shrink-0">
                      {reg.ref}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-slate-800 leading-tight">
                        {reg.title}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                        {reg.description}
                      </p>
                    </div>
                    <ChevronRight
                      className={cn(
                        'h-4 w-4 text-slate-400 shrink-0 transition-transform mt-1',
                        isExpanded && 'rotate-90'
                      )}
                    />
                  </div>

                  {/* Expanded details */}
                  {isExpanded && (
                    <div className="px-3 pb-3 space-y-2">
                      <div className="ml-[72px] space-y-2">
                        {/* Section */}
                        <p className="text-xs text-muted-foreground">{reg.section}</p>

                        {/* Common observations */}
                        {reg.common_observations.length > 0 && (
                          <div>
                            <p className="text-xs font-medium text-slate-600 mb-1">
                              Common observations:
                            </p>
                            <ul className="text-xs text-slate-600 space-y-0.5">
                              {reg.common_observations.map((obs, i) => (
                                <li key={i} className="flex gap-1.5">
                                  <span className="text-slate-400 shrink-0">-</span>
                                  <span>{obs}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {/* Recommended action */}
                        <div className="bg-green-50 border border-green-200 rounded p-2">
                          <p className="text-xs font-medium text-green-800 mb-0.5">
                            Recommended action:
                          </p>
                          <p className="text-xs text-green-700">{reg.recommended_action}</p>
                        </div>

                        {/* Select button */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleSelect(reg);
                          }}
                          className="w-full text-center text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md py-2 transition-colors"
                        >
                          Use Regulation {reg.ref}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

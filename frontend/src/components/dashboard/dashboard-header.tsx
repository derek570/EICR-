'use client';

import Link from 'next/link';
import { Zap, Shield, LogOut, ChevronDown } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';

import { Button } from '@/components/ui/button';
import { OfflineIndicator } from '@/components/offline-indicator';

interface DashboardHeaderProps {
  userEmail?: string;
  userRole?: string;
  onLogout: () => void;
}

export function DashboardHeader({ userEmail, userRole, onLogout }: DashboardHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu on click outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    if (menuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [menuOpen]);

  return (
    <header className="glass-bg border-b border-white/8 sticky top-0 z-10 backdrop-blur-xl">
      <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between">
        {/* Logo / App Name */}
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-brand-blue to-brand-green shadow-[0_2px_8px_rgba(0,102,255,0.3)]">
            <Zap className="h-4 w-4 text-white" />
          </div>
          <span className="font-semibold gradient-text">CertMate</span>
        </div>

        {/* Right side */}
        <div className="flex items-center gap-2">
          <OfflineIndicator />

          {userRole === 'admin' && (
            <Link href="/admin">
              <Button variant="glass-outline" size="sm">
                <Shield className="h-4 w-4 mr-2 text-red-400" />
                Admin
              </Button>
            </Link>
          )}

          {/* User menu dropdown */}
          <div className="relative" ref={menuRef}>
            <Button
              variant="glass-ghost"
              size="sm"
              onClick={() => setMenuOpen(!menuOpen)}
              className="gap-1"
            >
              <span className="text-sm text-muted-foreground max-w-[120px] truncate hidden sm:inline">
                {userEmail}
              </span>
              <ChevronDown className="h-3 w-3" />
            </Button>

            {menuOpen && (
              <div className="absolute right-0 mt-1 w-48 rounded-[12px] glass-bg border border-white/8 shadow-[0_8px_32px_rgba(0,0,0,0.3)] py-1 z-20 backdrop-blur-xl">
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    onLogout();
                  }}
                  className="flex items-center gap-2 w-full px-3 py-2 text-sm text-red-400 hover:bg-white/8 rounded-lg mx-0 transition-colors"
                >
                  <LogOut className="h-4 w-4" />
                  Log out
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}

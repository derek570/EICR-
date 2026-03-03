'use client';

import Link from 'next/link';
import { Zap, Settings, Shield, LogOut, UserCheck, FileText, ChevronDown } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';

import { Button } from '@/components/ui/button';
import { OfflineIndicator } from '@/components/offline-indicator';

interface DashboardHeaderProps {
  userEmail?: string;
  userRole?: string;
  onShowInspectors: () => void;
  onShowDefaults: () => void;
  onLogout: () => void;
}

export function DashboardHeader({
  userEmail,
  userRole,
  onShowInspectors,
  onShowDefaults,
  onLogout,
}: DashboardHeaderProps) {
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
    <header className="bg-white border-b sticky top-0 z-10">
      <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
        {/* Logo / App Name */}
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary">
            <Zap className="h-4 w-4 text-primary-foreground" />
          </div>
          <span className="font-semibold hidden sm:inline">CertMate</span>
        </div>

        {/* Right side: nav + menu */}
        <div className="flex items-center gap-2">
          <OfflineIndicator />

          {userRole === 'admin' && (
            <Link href="/admin">
              <Button variant="outline" size="sm">
                <Shield className="h-4 w-4 mr-2 text-red-600" />
                Admin
              </Button>
            </Link>
          )}

          <Link href="/settings">
            <Button variant="ghost" size="sm">
              <Settings className="h-4 w-4" />
              <span className="hidden sm:inline ml-2">Settings</span>
            </Button>
          </Link>

          {/* User menu dropdown */}
          <div className="relative" ref={menuRef}>
            <Button
              variant="ghost"
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
              <div className="absolute right-0 mt-1 w-48 rounded-md bg-white border shadow-lg py-1 z-20">
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    onShowInspectors();
                  }}
                  className="flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-slate-50"
                >
                  <UserCheck className="h-4 w-4 text-muted-foreground" />
                  Inspectors
                </button>
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    onShowDefaults();
                  }}
                  className="flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-slate-50"
                >
                  <FileText className="h-4 w-4 text-muted-foreground" />
                  Circuit Defaults
                </button>
                <div className="border-t my-1" />
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    onLogout();
                  }}
                  className="flex items-center gap-2 w-full px-3 py-2 text-sm text-red-600 hover:bg-red-50"
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

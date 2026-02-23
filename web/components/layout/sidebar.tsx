"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Settings,
  UserCheck,
  Building2,
  ChevronLeft,
  ChevronRight,
  Zap,
  Users,
  Calendar,
  Sun,
  Moon,
  Monitor,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useTheme } from "@/hooks/use-theme";
import type { Theme } from "@/hooks/use-theme";

const navItems = [
  { href: "/dashboard", icon: LayoutDashboard, label: "Dashboard" },
  { href: "/clients", icon: Users, label: "Clients" },
  { href: "/calendar", icon: Calendar, label: "Calendar" },
  { href: "/settings", icon: Settings, label: "Settings" },
  { href: "/settings/inspector", icon: UserCheck, label: "Inspector" },
  { href: "/settings/company", icon: Building2, label: "Company" },
];

const themeOptions: { value: Theme; icon: typeof Sun; label: string }[] = [
  { value: "light", icon: Sun, label: "Light" },
  { value: "dark", icon: Moon, label: "Dark" },
  { value: "system", icon: Monitor, label: "System" },
];

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);
  const pathname = usePathname();
  const { theme, setTheme } = useTheme();

  const cycleTheme = () => {
    const order: Theme[] = ["light", "dark", "system"];
    const idx = order.indexOf(theme);
    setTheme(order[(idx + 1) % order.length]);
  };

  const currentThemeOption = themeOptions.find((t) => t.value === theme) ?? themeOptions[2];
  const ThemeIcon = currentThemeOption.icon;

  return (
    <aside
      className={cn(
        "flex flex-col h-screen bg-brand-navy text-white transition-all duration-200 ease-in-out flex-shrink-0",
        collapsed ? "w-16" : "w-60",
      )}
    >
      {/* Logo */}
      <div className="flex items-center gap-3 px-4 h-16 border-b border-white/10">
        <Zap className="h-6 w-6 text-brand-blue flex-shrink-0" />
        {!collapsed && (
          <span className="text-lg font-semibold whitespace-nowrap">CertMate</span>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-4 space-y-1 px-2">
        {navItems.map((item) => {
          // Exact match for /settings (don't highlight for /settings/inspector or /settings/company)
          const isActive =
            item.href === "/settings"
              ? pathname === "/settings"
              : pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
                isActive
                  ? "bg-white/15 text-white"
                  : "text-white/70 hover:bg-white/10 hover:text-white",
                collapsed && "justify-center px-2",
              )}
              title={collapsed ? item.label : undefined}
            >
              <item.icon className="h-5 w-5 flex-shrink-0" />
              {!collapsed && <span>{item.label}</span>}
            </Link>
          );
        })}
      </nav>

      {/* Theme toggle */}
      <button
        onClick={cycleTheme}
        className={cn(
          "flex items-center gap-3 mx-2 mb-2 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
          "text-white/70 hover:bg-white/10 hover:text-white",
          collapsed && "justify-center px-2",
        )}
        title={collapsed ? `Theme: ${currentThemeOption.label}` : undefined}
      >
        <ThemeIcon className="h-5 w-5 flex-shrink-0" />
        {!collapsed && <span>{currentThemeOption.label}</span>}
      </button>

      {/* Collapse toggle */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="flex items-center justify-center h-12 border-t border-white/10 text-white/50 hover:text-white hover:bg-white/5 transition-colors"
      >
        {collapsed ? (
          <ChevronRight className="h-5 w-5" />
        ) : (
          <ChevronLeft className="h-5 w-5" />
        )}
      </button>
    </aside>
  );
}

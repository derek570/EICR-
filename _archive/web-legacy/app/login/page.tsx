'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { Loader2, Mic, FileCheck, Send, ArrowRight } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CertMateLogo } from '@/components/brand/certmate-logo';
import { api } from '@/lib/api-client';
import { setAuth } from '@/lib/auth';

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-[#0B1120]">
          <Loader2 className="h-8 w-8 animate-spin text-blue-400" />
        </div>
      }
    >
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!email.trim() || !password.trim()) {
      toast.error('Please enter email and password');
      return;
    }

    setIsLoading(true);
    try {
      const result = await api.login(email, password);
      setAuth(result.token, result.user);
      toast.success('Welcome back!');
      const redirect = searchParams.get('redirect') || '/dashboard';
      router.push(redirect);
    } catch {
      toast.error('Invalid email or password');
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex">
      {/* Left side — Hero / Branding */}
      <div className="hidden lg:flex lg:w-[55%] relative bg-[#0B1120] flex-col items-center justify-center p-12 overflow-hidden">
        {/* Background gradient orbs */}
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-blue-600/20 rounded-full blur-[120px]" />
        <div className="absolute bottom-1/4 right-1/4 w-80 h-80 bg-green-500/15 rounded-full blur-[100px]" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-64 h-64 bg-cyan-400/10 rounded-full blur-[80px]" />

        {/* Content */}
        <div className="relative z-10 max-w-lg text-center">
          {/* Animated icon */}
          <div className="mx-auto mb-8 relative">
            <div className="w-32 h-32 mx-auto rounded-3xl bg-gradient-to-br from-blue-500/20 to-green-500/20 backdrop-blur-sm border border-white/10 flex items-center justify-center shadow-2xl shadow-blue-500/20">
              <svg
                width="72"
                height="72"
                viewBox="0 0 40 40"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <defs>
                  <linearGradient id="hero-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#60A5FA" />
                    <stop offset="100%" stopColor="#4ADE80" />
                  </linearGradient>
                </defs>
                <path
                  d="M3 9C3 5.134 6.134 2 10 2H30C33.866 2 37 5.134 37 9V25C37 28.866 33.866 32 30 32H23L20 37L17 32H10C6.134 32 3 28.866 3 25V9Z"
                  fill="url(#hero-grad)"
                  opacity="0.15"
                />
                <path
                  d="M3 9C3 5.134 6.134 2 10 2H30C33.866 2 37 5.134 37 9V25C37 28.866 33.866 32 30 32H23L20 37L17 32H10C6.134 32 3 28.866 3 25V9Z"
                  stroke="url(#hero-grad)"
                  strokeWidth="1.5"
                  fill="none"
                />
                <rect x="16" y="8" width="8" height="13" rx="4" fill="url(#hero-grad)" />
                <path
                  d="M13 17.5C13 21.642 16.134 24 20 24C23.866 24 27 21.642 27 17.5"
                  stroke="url(#hero-grad)"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  fill="none"
                />
                <line
                  x1="20"
                  y1="24"
                  x2="20"
                  y2="27"
                  stroke="url(#hero-grad)"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
                <circle cx="31" cy="8" r="5.5" fill="#4ADE80" />
                <path
                  d="M28.5 8L30 9.5L33.5 6"
                  stroke="white"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            {/* Pulse ring */}
            <div
              className="absolute inset-0 w-32 h-32 mx-auto rounded-3xl border border-blue-400/30 animate-ping opacity-20"
              style={{ animationDuration: '3s' }}
            />
          </div>

          <h1 className="text-4xl font-bold text-white mb-3 tracking-tight">
            Talk.{' '}
            <span className="bg-gradient-to-r from-blue-400 via-cyan-300 to-green-400 bg-clip-text text-transparent">
              Certify.
            </span>{' '}
            Done.
          </h1>
          <p className="text-lg text-white/60 mb-10 leading-relaxed">
            Speak your inspection findings — CertMate fills out the certificate so it&apos;s ready
            to send before you leave site.
          </p>

          {/* Feature pills */}
          <div className="flex flex-wrap justify-center gap-3">
            {[
              { icon: Mic, label: 'Voice-powered', desc: 'Just talk naturally' },
              { icon: FileCheck, label: 'AI extraction', desc: 'Fills forms instantly' },
              { icon: Send, label: 'Send on-site', desc: 'PDF ready to go' },
            ].map((f) => (
              <div
                key={f.label}
                className="flex items-center gap-3 px-4 py-3 rounded-xl bg-white/5 border border-white/10 backdrop-blur-sm"
              >
                <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-blue-500/20 to-green-500/20 flex items-center justify-center">
                  <f.icon className="h-4 w-4 text-blue-400" />
                </div>
                <div className="text-left">
                  <div className="text-sm font-medium text-white">{f.label}</div>
                  <div className="text-xs text-white/40">{f.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Bottom badge */}
        <div className="absolute bottom-8 text-xs text-white/30 flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full bg-green-400/60" />
          Built for UK electrical inspectors
        </div>
      </div>

      {/* Right side — Login form */}
      <div className="flex-1 flex flex-col items-center justify-center p-8 bg-[#0F172A]">
        <div className="w-full max-w-sm">
          {/* Mobile logo */}
          <div className="lg:hidden mb-8 flex justify-center">
            <CertMateLogo size="lg" />
          </div>

          <div className="mb-8">
            <h2 className="text-2xl font-bold text-white">Welcome back</h2>
            <p className="text-sm text-gray-400 mt-1">Sign in to manage your certificates</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="email" className="text-sm font-medium text-gray-300">
                Email
              </Label>
              <Input
                id="email"
                type="email"
                placeholder="you@example.com"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={isLoading}
                className="h-11 bg-white/5 border-white/10 text-white placeholder:text-gray-500"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password" className="text-sm font-medium text-gray-300">
                Password
              </Label>
              <Input
                id="password"
                type="password"
                placeholder="Enter your password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={isLoading}
                className="h-11 bg-white/5 border-white/10 text-white placeholder:text-gray-500"
              />
            </div>
            <Button
              type="submit"
              className="w-full h-11 bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-700 hover:to-blue-600 text-white font-medium shadow-lg shadow-blue-500/25"
              disabled={isLoading}
            >
              {isLoading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Signing in...
                </>
              ) : (
                <>
                  Sign in
                  <ArrowRight className="ml-2 h-4 w-4" />
                </>
              )}
            </Button>
          </form>

          <div className="mt-8 text-center text-xs text-gray-500 space-y-1">
            <p>CertMate &middot; certmate.co.uk</p>
            <p>
              <a href="/legal/terms" className="hover:text-gray-300 transition-colors">
                Terms
              </a>
              {' · '}
              <a href="/legal/privacy" className="hover:text-gray-300 transition-colors">
                Privacy
              </a>
              {' · '}
              <a href="/legal/eula" className="hover:text-gray-300 transition-colors">
                EULA
              </a>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

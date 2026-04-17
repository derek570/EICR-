'use client';

import Link from 'next/link';
import {
  Mic,
  FileCheck,
  Send,
  Shield,
  Zap,
  ChevronRight,
  CheckCircle2,
  Smartphone,
  Globe,
} from 'lucide-react';
import { CertMateLogoWhite, CertMateLogo, WaveformBars } from '@/components/brand/certmate-logo';

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-[#0B1120] text-white overflow-x-hidden">
      {/* ─── Nav ─── */}
      <nav className="relative z-20 flex items-center justify-between px-6 md:px-12 py-5">
        <CertMateLogoWhite size="md" />
        <div className="flex items-center gap-4">
          <Link
            href="/legal/terms"
            className="hidden sm:inline text-sm text-white/50 hover:text-white/80 transition-colors"
          >
            Legal
          </Link>
          <Link
            href="/login"
            className="px-5 py-2.5 rounded-lg bg-white/10 border border-white/10 text-sm font-medium hover:bg-white/20 transition-all"
          >
            Sign in
          </Link>
        </div>
      </nav>

      {/* ─── Hero ─── */}
      <section className="relative px-6 md:px-12 pt-12 pb-24 md:pt-20 md:pb-32">
        {/* Background gradient orbs */}
        <div className="absolute top-0 left-1/4 w-[600px] h-[600px] bg-blue-600/20 rounded-full blur-[160px] pointer-events-none" />
        <div className="absolute bottom-0 right-1/4 w-[500px] h-[500px] bg-green-500/15 rounded-full blur-[140px] pointer-events-none" />
        <div className="absolute top-1/3 right-1/3 w-[400px] h-[400px] bg-cyan-400/10 rounded-full blur-[120px] pointer-events-none" />

        <div className="relative z-10 max-w-4xl mx-auto text-center">
          {/* Badge */}
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-white/5 border border-white/10 mb-8">
            <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
            <span className="text-xs text-white/70 font-medium">
              Built for UK electrical inspectors
            </span>
          </div>

          {/* Animated icon */}
          <div className="mx-auto mb-10 relative w-40 h-40">
            <div className="w-40 h-40 rounded-3xl bg-gradient-to-br from-blue-500/20 to-green-500/20 backdrop-blur-sm border border-white/10 flex items-center justify-center shadow-2xl shadow-blue-500/20">
              <svg
                width="88"
                height="88"
                viewBox="0 0 40 40"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <defs>
                  <linearGradient id="landing-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#60A5FA" />
                    <stop offset="100%" stopColor="#4ADE80" />
                  </linearGradient>
                </defs>
                <path
                  d="M3 9C3 5.134 6.134 2 10 2H30C33.866 2 37 5.134 37 9V25C37 28.866 33.866 32 30 32H23L20 37L17 32H10C6.134 32 3 28.866 3 25V9Z"
                  fill="url(#landing-grad)"
                  opacity="0.15"
                />
                <path
                  d="M3 9C3 5.134 6.134 2 10 2H30C33.866 2 37 5.134 37 9V25C37 28.866 33.866 32 30 32H23L20 37L17 32H10C6.134 32 3 28.866 3 25V9Z"
                  stroke="url(#landing-grad)"
                  strokeWidth="1.5"
                  fill="none"
                />
                <rect x="16" y="8" width="8" height="13" rx="4" fill="url(#landing-grad)" />
                <path
                  d="M13 17.5C13 21.642 16.134 24 20 24C23.866 24 27 21.642 27 17.5"
                  stroke="url(#landing-grad)"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  fill="none"
                />
                <line
                  x1="20"
                  y1="24"
                  x2="20"
                  y2="27"
                  stroke="url(#landing-grad)"
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
              className="absolute inset-0 rounded-3xl border border-blue-400/30 animate-ping opacity-20"
              style={{ animationDuration: '3s' }}
            />
          </div>

          <h1 className="text-5xl md:text-7xl font-bold tracking-tight mb-6">
            Talk.{' '}
            <span className="bg-gradient-to-r from-blue-400 via-cyan-300 to-green-400 bg-clip-text text-transparent">
              Certify.
            </span>{' '}
            Done.
          </h1>

          <p className="text-xl md:text-2xl text-white/60 max-w-2xl mx-auto mb-10 leading-relaxed">
            Speak your inspection findings on-site — CertMate fills out the EICR certificate so
            it&apos;s ready to send before you leave.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link
              href="/login"
              className="group flex items-center gap-2 px-8 py-4 rounded-xl bg-gradient-to-r from-blue-600 to-blue-500 text-white font-semibold shadow-lg shadow-blue-500/25 hover:shadow-blue-500/40 hover:scale-[1.02] transition-all"
            >
              Get started
              <ChevronRight className="h-5 w-5 group-hover:translate-x-0.5 transition-transform" />
            </Link>
            <Link
              href="#how-it-works"
              className="flex items-center gap-2 px-8 py-4 rounded-xl bg-white/5 border border-white/10 text-white/80 font-medium hover:bg-white/10 transition-all"
            >
              See how it works
            </Link>
          </div>
        </div>
      </section>

      {/* ─── How It Works ─── */}
      <section id="how-it-works" className="relative px-6 md:px-12 py-24 bg-[#0D1424]">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold mb-4">
              Three steps to a completed certificate
            </h2>
            <p className="text-lg text-white/50 max-w-xl mx-auto">
              No more scribbling notes then typing them up back at the office.
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-8">
            {[
              {
                step: '01',
                icon: Mic,
                title: 'Talk through the inspection',
                desc: 'Walk the site and narrate what you see. CertMate records and transcribes in real-time using Deepgram.',
                gradient: 'from-blue-500 to-blue-600',
              },
              {
                step: '02',
                icon: Zap,
                title: 'AI fills the certificate',
                desc: 'Claude Sonnet extracts every field — circuits, observations, test results — into the correct BS 7671 format.',
                gradient: 'from-cyan-500 to-cyan-600',
              },
              {
                step: '03',
                icon: Send,
                title: 'Review & send on-site',
                desc: 'Check the pre-filled certificate, make any tweaks, generate the PDF and email it — all before you leave.',
                gradient: 'from-green-500 to-green-600',
              },
            ].map((item) => (
              <div
                key={item.step}
                className="relative group p-8 rounded-2xl bg-white/[0.03] border border-white/[0.06] hover:border-white/10 transition-all"
              >
                <div className="text-xs font-mono text-white/20 mb-4">{item.step}</div>
                <div
                  className={`w-12 h-12 rounded-xl bg-gradient-to-br ${item.gradient} flex items-center justify-center mb-5 shadow-lg`}
                >
                  <item.icon className="h-6 w-6 text-white" />
                </div>
                <h3 className="text-lg font-semibold mb-3">{item.title}</h3>
                <p className="text-sm text-white/50 leading-relaxed">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── Features ─── */}
      <section className="relative px-6 md:px-12 py-24">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold mb-4">Built for how you actually work</h2>
            <p className="text-lg text-white/50 max-w-xl mx-auto">
              Every feature designed around the reality of being on-site with your hands full.
            </p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {[
              {
                icon: Mic,
                title: 'Voice-first input',
                desc: 'Speak naturally about what you see — no templates to fill in. AI understands electrical terminology.',
              },
              {
                icon: FileCheck,
                title: 'BS 7671 compliant',
                desc: 'Certificates auto-populated to the 18th Edition wiring regulations standard.',
              },
              {
                icon: Smartphone,
                title: 'iOS app + web dashboard',
                desc: 'Capture on your iPhone on-site. Review and manage certificates on any device.',
              },
              {
                icon: Shield,
                title: 'Photo analysis',
                desc: 'Snap the consumer unit — GPT Vision reads make, model, RCD types and way count automatically.',
              },
              {
                icon: Zap,
                title: 'Instant extraction',
                desc: 'AI processes your voice recording in seconds, not hours. Circuits, observations, test results — all populated.',
              },
              {
                icon: Globe,
                title: 'Send from site',
                desc: 'Generate the PDF and email to the client or landlord before you pack up your tools.',
              },
            ].map((feature) => (
              <div
                key={feature.title}
                className="p-6 rounded-xl bg-white/[0.03] border border-white/[0.06] hover:border-white/10 transition-all"
              >
                <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-blue-500/20 to-green-500/20 flex items-center justify-center mb-4">
                  <feature.icon className="h-5 w-5 text-blue-400" />
                </div>
                <h3 className="text-base font-semibold mb-2">{feature.title}</h3>
                <p className="text-sm text-white/45 leading-relaxed">{feature.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── Workflow Visual ─── */}
      <section className="relative px-6 md:px-12 py-24 bg-[#0D1424]">
        <div className="max-w-3xl mx-auto text-center">
          <h2 className="text-3xl md:text-4xl font-bold mb-6">From voice to PDF in minutes</h2>
          <p className="text-lg text-white/50 mb-12 max-w-xl mx-auto">
            Here&apos;s what a typical inspection looks like with CertMate.
          </p>

          <div className="space-y-6 text-left">
            {[
              {
                time: '09:00',
                label: 'Arrive on-site',
                detail: 'Open CertMate, tap "New Inspection"',
              },
              {
                time: '09:02',
                label: 'Photo the consumer unit',
                detail: 'AI reads make, model, ways, RCD types instantly',
              },
              {
                time: '09:05',
                label: 'Start talking',
                detail: '"Main switch is an 80-amp double-pole isolator…"',
              },
              {
                time: '09:30',
                label: 'Inspection complete',
                detail: 'Stop recording — AI extracts all fields in ~30 seconds',
              },
              {
                time: '09:32',
                label: 'Review certificate',
                detail: 'Quick check, tweak any values, add your signature',
              },
              {
                time: '09:35',
                label: 'Send PDF',
                detail: 'Email to client and landlord — done before you leave',
              },
            ].map((step, i) => (
              <div key={i} className="flex gap-4 items-start">
                <div className="w-16 flex-shrink-0 text-right">
                  <span className="text-sm font-mono text-white/30">{step.time}</span>
                </div>
                <div className="relative flex flex-col items-center">
                  <div className="w-3 h-3 rounded-full bg-gradient-to-br from-blue-400 to-green-400 z-10" />
                  {i < 5 && <div className="w-px h-full bg-white/10 absolute top-3" />}
                </div>
                <div className="pb-6">
                  <div className="text-base font-medium">{step.label}</div>
                  <div className="text-sm text-white/40">{step.detail}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── CTA ─── */}
      <section className="relative px-6 md:px-12 py-24">
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-blue-600/5 to-transparent pointer-events-none" />
        <div className="relative z-10 max-w-2xl mx-auto text-center">
          <h2 className="text-3xl md:text-4xl font-bold mb-4">
            Stop writing up certificates at the office
          </h2>
          <p className="text-lg text-white/50 mb-8">
            Join the sparks who are sending completed EICRs before they leave site.
          </p>
          <Link
            href="/login"
            className="group inline-flex items-center gap-2 px-8 py-4 rounded-xl bg-gradient-to-r from-blue-600 to-blue-500 text-white font-semibold shadow-lg shadow-blue-500/25 hover:shadow-blue-500/40 hover:scale-[1.02] transition-all"
          >
            Sign in to CertMate
            <ChevronRight className="h-5 w-5 group-hover:translate-x-0.5 transition-transform" />
          </Link>
        </div>
      </section>

      {/* ─── Footer ─── */}
      <footer className="px-6 md:px-12 py-10 border-t border-white/5">
        <div className="max-w-5xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <CertMateLogoWhite size="sm" />
            <span className="text-xs text-white/30">by Beckley Electrical</span>
          </div>
          <div className="flex items-center gap-6 text-xs text-white/30">
            <Link href="/legal/terms" className="hover:text-white/60 transition-colors">
              Terms & Conditions
            </Link>
            <Link href="/legal/privacy" className="hover:text-white/60 transition-colors">
              Privacy Policy
            </Link>
            <Link href="/legal/eula" className="hover:text-white/60 transition-colors">
              EULA
            </Link>
          </div>
          <div className="text-xs text-white/20">
            &copy; {new Date().getFullYear()} Beckley Electrical Ltd
          </div>
        </div>
      </footer>
    </div>
  );
}

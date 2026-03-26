'use client';

/**
 * CertMate brand logo components — speech-bubble-with-microphone icon
 * combined with the CertMate wordmark. Three variants:
 *   <CertMateLogo />       — full horizontal logo (sidebar expanded, login)
 *   <CertMateIcon />       — icon-only (sidebar collapsed, favicon)
 *   <CertMateLogoWhite />  — white variant for dark backgrounds
 */

import { cn } from '@/lib/utils';

interface LogoProps {
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}

const sizes = {
  sm: { icon: 28, text: 14, tag: 7, gap: 8 },
  md: { icon: 36, text: 18, tag: 9, gap: 10 },
  lg: { icon: 48, text: 24, tag: 11, gap: 14 },
};

function MicBubbleIcon({ size = 36, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <defs>
        <linearGradient id="cm-icon-grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#3B82F6" />
          <stop offset="100%" stopColor="#22C55E" />
        </linearGradient>
        <filter id="cm-glow">
          <feGaussianBlur stdDeviation="1.2" result="blur" />
          <feComposite in="SourceGraphic" in2="blur" operator="over" />
        </filter>
      </defs>
      <g filter="url(#cm-glow)">
        {/* Speech bubble */}
        <path
          d="M3 9C3 5.134 6.134 2 10 2H30C33.866 2 37 5.134 37 9V25C37 28.866 33.866 32 30 32H23L20 37L17 32H10C6.134 32 3 28.866 3 25V9Z"
          fill="url(#cm-icon-grad)"
          opacity="0.15"
        />
        <path
          d="M3 9C3 5.134 6.134 2 10 2H30C33.866 2 37 5.134 37 9V25C37 28.866 33.866 32 30 32H23L20 37L17 32H10C6.134 32 3 28.866 3 25V9Z"
          stroke="url(#cm-icon-grad)"
          strokeWidth="2"
          fill="none"
        />
        {/* Microphone body */}
        <rect x="16" y="8" width="8" height="13" rx="4" fill="url(#cm-icon-grad)" />
        {/* Microphone arc */}
        <path
          d="M13 17.5C13 21.642 16.134 24 20 24C23.866 24 27 21.642 27 17.5"
          stroke="url(#cm-icon-grad)"
          strokeWidth="2"
          strokeLinecap="round"
          fill="none"
        />
        {/* Microphone stand */}
        <line
          x1="20"
          y1="24"
          x2="20"
          y2="27"
          stroke="url(#cm-icon-grad)"
          strokeWidth="2"
          strokeLinecap="round"
        />
        {/* Green checkmark badge */}
        <circle cx="31" cy="8" r="5.5" fill="#22C55E" />
        <path
          d="M28.5 8L30 9.5L33.5 6"
          stroke="white"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
}

export function CertMateIcon({ className, size = 'md' }: LogoProps) {
  const s = sizes[size];
  return <MicBubbleIcon size={s.icon} className={className} />;
}

export function CertMateLogo({ className, size = 'md' }: LogoProps) {
  const s = sizes[size];
  return (
    <div className={cn('flex items-center', className)} style={{ gap: s.gap }}>
      <MicBubbleIcon size={s.icon} />
      <div className="flex flex-col leading-tight">
        <span className="font-bold tracking-tight" style={{ fontSize: s.text }}>
          Cert
          <span className="bg-gradient-to-r from-blue-500 via-cyan-400 to-green-400 bg-clip-text text-transparent">
            Mate
          </span>
        </span>
      </div>
    </div>
  );
}

export function CertMateLogoWhite({ className, size = 'md' }: LogoProps) {
  const s = sizes[size];
  return (
    <div className={cn('flex items-center', className)} style={{ gap: s.gap }}>
      <MicBubbleIcon size={s.icon} />
      <div className="flex flex-col leading-tight">
        <span className="font-bold tracking-tight text-white" style={{ fontSize: s.text }}>
          Cert
          <span className="bg-gradient-to-r from-blue-400 via-cyan-300 to-green-400 bg-clip-text text-transparent">
            Mate
          </span>
        </span>
      </div>
    </div>
  );
}

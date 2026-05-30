"use client";

// WinkTerm Logo — shared icon
export function WinkTermLogo({ size = 24, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox="-45 -40 90 80"
      width={size}
      height={size}
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
    >
      {/* Outer ring */}
      <ellipse cx="0" cy="0" rx="38" ry="16" />
      {/* Upper arc */}
      <path d="M-38,0 Q-10,-28 0,-28 Q10,-28 38,0" />
      {/* Eye */}
      <circle cx="8" cy="-8" r="7" fill="currentColor" stroke="none" />
      {/* Highlight */}
      <path d="M-20,-22 Q-14,-32 -6,-30" strokeWidth="2.5" />
    </svg>
  );
}

// Small size variant (tabs, etc.)
export function WinkTermIcon({ size = 16, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox="-45 -40 90 80"
      width={size}
      height={size}
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
    >
      <ellipse cx="0" cy="0" rx="38" ry="16" />
      <path d="M-38,0 Q-10,-28 0,-28 Q10,-28 38,0" />
      <circle cx="8" cy="-8" r="7" fill="currentColor" stroke="none" />
      <path d="M-20,-22 Q-14,-32 -6,-30" strokeWidth="2.5" />
    </svg>
  );
}

"use client";

// WinkTerm Logo - 统一图标
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
      {/* 外圈 */}
      <ellipse cx="0" cy="0" rx="38" ry="16" />
      {/* 上弧 */}
      <path d="M-38,0 Q-10,-28 0,-28 Q10,-28 38,0" />
      {/* 眼睛 */}
      <circle cx="8" cy="-8" r="7" fill="currentColor" stroke="none" />
      {/* 高光 */}
      <path d="M-20,-22 Q-14,-32 -6,-30" strokeWidth="2.5" />
    </svg>
  );
}

// 小尺寸版本（用于标签等）
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

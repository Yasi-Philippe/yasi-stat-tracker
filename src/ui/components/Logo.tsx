import { useId } from 'react';

/** The Trazo mark: one stroke rising to a lit point. Colours follow the theme. */
export function Mark({ size = 28, animated = false }: { size?: number; animated?: boolean }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden className={animated ? 'mark animated' : 'mark'}>
      <defs>
        <linearGradient id={`ink${id}`} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="var(--accent-2)" />
          <stop offset="1" stopColor="var(--accent)" />
        </linearGradient>
      </defs>
      <path
        className="mark-stroke"
        d="M98 344 C 146 344, 158 266, 210 274 C 262 282, 262 356, 318 334 C 356 319, 366 230, 396 168"
        fill="none"
        stroke={`url(#ink${id})`}
        strokeWidth="46"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="396" cy="168" r="62" fill="var(--accent)" opacity="0.2" className="mark-halo" />
      <circle cx="396" cy="168" r="36" fill="var(--accent)" className="mark-dot" />
    </svg>
  );
}

export function Wordmark({ size = 26 }: { size?: number }) {
  return (
    <span className="wordmark" style={{ fontSize: size }}>
      <Mark size={size * 1.15} />
      <span className="display">
        <em>trazo</em>
      </span>
    </span>
  );
}

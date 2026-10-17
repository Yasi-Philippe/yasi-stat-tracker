import { useId, useMemo } from 'react';

/** A light SVG sparkline for cards. Points are [x, y]; x ascending. */
export function Sparkline({
  points,
  width = 160,
  height = 44,
  color = 'var(--accent)',
  fill = true,
  dot = true,
  strokeWidth = 2,
}: {
  points: Array<[number, number]>;
  width?: number;
  height?: number;
  color?: string;
  fill?: boolean;
  dot?: boolean;
  strokeWidth?: number;
}) {
  const id = useId().replace(/:/g, '');
  const geo = useMemo(() => {
    if (points.length < 2) return null;
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs);
    let y0 = Math.min(...ys);
    let y1 = Math.max(...ys);
    if (y1 - y0 < 1e-9) {
      y0 -= 1;
      y1 += 1;
    }
    const pad = strokeWidth + 3;
    const sx = (x: number) => pad + ((x - x0) / Math.max(x1 - x0, 1)) * (width - pad * 2);
    const sy = (y: number) => pad + (1 - (y - y0) / (y1 - y0)) * (height - pad * 2);
    const pts = points.map(([x, y]) => [sx(x), sy(y)] as const);
    // Smooth with a light Catmull-Rom → Bézier pass.
    let d = `M${pts[0]![0].toFixed(1)},${pts[0]![1].toFixed(1)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(i - 1, 0)]!;
      const p1 = pts[i]!;
      const p2 = pts[i + 1]!;
      const p3 = pts[Math.min(i + 2, pts.length - 1)]!;
      const c1x = p1[0] + (p2[0] - p0[0]) / 6;
      const c1y = p1[1] + (p2[1] - p0[1]) / 6;
      const c2x = p2[0] - (p3[0] - p1[0]) / 6;
      const c2y = p2[1] - (p3[1] - p1[1]) / 6;
      d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
    }
    const last = pts[pts.length - 1]!;
    const area = `${d} L${last[0].toFixed(1)},${height} L${pts[0]![0].toFixed(1)},${height} Z`;
    return { d, area, last };
  }, [points, width, height, strokeWidth]);

  if (!geo) return <svg width={width} height={height} aria-hidden />;
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden className="sparkline">
      <defs>
        <linearGradient id={`sf${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.28" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {fill && <path d={geo.area} fill={`url(#sf${id})`} />}
      <path d={geo.d} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      {dot && <circle cx={geo.last[0]} cy={geo.last[1]} r={3.2} fill={color} />}
    </svg>
  );
}

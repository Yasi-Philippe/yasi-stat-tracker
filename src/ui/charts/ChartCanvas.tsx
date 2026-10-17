import { useEffect, useRef } from 'react';
import { type ECharts, echarts, type EChartsOption } from './echarts';

export interface ZoomEvent {
  /** Visible range in axis units (ms for time axes, index for categories). */
  startValue: number | null;
  endValue: number | null;
}

/** An ECharts canvas that follows its container size and the given option. */
export function ChartCanvas({
  option,
  height,
  onReady,
  onZoom,
  className,
}: {
  option: EChartsOption;
  height: number | string;
  onReady?: (chart: ECharts) => void;
  onZoom?: (e: ZoomEvent) => void;
  className?: string;
}) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<ECharts | null>(null);
  const zoomRef = useRef(onZoom);
  zoomRef.current = onZoom;

  useEffect(() => {
    const node = el.current!;
    const c = echarts.init(node, null, { renderer: 'canvas', devicePixelRatio: Math.min(window.devicePixelRatio || 1, 3) });
    chart.current = c;
    const ro = new ResizeObserver(() => c.resize({ animation: { duration: 0 } }));
    ro.observe(node);
    c.on('datazoom', () => {
      const dz = (c.getOption() as { dataZoom?: Array<{ startValue?: number; endValue?: number }> }).dataZoom?.[0];
      zoomRef.current?.({ startValue: dz?.startValue ?? null, endValue: dz?.endValue ?? null });
    });
    onReady?.(c);
    return () => {
      ro.disconnect();
      c.dispose();
      chart.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    chart.current?.setOption(option, { notMerge: true, lazyUpdate: true });
  }, [option]);

  return <div ref={el} className={className} style={{ height, width: '100%' }} />;
}

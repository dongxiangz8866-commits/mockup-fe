import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  getSnapshot,
  parseTotalMs,
  subscribe,
  type PerfSnapshot,
} from './perfBus';

export type DragFps = {
  fps: number | null; // smoothed live fps (null until first sample)
  p95Ms: number | null; // 95th-percentile frame time over the gesture
  worstFps: number | null; // worst fps seen in the current/last gesture
  active: boolean;
};

export type PerfMetrics = {
  snapshot: PerfSnapshot;
  parseTotalMs: number | null;
  drag: DragFps;
};

const IDLE_DRAG: DragFps = { fps: null, p95Ms: null, worstFps: null, active: false };

// rAF frame-time sampler. Only runs while `dragging` — an always-on rAF loop
// would itself cost a frame slot and skew the very number it measures. p95
// (not mean) because drag jank is about the worst frames, not the average.
function useDragFps(dragging: boolean): DragFps {
  const [drag, setDrag] = useState<DragFps>(IDLE_DRAG);
  const frames = useRef<number[]>([]);
  const lastTs = useRef(0);
  const rafId = useRef(0);

  useEffect(() => {
    if (!dragging) {
      setDrag((d) => ({ ...d, active: false }));
      return;
    }
    frames.current = [];
    lastTs.current = performance.now();
    setDrag({ fps: null, p95Ms: null, worstFps: null, active: true });

    let worst = Infinity;
    const tick = () => {
      const now = performance.now();
      const dt = now - lastTs.current;
      lastTs.current = now;
      const arr = frames.current;
      arr.push(dt);
      if (arr.length > 120) arr.shift();
      const fps = 1000 / dt;
      worst = Math.min(worst, fps);
      const sorted = [...arr].sort((a, b) => a - b);
      const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
      const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
      setDrag({
        fps: Math.round(1000 / mean),
        p95Ms: Math.round(p95),
        worstFps: Math.round(worst),
        active: true,
      });
      rafId.current = requestAnimationFrame(tick);
    };
    rafId.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId.current);
  }, [dragging]);

  return drag;
}

export function usePerfMetrics(dragging: boolean): PerfMetrics {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const drag = useDragFps(dragging);
  return { snapshot, parseTotalMs: parseTotalMs(snapshot), drag };
}

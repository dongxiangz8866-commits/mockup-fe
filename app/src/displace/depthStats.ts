import type { Quad } from '../shading';

type Pt = { x: number; y: number };

export type DepthStats = {
  center: number;
  range: number;
};

const MIN_DEPTH_RANGE = 0.035;
const GRID_STEPS = 9;

function mixPt(a: Pt, b: Pt, t: number): Pt {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  };
}

function quadPoint(quad: Quad, u: number, v: number): Pt {
  const top = mixPt(quad.tl, quad.tr, u);
  const bottom = mixPt(quad.bl, quad.br, u);
  return mixPt(top, bottom, v);
}

function sampleDepth(ctx: CanvasRenderingContext2D, w: number, h: number, p: Pt) {
  const x = Math.max(0, Math.min(w - 1, Math.round(p.x)));
  const y = Math.max(0, Math.min(h - 1, Math.round(p.y)));
  return ctx.getImageData(x, y, 1, 1).data[0] / 255;
}

function percentile(sorted: number[], p: number) {
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.round((sorted.length - 1) * p)));
  return sorted[idx];
}

export function sampleDepthStats(depth: HTMLCanvasElement, quad: Quad | null): DepthStats {
  if (!quad) return { center: 0.5, range: MIN_DEPTH_RANGE };

  const w = depth.width;
  const h = depth.height;
  const ctx = depth.getContext('2d')!;
  const center = sampleDepth(ctx, w, h, quadPoint(quad, 0.5, 0.5));
  const samples: number[] = [];

  for (let yi = 0; yi < GRID_STEPS; yi++) {
    for (let xi = 0; xi < GRID_STEPS; xi++) {
      const u = xi / (GRID_STEPS - 1);
      const v = yi / (GRID_STEPS - 1);
      samples.push(sampleDepth(ctx, w, h, quadPoint(quad, u, v)));
    }
  }

  samples.sort((a, b) => a - b);
  const lo = percentile(samples, 0.08);
  const hi = percentile(samples, 0.92);
  const range = Math.max(MIN_DEPTH_RANGE, Math.abs(center - lo), Math.abs(hi - center));
  return { center, range };
}

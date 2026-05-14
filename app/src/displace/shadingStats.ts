import type { Quad } from '../shading';

type Pt = { x: number; y: number };

export type ShadingStats = {
  p10: number;
  p90: number;
  // Wrinkle-amplitude auto-scale derived from the quad-ROI spread.
  // Per-image normalization to [p10..p90] only equalizes the signal RANGE;
  // it doesn't account for whether the spread is REAL folds (clean signal)
  // or dye-band / weave / edge-shadow contamination (fake signal). Photos
  // with large spread are usually contaminated (a t-shirt with deep folds
  // is the exception, not the rule on fashion stills), and after [0..1]
  // remap their fake signal drives warp to full amplitude.
  //
  // autoScale = REFERENCE_SPREAD / actualSpread, clamped:
  //   spread large (outdoor / dyed fabric / busy background) → scale < 1
  //     → attenuate amplitude so fake signal can't bend the print
  //   spread small (studio flat-light) → scale > 1
  //     → boost amplitude so the slider has perceptible effect at 1.0
  // Net result: slider value 1.0 means "typical wrinkle strength" on EVERY
  // photo, instead of "wide-DoG contrast multiplier" which varied 6×.
  autoScale: number;
};

// Without per-image normalization, slider=1.0 sends wildly different fold
// pushes per photo: outdoor shots with leafy backgrounds give a wide-DoG
// shading map with strong contrast inside the shirt ROI (slider=0.5 already
// distorts the print), while flat-light studio shots give near-zero contrast
// (slider=1.0 produces no visible warp). The fix: sample shading inside the
// pose quad once per photo, remap to [0..1] in-shader using these percentiles
// so the slider becomes "fold strength" instead of "DoG contrast multiplier".
const GRID_STEPS = 9;
const DEFAULT_P10 = 0.35;
const DEFAULT_P90 = 0.50;
const MIN_SPREAD = 0.05;
// "Typical real fold" P90-P10 contrast in the wide-DoG output. A clean
// studio photo of a tee with visible drape sits near this value. spread
// >> this means contamination dominates (dye/weave/edge); spread << this
// means truly flat cloth (or weak DoG signal).
const REFERENCE_SPREAD = 0.10;
const AUTO_SCALE_MIN = 0.3;
const AUTO_SCALE_MAX = 2.5;

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

function percentile(sorted: number[], p: number) {
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.round((sorted.length - 1) * p)));
  return sorted[idx];
}

export function sampleShadingStats(shading: HTMLCanvasElement, quad: Quad | null): ShadingStats {
  if (!quad) return { p10: DEFAULT_P10, p90: DEFAULT_P90, autoScale: 1.0 };

  const w = shading.width;
  const h = shading.height;
  const ctx = shading.getContext('2d')!;

  const samples: number[] = [];
  for (let yi = 0; yi < GRID_STEPS; yi++) {
    for (let xi = 0; xi < GRID_STEPS; xi++) {
      const u = xi / (GRID_STEPS - 1);
      const v = yi / (GRID_STEPS - 1);
      const p = quadPoint(quad, u, v);
      const x = Math.max(0, Math.min(w - 1, Math.round(p.x)));
      const y = Math.max(0, Math.min(h - 1, Math.round(p.y)));
      samples.push(ctx.getImageData(x, y, 1, 1).data[0] / 255);
    }
  }

  samples.sort((a, b) => a - b);
  const p10 = percentile(samples, 0.10);
  const p90 = percentile(samples, 0.90);
  const rawSpread = p90 - p10;

  // Guard against a quad that landed on a uniform shading region — without
  // a floor, (p90 − p10) ≈ 0 would amplify pixel noise into massive warp.
  if (rawSpread < MIN_SPREAD) {
    const mid = (p10 + p90) / 2;
    // No real wrinkle signal here — don't boost. autoScale=1 keeps slider
    // honest; a flat-cloth photo is supposed to look flat under the print.
    console.log(`[shadingStats] p10=${p10.toFixed(3)} p90=${p90.toFixed(3)} spread<MIN → autoScale=1.00 (clamped)`);
    return { p10: mid - MIN_SPREAD / 2, p90: mid + MIN_SPREAD / 2, autoScale: 1.0 };
  }

  const autoScale = Math.max(AUTO_SCALE_MIN, Math.min(AUTO_SCALE_MAX, REFERENCE_SPREAD / rawSpread));
  console.log(`[shadingStats] p10=${p10.toFixed(3)} p90=${p90.toFixed(3)} spread=${rawSpread.toFixed(3)} → autoScale=${autoScale.toFixed(2)}`);
  return { p10, p90, autoScale };
}

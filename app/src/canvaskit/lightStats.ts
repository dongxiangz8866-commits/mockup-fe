import type { Quad } from '../shading';

// Normalizers 1 + 3 for the fold-lighting target (2026-05-19 redesign).
//
// The composite used to scale fold darkening by a per-garment-COLOR constant
// (autoLightStrength's black/white/color branches) — un-exhaustible because
// the right strength depends on the photo's actual fold-signal magnitude and
// its signal-to-noise, not on shirt hue. This samples the LIGHT map (the
// exact signal the shader reads) inside cloth∩quad and returns:
//
//   • spread     — P90−P10 of the LOW-freq fold depth. The shader z-scores
//                   (1−light) by this so "fold depth = 1.0" means the same
//                   on a flat studio tee and a deep-creased outdoor shot.
//                   Kills source-lighting-intensity (干扰变量①).
//   • confidence — smoothstep of signal/noise SNR. On dark cloth the
//                   FLOOR=40 ratio in buildShadingMap is mostly JPEG/sensor
//                   noise (see feedback_displace_black_no_foldlight); a black
//                   studio tee → low SNR → confidence≈0 → fold target ≈ 0,
//                   reproducing the old 0.12 black floor as a MEASURED
//                   consequence rather than a hardcoded color branch
//                   (干扰变量③, the real axis the 3 buckets proxied).

const GRID = 32; // 1024 ROI samples — stable percentiles, <2 ms on a bbox read
const NB = 3; // px radius of the low-pass box (fold scale ≫ this; noise ≈ this)
const MIN_SPREAD = 0.04;
const DEFAULT_SPREAD = 0.12;
const SNR_LO = 1.2; // signal ≤ 1.2× noise ⇒ distrust (pure noise floor)
const SNR_HI = 3.0; // signal ≥ 3× noise ⇒ full trust
const EPS = 1e-4;

export type LightStats = { spread: number; confidence: number };

// /canvaskit-only soft copy of the light map. The shared buildLightMap (DoG
// of the photo, used by /displace too — out of scope) is bimodal on studio/
// AI shirts: hard-edged body-shadow blobs, not cloth folds. Applied raw to a
// flat WHITE print they read as dirty smudges. A modest blur turns the hard
// blob into a gentle gradient → reads as natural lighting falloff, NOT a
// stain, WITHOUT cutting shading anywhere (user: 自然点, 不是要砍). Real
// 30–80 px folds survive; only the sub-fold hard mottling is smoothed.
// Done once per photo (useMemo in CanvasKitPage), zero per-frame cost.
export function softenLightMap(light: HTMLCanvasElement): HTMLCanvasElement {
  const w = light.width;
  const h = light.height;
  const r = Math.max(2, Math.round(Math.min(w, h) * 0.012));
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d')!;
  ctx.filter = `blur(${r}px)`;
  ctx.drawImage(light, 0, 0);
  return out;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / Math.max(b - a, EPS)));
  return t * t * (3 - 2 * t);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.max(0, Math.min(sorted.length - 1, Math.round((sorted.length - 1) * p)));
  return sorted[i];
}

// Quad bounding box clamped to the canvas, as integer pixel bounds.
function quadBBox(q: Quad, w: number, h: number) {
  const xs = [q.tl.x, q.tr.x, q.bl.x, q.br.x];
  const ys = [q.tl.y, q.tr.y, q.bl.y, q.br.y];
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const x1 = Math.min(w, Math.ceil(Math.max(...xs)));
  const y1 = Math.min(h, Math.ceil(Math.max(...ys)));
  return { x0, y0, bw: Math.max(1, x1 - x0), bh: Math.max(1, y1 - y0) };
}

export function sampleLightStats(
  light: HTMLCanvasElement,
  cloth: HTMLCanvasElement | null,
  quad: Quad | null
): LightStats {
  if (!quad) return { spread: DEFAULT_SPREAD, confidence: 1.0 };

  const w = light.width;
  const h = light.height;
  const bb = quadBBox(quad, w, h);
  const ld = light.getContext('2d')!.getImageData(bb.x0, bb.y0, bb.bw, bb.bh).data;
  // Cloth mask is photo-native and may differ in size; sample by ratio.
  const cd = cloth ? cloth.getContext('2d')!.getImageData(0, 0, cloth.width, cloth.height).data : null;
  const cScaleX = cloth ? cloth.width / w : 0;
  const cScaleY = cloth ? cloth.height / h : 0;

  // Bilinear quad param p(u,v) = tl + u·U + v·V + u·v·C.
  const ux = quad.tr.x - quad.tl.x, uy = quad.tr.y - quad.tl.y;
  const vx = quad.bl.x - quad.tl.x, vy = quad.bl.y - quad.tl.y;
  const cx = quad.br.x - quad.tr.x - quad.bl.x + quad.tl.x;
  const cy = quad.br.y - quad.tr.y - quad.bl.y + quad.tl.y;

  const depthAt = (px: number, py: number): number => {
    const lx = Math.max(0, Math.min(bb.bw - 1, Math.round(px - bb.x0)));
    const ly = Math.max(0, Math.min(bb.bh - 1, Math.round(py - bb.y0)));
    return 1 - ld[(ly * bb.bw + lx) * 4] / 255; // 0 = flat, 1 = deep fold
  };
  const onCloth = (px: number, py: number): boolean => {
    if (!cd) return true;
    const cxp = Math.max(0, Math.min(cloth!.width - 1, Math.round(px * cScaleX)));
    const cyp = Math.max(0, Math.min(cloth!.height - 1, Math.round(py * cScaleY)));
    return cd[(cyp * cloth!.width + cxp) * 4] > 128;
  };

  const low: number[] = [];
  let noiseSq = 0;
  let n = 0;
  for (let j = 0; j < GRID; j++) {
    const v = (j + 0.5) / GRID;
    for (let i = 0; i < GRID; i++) {
      const u = (i + 0.5) / GRID;
      const px = quad.tl.x + u * ux + v * vx + u * v * cx;
      const py = quad.tl.y + u * uy + v * vy + u * v * cy;
      if (!onCloth(px, py)) continue;
      const d = depthAt(px, py);
      const dLow =
        (d +
          depthAt(px + NB, py) + depthAt(px - NB, py) +
          depthAt(px, py + NB) + depthAt(px, py - NB)) / 5;
      low.push(dLow);
      noiseSq += (d - dLow) * (d - dLow);
      n++;
    }
  }
  if (n < 16) return { spread: DEFAULT_SPREAD, confidence: 1.0 };

  low.sort((a, b) => a - b);
  const signalSpread = percentile(low, 0.9) - percentile(low, 0.1);
  const noiseRMS = Math.sqrt(noiseSq / n);
  const snr = signalSpread / (noiseRMS + EPS);
  const confidence = smoothstep(SNR_LO, SNR_HI, snr);
  const spread = Math.max(MIN_SPREAD, Math.min(1, signalSpread));

  if (import.meta.env.DEV) {
    console.log(
      `[lightStats] spread=${spread.toFixed(3)} sig=${signalSpread.toFixed(3)} ` +
        `noise=${noiseRMS.toFixed(3)} snr=${snr.toFixed(2)} conf=${confidence.toFixed(2)}`
    );
  }
  return { spread, confidence };
}

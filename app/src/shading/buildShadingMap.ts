import { shadingInputDims, type Quad, type ShadingInput } from './types';

// Sample luminance percentiles inside the print quad — pixels guaranteed to
// be on-shirt because the quad is built from MediaPipe Pose's shoulder/hip
// landmarks. 64×64 bilinearly-interpolated samples (4096 pixels) are plenty
// for stable percentile estimates and run in <2 ms on a full-res photo.
export function sampleShirtQuadLums(
  photo: HTMLImageElement,
  quad: Quad
): { p10: number; p50: number; p90: number } {
  const w = photo.naturalWidth;
  const h = photo.naturalHeight;
  const off = document.createElement('canvas');
  off.width = w;
  off.height = h;
  const ctx = off.getContext('2d')!;
  ctx.drawImage(photo, 0, 0);
  const data = ctx.getImageData(0, 0, w, h).data;
  // Bilinear quad parametrisation: p(u,v) = tl + u·U + v·V + u·v·C.
  const ux = quad.tr.x - quad.tl.x;
  const uy = quad.tr.y - quad.tl.y;
  const vx = quad.bl.x - quad.tl.x;
  const vy = quad.bl.y - quad.tl.y;
  const cx = quad.br.x - quad.tr.x - quad.bl.x + quad.tl.x;
  const cy = quad.br.y - quad.tr.y - quad.bl.y + quad.tl.y;
  const N = 64;
  const lums: number[] = [];
  for (let i = 0; i < N; i++) {
    const u = (i + 0.5) / N;
    for (let j = 0; j < N; j++) {
      const v = (j + 0.5) / N;
      const px = Math.round(quad.tl.x + u * ux + v * vx + u * v * cx);
      const py = Math.round(quad.tl.y + u * uy + v * vy + u * v * cy);
      if (px < 0 || px >= w || py < 0 || py >= h) continue;
      const k = (py * w + px) * 4;
      lums.push(data[k] * 0.299 + data[k + 1] * 0.587 + data[k + 2] * 0.114);
    }
  }
  if (lums.length === 0) return { p10: 0, p50: 128, p90: 255 };
  lums.sort((a, b) => a - b);
  return {
    p10: lums[Math.floor(lums.length * 0.10)],
    p50: lums[Math.floor(lums.length * 0.50)],
    p90: lums[Math.floor(lums.length * 0.90)],
  };
}

// Stretch a dark photo's luminance into a useful range before DoG runs.
// Black/dark shirts compress most of their luminance into ~[5, 30]; remap
// the shirt's [P10, P90] to [10, 120] for ~5× contrast amplification while
// preserving hue. White / light shirts (P50 ≥ 80) and narrow-range cases
// (P90 − P10 < 10) short-circuit and return the original photo so the
// shading-map encoding stays byte-identical to the pre-A1 path.
export function preprocessForShading(
  photo: HTMLImageElement,
  shirtQuad: Quad | null
): ShadingInput {
  if (!shirtQuad) {
    if (import.meta.env.DEV) {
      const tag = photo.src?.split('/').pop() ?? '?';
      console.log(`[A1] skip(no-pose) ${tag}`);
    }
    return photo;
  }

  const stats = sampleShirtQuadLums(photo, shirtQuad);
  const { p10, p50, p90 } = stats;

  if (import.meta.env.DEV) {
    const tag = photo.src?.split('/').pop() ?? '?';
    const fmt = (n: number) => n.toFixed(0);
    if (p50 >= 80) {
      console.log(`[A1] skip(bright) ${tag} p50=${fmt(p50)} p10=${fmt(p10)} p90=${fmt(p90)}`);
    } else if (p90 - p10 < 10) {
      console.log(`[A1] skip(narrow) ${tag} p50=${fmt(p50)} p10=${fmt(p10)} p90=${fmt(p90)}`);
    } else {
      console.log(`[A1] stretch ${tag} p50=${fmt(p50)} p10=${fmt(p10)} p90=${fmt(p90)} → [10,120]`);
    }
  }
  if (p50 >= 80) return photo;
  if (p90 - p10 < 10) return photo;

  const w = photo.naturalWidth;
  const h = photo.naturalHeight;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d')!;
  ctx.drawImage(photo, 0, 0);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const TARGET_LO = 10;
  const TARGET_HI = 120;
  const scale = (TARGET_HI - TARGET_LO) / Math.max(1, p90 - p10);
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    const l = r * 0.299 + g * 0.587 + b * 0.114;
    const lp = TARGET_LO + (l - p10) * scale;
    const gain = lp / Math.max(l, 1);
    d[i] = Math.max(0, Math.min(255, r * gain));
    d[i + 1] = Math.max(0, Math.min(255, g * gain));
    d[i + 2] = Math.max(0, Math.min(255, b * gain));
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

// Per-pixel PERCEPTUAL-RATIO shading map: encodes the relative luminance
// change `(photo − blur) / max(blur, FLOOR)` around byte 128 (hard-light
// identity). Folds → byte < 128 → hard-light darkens pattern.
//
// FLOOR=40 keeps near-black pixels from blowing up. Cap at byte 128 (no
// values above) so saturated pattern colors don't get washed by the
// hard-light lightening branch. Two blurs: large (5%/10%) is the local-mean
// estimator, small (~0.4%) denoises sub-5px sensor noise. Post-blur (~0.2%)
// softens ratio quantisation step-edges.
export function buildShadingMap(
  photo: ShadingInput,
  bigBlurFrac: number = 0.05
): HTMLCanvasElement {
  const { w, h } = shadingInputDims(photo);
  const blurRadius = Math.max(40, Math.round(Math.min(w, h) * bigBlurFrac));
  const smallRadius = Math.max(3, Math.round(Math.min(w, h) * 0.004));
  const smallC = document.createElement('canvas');
  smallC.width = w;
  smallC.height = h;
  const smallCtx = smallC.getContext('2d')!;
  smallCtx.filter = `blur(${smallRadius}px)`;
  smallCtx.drawImage(photo, 0, 0);
  const blurC = document.createElement('canvas');
  blurC.width = w;
  blurC.height = h;
  const blurCtx = blurC.getContext('2d')!;
  blurCtx.filter = `blur(${blurRadius}px)`;
  blurCtx.drawImage(photo, 0, 0);
  const origC = document.createElement('canvas');
  origC.width = w;
  origC.height = h;
  const origCtx = origC.getContext('2d')!;
  origCtx.drawImage(photo, 0, 0);
  const S = smallCtx.getImageData(0, 0, w, h);
  const B = blurCtx.getImageData(0, 0, w, h);
  const out = origCtx.createImageData(w, h);
  const Sd = S.data;
  const Bd = B.data;
  const Dd = out.data;
  for (let i = 0; i < Sd.length; i += 4) {
    const lS = Sd[i] * 0.299 + Sd[i + 1] * 0.587 + Sd[i + 2] * 0.114;
    const lB = Bd[i] * 0.299 + Bd[i + 1] * 0.587 + Bd[i + 2] * 0.114;
    const FLOOR = 40;
    const r = (lS - lB) / Math.max(lB, FLOOR);
    const v = Math.max(0, Math.min(128, Math.round(128 + r * 256)));
    Dd[i] = v;
    Dd[i + 1] = v;
    Dd[i + 2] = v;
    Dd[i + 3] = 255;
  }
  origCtx.putImageData(out, 0, 0);
  const denoised = document.createElement('canvas');
  denoised.width = w;
  denoised.height = h;
  const dctx = denoised.getContext('2d')!;
  dctx.filter = `blur(${Math.max(2, Math.round(Math.min(w, h) * 0.002))}px)`;
  dctx.drawImage(origC, 0, 0);
  return denoised;
}

import type { Quad } from './types';

const SAMPLE_SIZE = 64;
// Fraction of brightest non-shirt pixels averaged for `rgb`. Highlights /
// well-lit surfaces carry the light-source color; background objects carry
// their own albedo. Using top-15% gives us the LIGHT'S color cast, not the
// scene's object color soup.
const HIGHLIGHT_FRAC = 0.15;

export type SceneSample = {
  /** Highlight-mean RGB (top-15% by luminance), 0..255. Robust color-cast estimate. */
  rgb: [number, number, number];
  /** Highlight-mean luminance, 0..255. */
  highlightLum: number;
  /** Full-frame (ex-shirt) mean luminance, 0..255. Use this for "scene is dim" tests — highlightLum is biased toward the brightest part and won't drop in a "dim warm" scene. */
  fullLum: number;
};

// Estimate the photo's lighting color + overall brightness. Strategy:
//   1. Downsample to 64×64, mask out the print quad.
//   2. For color (rgb): average the TOP-15% brightest pixels — these are
//      highlights and well-lit surfaces, dominated by light-source color
//      rather than object albedo. This kills the previous failure mode where
//      a big patch of sand or pink audience flipped envRGB.
//   3. For brightness (fullLum): full average of all non-shirt pixels.
//      A scene can have specular highlights AND be overall dim; the two
//      signals are orthogonal.
export function sampleScene(photo: HTMLImageElement, quad: Quad | null): SceneSample {
  const N = SAMPLE_SIZE;
  const W = photo.naturalWidth;
  const H = photo.naturalHeight;

  const photoCanvas = document.createElement('canvas');
  photoCanvas.width = N;
  photoCanvas.height = N;
  const pctx = photoCanvas.getContext('2d')!;
  pctx.drawImage(photo, 0, 0, N, N);
  const pData = pctx.getImageData(0, 0, N, N).data;

  let mData: Uint8ClampedArray | null = null;
  if (quad) {
    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = N;
    maskCanvas.height = N;
    const mctx = maskCanvas.getContext('2d')!;
    mctx.fillStyle = '#fff';
    mctx.fillRect(0, 0, N, N);
    mctx.fillStyle = '#000';
    const sx = N / W;
    const sy = N / H;
    mctx.beginPath();
    mctx.moveTo(quad.tl.x * sx, quad.tl.y * sy);
    mctx.lineTo(quad.tr.x * sx, quad.tr.y * sy);
    mctx.lineTo(quad.br.x * sx, quad.br.y * sy);
    mctx.lineTo(quad.bl.x * sx, quad.bl.y * sy);
    mctx.closePath();
    mctx.fill();
    mData = mctx.getImageData(0, 0, N, N).data;
  }

  // First pass: collect (lum, rgb) for every non-shirt pixel, accumulate
  // full-frame lum sum.
  type Px = { lum: number; r: number; g: number; b: number };
  const pixels: Px[] = [];
  let fullSumLum = 0;
  for (let i = 0; i < pData.length; i += 4) {
    if (mData && mData[i] < 128) continue;
    const r = pData[i];
    const g = pData[i + 1];
    const b = pData[i + 2];
    const lum = r * 0.299 + g * 0.587 + b * 0.114;
    pixels.push({ lum, r, g, b });
    fullSumLum += lum;
  }
  if (pixels.length === 0) {
    return { rgb: [128, 128, 128], highlightLum: 128, fullLum: 128 };
  }

  // Second pass: pick top-15% by lum (selection-style sort is fine at 64²=4096).
  pixels.sort((a, b) => b.lum - a.lum);
  const keep = Math.max(1, Math.floor(pixels.length * HIGHLIGHT_FRAC));
  let hR = 0;
  let hG = 0;
  let hB = 0;
  let hLum = 0;
  for (let i = 0; i < keep; i++) {
    hR += pixels[i].r;
    hG += pixels[i].g;
    hB += pixels[i].b;
    hLum += pixels[i].lum;
  }
  return {
    rgb: [hR / keep, hG / keep, hB / keep],
    highlightLum: hLum / keep,
    fullLum: fullSumLum / pixels.length,
  };
}

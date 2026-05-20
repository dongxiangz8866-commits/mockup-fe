import type { Channel } from './buildMesh';

// CPU pixel buffer for a map canvas — buildMesh samples macro/smooth/
// shading/photo at photo-native px.
export function toChannel(canvas: HTMLCanvasElement): Channel {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data, w: canvas.width, h: canvas.height };
}

// The photo is an <img>; rasterize once at natural size to read RGB for the
// cloth-chroma fold gate.
export function imageChannel(img: HTMLImageElement): Channel {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext('2d')!.drawImage(img, 0, 0);
  return toChannel(c);
}

function solid(rgba: [number, number, number, number]): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = 1;
  const x = c.getContext('2d')!;
  x.fillStyle = `rgba(${rgba[0]},${rgba[1]},${rgba[2]},${rgba[3]})`;
  x.fillRect(0, 0, 1, 1);
  return c;
}

// hair: 1×1 black = no occlusion anywhere (graceful pre-ML fallback).
export const blackFallback = (): HTMLCanvasElement => solid([0, 0, 0, 1]);
// cloth debug child: 1×1 white = "all cloth" when the mask is absent.
export const whiteFallback = (): HTMLCanvasElement => solid([255, 255, 255, 1]);

// Garment mask → a canvas whose ALPHA is the mask (rgb unused) for the
// pass-1 DstIn clip. null ⇒ 1×1 opaque = ungated (keeps the print where
// the quad spilled past the shirt until a real mask arrives — same
// graceful degrade as the displace path's white 1×1).
//
// 2026-05-20: a blur is added at the END so the alpha gates from 255→0
// over ~6 px instead of ~1 px (the segmenter's bilinear upscale alone).
// At depthWrap≥2 the warp pushes the print outward to the cloth boundary,
// and a 1-px-feather alpha against a busy photo reads as jagged hard lines
// (user report). Blurring the alpha gives a real soft falloff — the print
// fades into the garment edge instead of stamping a step. We blur AFTER
// copying the mask byte into the alpha channel so the RGB stays white and
// only the gating profile softens; canvas `filter:blur` re-samples in
// straight-alpha space (no premul darkening artifact at the boundary).
export function clothAlphaCanvas(src: HTMLCanvasElement | null): HTMLCanvasElement {
  if (!src) return solid([255, 255, 255, 1]);
  const raw = document.createElement('canvas');
  raw.width = src.width;
  raw.height = src.height;
  const rawCtx = raw.getContext('2d', { willReadFrequently: true })!;
  const sd = src
    .getContext('2d', { willReadFrequently: true })!
    .getImageData(0, 0, src.width, src.height);
  const od = rawCtx.createImageData(src.width, src.height);
  for (let i = 0; i < sd.data.length; i += 4) {
    od.data[i] = od.data[i + 1] = od.data[i + 2] = 255;
    od.data[i + 3] = sd.data[i];
  }
  rawCtx.putImageData(od, 0, 0);

  const r = Math.max(2, Math.round(Math.min(src.width, src.height) * 0.004));
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  const ctx = c.getContext('2d')!;
  ctx.filter = `blur(${r}px)`;
  ctx.drawImage(raw, 0, 0);
  return c;
}

import {
  buildShadingMap,
  decodeCachedMap,
  loadCachedMap,
  preprocessForShading,
  saveCachedMap,
  type Quad,
  type ShadingInput,
} from '../shading';

const LIGHT_CACHE_PREFIX = 'light-cache:v1:';
const DISPLACE_CACHE_PREFIX = 'disp-cache:v2:';
const SMOOTH_CACHE_PREFIX = 'smooth-cache:v1:';

// The wide-band DoG (10% big-blur) catches 30–80 px folds — exactly the
// scale that reads as "displaceable cloth fold" to the eye. Narrow (5%)
// is dominated by sub-fold micro-noise that would jitter the displacement.
const WIDE_BIG_BLUR_FRAC = 0.10;

// Light map: stretch the shading map's [0..128] (only-darken) range back
// out to [0..255] for use as a multiply layer (255 = identity, 0 = full
// darken). 128 (no-fold pixel) maps to 255 — flat regions stay unchanged.
//
// Why x2 not the agent's `(b−128)*2 + 255`: the input is [0..128], so
// `clamp(2b, 0, 255)` is equivalent and one op shorter.
export function buildLightMap(shading: HTMLCanvasElement): HTMLCanvasElement {
  const w = shading.width;
  const h = shading.height;
  const sctx = shading.getContext('2d')!;
  const src = sctx.getImageData(0, 0, w, h);
  const out = sctx.createImageData(w, h);
  const sd = src.data;
  const od = out.data;
  for (let i = 0; i < sd.length; i += 4) {
    const v = Math.max(0, Math.min(255, sd[i] * 2));
    od[i] = v;
    od[i + 1] = v;
    od[i + 2] = v;
    od[i + 3] = 255;
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d')!.putImageData(out, 0, 0);
  return c;
}

// Displace map: Sobel(wide DoG) → signed (gx, gy) → encoded RG at byte 128
// = zero displacement. The shader scales the signed offset by uAmpPx ×
// uStrength at render time, so the byte encoding is amplitude-independent.
//
// Sobel kernels on the DoG luma (R == G == B in shading-map output):
//   Sx = [[-1 0 1] [-2 0 2] [-1 0 1]]
//   Sy = [[-1 -2 -1] [0 0 0] [1 2 1]]
// Theoretical max sum magnitude is 4×255 = 1020 for 8-bit input; but our
// input is the wide-DoG byte capped at 128, and a typical fold-edge Sobel
// response on real photos lands around 100-200. NORM=256 maps a fold-edge
// response of ~256 to byte ±127 — i.e. saturates the byte range right at
// the strongest folds we'll actually see, instead of stopping at ±15 with
// the over-conservative theoretical cap. Empirically calibrated, not a
// universal constant.
//
// Sobel direction = fold-normal: pushes pattern pixels from bright crests
// into dark valleys, which visually reads as "the print sinks into the fold".
export function buildDisplaceMap(shading: HTMLCanvasElement): HTMLCanvasElement {
  const w = shading.width;
  const h = shading.height;
  const sctx = shading.getContext('2d')!;
  const src = sctx.getImageData(0, 0, w, h).data;
  const stage = document.createElement('canvas');
  stage.width = w;
  stage.height = h;
  const stageCtx = stage.getContext('2d')!;
  const od = stageCtx.createImageData(w, h);
  const dst = od.data;
  const NORM = 256;
  // Initialise with the neutral "no displacement" byte so the 1-px border
  // (skipped by the Sobel loop) reads as zero offset and won't tear pattern
  // pixels at the photo edge.
  for (let i = 0; i < dst.length; i += 4) {
    dst[i] = 128;
    dst[i + 1] = 128;
    dst[i + 2] = 128;
    dst[i + 3] = 255;
  }
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      const o = (y - 1) * w + x;
      const m = y * w + x;
      const u = (y + 1) * w + x;
      const tl = src[(o - 1) * 4];
      const t  = src[o * 4];
      const tr = src[(o + 1) * 4];
      const ml = src[(m - 1) * 4];
      const mr = src[(m + 1) * 4];
      const bl = src[(u - 1) * 4];
      const b  = src[u * 4];
      const br = src[(u + 1) * 4];
      const gx = -tl - 2 * ml - bl + tr + 2 * mr + br;
      const gy = -tl - 2 * t - tr + bl + 2 * b + br;
      dst[i] = Math.max(0, Math.min(255, Math.round(128 + (gx / NORM) * 127)));
      dst[i + 1] = Math.max(0, Math.min(255, Math.round(128 + (gy / NORM) * 127)));
    }
  }
  stageCtx.putImageData(od, 0, 0);
  // Light denoise so adjacent texels don't tear pattern (~0.2% min dim).
  const blur = Math.max(2, Math.round(Math.min(w, h) * 0.002));
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const octx = out.getContext('2d')!;
  octx.filter = `blur(${blur}px)`;
  octx.drawImage(stage, 0, 0);
  return out;
}

// PURE heavy low-pass of the photo luma — the "wrinkle field written into
// depth" source (2026-05-19, v2 of the smooth-field idea). Deliberately NOT
// buildShadingMap: that is a band-PASS (DoG) keeping the mid-freq dye/weave
// that historically sliced letters as a warp source. A single ~8% Gaussian
// keeps ONLY the fold-scale macro light-dark, so the field is globally smooth
// the same way the DAv2 depth map is — which is the whole point: it gets
// ADDED into the depth z and consumed by the already-working absolute-radial-
// drop cylinder wrap (value, not gradient — the operator the user confirmed
// works), so a bright crest reads as "closer" and a dark fold as "receding".
// Built from the A1-preprocessed `input` (the model photo, BEFORE our print
// composite) so the print's own edges never enter the field.
export function buildSmoothField(
  input: ShadingInput,
  w: number,
  h: number
): HTMLCanvasElement {
  const radius = Math.max(40, Math.round(Math.min(w, h) * 0.08));
  const blurC = document.createElement('canvas');
  blurC.width = w;
  blurC.height = h;
  const bctx = blurC.getContext('2d')!;
  bctx.filter = `blur(${radius}px)`;
  bctx.drawImage(input, 0, 0);
  const src = bctx.getImageData(0, 0, w, h).data;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const octx = out.getContext('2d')!;
  const od = octx.createImageData(w, h);
  const dd = od.data;
  for (let i = 0; i < src.length; i += 4) {
    const l = Math.round(src[i] * 0.299 + src[i + 1] * 0.587 + src[i + 2] * 0.114);
    dd[i] = l;
    dd[i + 1] = l;
    dd[i + 2] = l;
    dd[i + 3] = 255;
  }
  octx.putImageData(od, 0, 0);
  return out;
}

// Build (or hydrate from cache) the wide DoG → light + displace pair for
// `photo` against `quad`. Pose-quad is needed only for the A1 dark-shirt
// luminance stretch inside `preprocessForShading`; if quad is null the
// stretch becomes a no-op (photo passes through unchanged).
export type DerivedMaps = {
  light: HTMLCanvasElement;
  displace: HTMLCanvasElement;
  /** The wide DoG used as input to both — useful for the debug view. */
  shading: HTMLCanvasElement;
  /** Pure-low-pass field added into depth z for the cylinder fold wrap. */
  smooth: HTMLCanvasElement;
};

export async function deriveMaps(
  photo: HTMLImageElement,
  quad: Quad | null,
  cacheKey: string
): Promise<DerivedMaps> {
  const w = photo.naturalWidth;
  const h = photo.naturalHeight;

  // Skip A1 stretch entirely when no pose; matches the existing shading-
  // pipeline contract (preprocessForShading returns the photo unchanged).
  const input: ShadingInput = preprocessForShading(photo, quad);
  const shading = buildShadingMap(input, WIDE_BIG_BLUR_FRAC);

  let light: HTMLCanvasElement;
  const cachedLight = loadCachedMap(LIGHT_CACHE_PREFIX, cacheKey);
  if (cachedLight) {
    light = await decodeCachedMap(cachedLight, w, h);
  } else {
    light = buildLightMap(shading);
    saveCachedMap(LIGHT_CACHE_PREFIX, cacheKey, light);
  }

  let displace: HTMLCanvasElement;
  const cachedDisp = loadCachedMap(DISPLACE_CACHE_PREFIX, cacheKey);
  if (cachedDisp) {
    displace = await decodeCachedMap(cachedDisp, w, h);
  } else {
    displace = buildDisplaceMap(shading);
    saveCachedMap(DISPLACE_CACHE_PREFIX, cacheKey, displace);
  }

  let smooth: HTMLCanvasElement;
  const cachedSmooth = loadCachedMap(SMOOTH_CACHE_PREFIX, cacheKey);
  if (cachedSmooth) {
    smooth = await decodeCachedMap(cachedSmooth, w, h);
  } else {
    smooth = buildSmoothField(input, w, h);
    saveCachedMap(SMOOTH_CACHE_PREFIX, cacheKey, smooth);
  }

  return { light, displace, shading, smooth };
}

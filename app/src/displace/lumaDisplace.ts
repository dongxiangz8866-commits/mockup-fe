// Browser port of mock-research's scripts/gen-psd-set.sh — the `displace`
// section only (no light). That project has no depth: its fold map is a
// STATIC ImageMagick-baked PNG derived from the model photo's grayscale
// luminance, not a depth model. This rebuilds the same map per-photo in
// Canvas2D so it can be A/B'd against DAv2 depth on /gradient.
//
// Reference formula (gen-psd-set.sh):
//   displace = 0.5 + Wf·(FORM-0.5) + Wd·(FOLD-0.5),  eased → grey50 off-cloth
//     FORM = broad-blur(luma), recentred so mask mean → 0.5  (body wrap/depth)
//     FOLD = CLAHE local-contrast + sigmoid steepen          (crease relief)
//
// Faithful EXCEPT CLAHE: full contrast-limited adaptive histogram EQ is ~100
// lines and slow. Its job here (script comment: "local adaptive contrast →
// mid-freq fold relief") is captured by an unsharp high-pass — gray minus a
// mid-radius blur, gained and sigmoid-steepened. This route is judged by eye
// and iterated, so the proxy is the deliberate simplest-thing-that-works.

// Weights/tunables transcribed from gen-psd-set.sh. Blur radii are made
// resolution-proportional (the script ran at a fixed ~1024px and used raw
// sigma 22 / 12% tiles) so the body-form scale is stable across our 1280–2K
// photos instead of being a fixed pixel count.
const FORM_W = 1.5;
// 0.8 → 0 (2026-05-20). The FOLD term is CLAHE-style high-pass + sigmoid
// steepen — sharp, high-contrast, and the source of the mesh-warp锯齿 the
// user sees on /gradient at slider=0.5: 32×32 vertex sampling on a highly
// nonlinear field produces visibly different push at adjacent vertices →
// triangle seams show. FORM alone is broad-blur body shape ⇒ globally smooth
// drop field ⇒ neighbour vertices land on near-equal push ⇒ no锯齿. Crease
// detail returns via "贴合·真褶皱" (smoothWarp into z) when the user wants it.
const FOLD_W = 0;
const DENOISE_PX = 2;
const FORM_BLUR_FRAC = 0.02; // ≈ script's 0x22 at reference resolution
const FOLD_RADIUS_FRAC = 0.06; // ≈ half a 12% CLAHE tile
const FOLD_GAIN = 3.0; // local-contrast → fold relief amplitude
const EDGE_FEATHER_FRAC = 0.015; // ≈ script's 0x18 mask feather
const FINAL_BLUR_PX = 2;

// gen-psd-set.sh `light` section. Same FORM+FOLD recipe as displace but
// BROADER form blur (0x40 vs 0x22 → torso roundness, not local relief),
// own weights, and a final sigmoidal steepen (-sigmoidal-contrast 3x50%).
// The reference applies it as a grey50-neutral delta (can lighten AND
// darken). This project's uLight slot is only-darken (255 = identity, like
// buildLightMap's [0..128]→[0..255]); we remap the neutral-0.5 result into
// that convention so it drops straight into the existing multiply with no
// shader change. Highlights clamp at identity — consistent with the sealed
// hard-light-cap-at-128 decision; the shadow side alone carries the wrap.
const LIGHT_FORM_W = 1.25;
const LIGHT_FOLD_W = 0.85;
const LIGHT_FORM_BLUR_FRAC = 0.04;
const LIGHT_FOLD_RADIUS_FRAC = 0.07;
const LIGHT_FOLD_GAIN = 3.0;
const LIGHT_STEEPEN_K = 3.0;

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function grayCanvas(src: CanvasImageSource, w: number, h: number, blurPx: number): HTMLCanvasElement {
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.filter = `grayscale(1) blur(${blurPx}px)`;
  ctx.drawImage(src, 0, 0, w, h);
  return c;
}

function blurredCopy(src: CanvasImageSource, w: number, h: number, px: number): HTMLCanvasElement {
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.filter = `blur(${px}px)`;
  ctx.drawImage(src, 0, 0, w, h);
  return c;
}

// Mask-weighted mean of the R channel (0..1). cloth=null → global mean.
function maskedMean(data: Uint8ClampedArray, mask: Uint8ClampedArray | null): number {
  let sum = 0;
  let wsum = 0;
  for (let i = 0; i < data.length; i += 4) {
    const m = mask ? mask[i] / 255 : 1;
    sum += data[i] * m;
    wsum += m;
  }
  return wsum > 0 ? sum / wsum / 255 : 0.5;
}

// Sigmoid steepen around 0.5 — stand-in for ImageMagick -sigmoidal-contrast.
function steepen(v: number, k: number): number {
  return 1 / (1 + Math.exp(-k * (v - 0.5)));
}

export function buildLumaDisplace(
  photo: HTMLImageElement,
  cloth: HTMLCanvasElement | null
): HTMLCanvasElement {
  const w = photo.naturalWidth;
  const h = photo.naturalHeight;
  const minDim = Math.min(w, h);

  const gray = grayCanvas(photo, w, h, DENOISE_PX);
  const formC = blurredCopy(gray, w, h, Math.max(16, Math.round(minDim * FORM_BLUR_FRAC)));
  const foldBlurC = blurredCopy(gray, w, h, Math.max(8, Math.round(minDim * FOLD_RADIUS_FRAC)));

  const gctx = gray.getContext('2d', { willReadFrequently: true })!;
  const grayD = gctx.getImageData(0, 0, w, h).data;
  const formD = formC.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h).data;
  const foldBlurD = foldBlurC.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h).data;

  let maskD: Uint8ClampedArray | null = null;
  if (cloth) {
    const fe = Math.max(2, Math.round(minDim * EDGE_FEATHER_FRAC));
    const fm = blurredCopy(cloth, w, h, fe);
    maskD = fm.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h).data;
  }

  // Recentre FORM so the cloth-weighted mean lands on grey50 — else the
  // bright tee pushes the weighted sum past 1.0, clips flat, and the
  // gradient (the only thing the warp reads) goes to zero on the chest.
  const formMean = maskedMean(formD, maskD);
  const formOff = 0.5 - formMean;

  const out = makeCanvas(w, h);
  const octx = out.getContext('2d', { willReadFrequently: true })!;
  const od = octx.createImageData(w, h);
  const dd = od.data;
  const dc = 0.5 - 0.5 * FORM_W - 0.5 * FOLD_W;
  for (let i = 0; i < dd.length; i += 4) {
    const form = grayClamp(formD[i] / 255 + formOff);
    const fold = steepen(0.5 + FOLD_GAIN * (grayD[i] - foldBlurD[i]) / 255, 4);
    let v = FORM_W * form + FOLD_W * fold + dc;
    if (maskD) {
      // Ease toward flat grey50 outside the garment so background relief
      // can't introduce a spurious warp gradient at the shirt edge.
      const m = maskD[i] / 255;
      v = v * m + 0.5 * (1 - m);
    }
    const b = Math.max(0, Math.min(255, Math.round(v * 255)));
    dd[i] = b;
    dd[i + 1] = b;
    dd[i + 2] = b;
    dd[i + 3] = 255;
  }
  octx.putImageData(od, 0, 0);
  return blurredCopy(out, w, h, FINAL_BLUR_PX);
}

// ImageMagick FOLD field for SMOOTH value-injection into the depth z (the
// smoothWarp path) — NOT a gradient, NOT cloth-mask gated. DAv2 carries the
// body cylinder (proven to conform cleanly — image 6); this adds back the
// fold-scale undulation DAv2 + the plain 8% smooth field wash out ("僵硬").
//
// MUST stay globally smooth like DAv2 (the sealed "never modulate
// displacement by a non-smooth signal" rule — violating it tore the print
// edges into a staircase, image 5). So it is a Difference-of-Gaussians BAND
// pass: blur(MID) − blur(LOW). Both operands are already blurred ⇒ NO
// high-freq (no micro-crease, no sensor noise → no tearing); LOW removes the
// body form (DAv2's job); what survives is exactly the smooth fold band the
// single 8% low-pass kills. No cloth mask anywhere — the white-on-white
// segmenter is garbage and gating by it is what injected the torn boundary.
// Output sense matches buildSmoothField: bright = ridge, dark = fold valley.
const FOLD_LOW_FRAC = 0.16;  // ≥ body scale → subtracted out
// 0.045→0.10: at 4.5% the band kept several bumps across the print, and the
// radial wrap amplifies each into an in/out edge wobble (the mangled border
// in image 8 — NOT fixable by lowering gain, the shape is wrong). At 10%
// (near the 16% body scale) only ONE gentle low-order undulation survives →
// clean, monotonic, natural edges. On a flat white tee this is necessarily
// subtle — there is no real chest-fold signal to show without faking it.
const FOLD_MID_FRAC = 0.10;
// 4.0→2.0: image 7 was "折叠过度" — the fold band was bending the artwork
// deeper than a real tee creases. Halved to a natural, shallow undulation;
// the "贴合·真褶皱" slider fine-tunes the rest live.
const FOLD_FIELD_GAIN = 2.0;

export function buildLumaFold(photo: HTMLImageElement): HTMLCanvasElement {
  const w = photo.naturalWidth;
  const h = photo.naturalHeight;
  const minDim = Math.min(w, h);

  const gray = grayCanvas(photo, w, h, DENOISE_PX);
  const low = blurredCopy(gray, w, h, Math.max(40, Math.round(minDim * FOLD_LOW_FRAC)));
  const mid = blurredCopy(gray, w, h, Math.max(12, Math.round(minDim * FOLD_MID_FRAC)));
  const lowD = low.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h).data;
  const midD = mid.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h).data;

  const out = makeCanvas(w, h);
  const octx = out.getContext('2d', { willReadFrequently: true })!;
  const od = octx.createImageData(w, h);
  const dd = od.data;
  for (let i = 0; i < dd.length; i += 4) {
    // DoG band-pass: fold-scale only, body removed, inherently smooth
    // (both terms blurred ⇒ no high-freq to tear at the mesh vertices).
    const v = grayClamp(0.5 + (FOLD_FIELD_GAIN * (midD[i] - lowD[i])) / 255);
    const b = Math.round(v * 255);
    dd[i] = b;
    dd[i + 1] = b;
    dd[i + 2] = b;
    dd[i + 3] = 255;
  }
  octx.putImageData(od, 0, 0);
  return out;
}

function grayClamp(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function buildLumaLight(
  photo: HTMLImageElement,
  cloth: HTMLCanvasElement | null
): HTMLCanvasElement {
  const w = photo.naturalWidth;
  const h = photo.naturalHeight;
  const minDim = Math.min(w, h);

  const gray = grayCanvas(photo, w, h, DENOISE_PX);
  const formC = blurredCopy(gray, w, h, Math.max(24, Math.round(minDim * LIGHT_FORM_BLUR_FRAC)));
  const foldBlurC = blurredCopy(gray, w, h, Math.max(8, Math.round(minDim * LIGHT_FOLD_RADIUS_FRAC)));

  const grayD = gray.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h).data;
  const formD = formC.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h).data;
  const foldBlurD = foldBlurC.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h).data;

  let maskD: Uint8ClampedArray | null = null;
  if (cloth) {
    const fe = Math.max(2, Math.round(minDim * EDGE_FEATHER_FRAC));
    const fm = blurredCopy(cloth, w, h, fe);
    maskD = fm.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h).data;
  }

  const formMean = maskedMean(formD, maskD);
  const formOff = 0.5 - formMean;

  const out = makeCanvas(w, h);
  const octx = out.getContext('2d', { willReadFrequently: true })!;
  const od = octx.createImageData(w, h);
  const dd = od.data;
  const dc = 0.5 - 0.5 * LIGHT_FORM_W - 0.5 * LIGHT_FOLD_W;
  for (let i = 0; i < dd.length; i += 4) {
    const form = grayClamp(formD[i] / 255 + formOff);
    const fold = steepen(0.5 + LIGHT_FOLD_GAIN * (grayD[i] - foldBlurD[i]) / 255, 4);
    let v = LIGHT_FORM_W * form + LIGHT_FOLD_W * fold + dc;
    v = steepen(v, LIGHT_STEEPEN_K);
    if (maskD) {
      const m = maskD[i] / 255;
      v = v * m + 0.5 * (1 - m); // grey50 off-garment → identity after remap
    }
    // Neutral 0.5 → 255 (identity); shadows pull the multiply toward 0;
    // highlights clamp at identity (only-darken, like buildLightMap's 2×).
    const b = Math.max(0, Math.min(255, Math.round(Math.min(1, 2 * v) * 255)));
    dd[i] = b;
    dd[i + 1] = b;
    dd[i + 2] = b;
    dd[i + 3] = 255;
  }
  octx.putImageData(od, 0, 0);
  return blurredCopy(out, w, h, FINAL_BLUR_PX);
}

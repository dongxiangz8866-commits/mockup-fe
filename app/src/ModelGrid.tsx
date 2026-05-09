import { useEffect, useMemo, useRef, useState } from 'react';
import { detectPoseCached, readCachedPose, type PoseLandmark } from './poseDetector';
import { getPattern, subscribePattern } from './textureStore';
import { PRINT_H_UV, PRINT_U, PRINT_V, PRINT_W_UV } from './modelAssets';
import {
  buildShadingMap,
  classifyShirt,
  decodeCachedMap,
  loadCachedMap,
  preprocessForShading,
  quadFromLandmarks,
  sampleGarment,
  saveCachedMap,
  useModelUrls,
  type GarmentSample,
  type Quad,
  type ShadingInput,
  type ShirtClass,
} from './shading';

// Module-level in-memory caches keyed by src URL. localStorage already caches
// pose + high-pass, but each lookup re-decodes a data URL into an Image —
// adding a frame of "加载中" UI on every mount. The mem caches keep the live
// HTMLImageElement / HTMLCanvasElement so the modal's second mount renders
// instantly without ever showing a loading badge.
const photoMemCache = new Map<string, HTMLImageElement>();
const shadingMemCache = new Map<string, HTMLCanvasElement>();
// Wide-band shading map (big-blur ≈ 10% min dim) captures 30-80 px wrinkles
// that the narrow map (5%) eats because the kernel sits inside the fold.
// Same DoG encoding, only the big-blur radius doubles. Used additively for
// black/colored shirts; white preset zeroes it out so white-shirt output is
// byte-identical to the pre-wide-map era.
const wideShadingMemCache = new Map<string, HTMLCanvasElement>();
const highlightMemCache = new Map<string, HTMLCanvasElement>();

// Aggregate shirt-fabric color stats sampled from a pattern-free band of the
// print quad. Drives the print-on-cloth blend: chromatic adaptation, black
// level lift, sharpness — all of which kill the "sticker" feel where a pure
// pattern is drawn over the photo with no awareness of the shirt's color
// cast or shadow level.
const garmentMemCache = new Map<string, GarmentSample>();
const fabricMemCache = new Map<string, HTMLCanvasElement>();

// Per-shirt-type tunable preset. Decided once per photo from the GarmentSample;
// keeps the render pipeline branchless. Captures the asymmetry between shirts:
//   • white tees need pattern blacks lifted so they don't read as ink-on-paper,
//     and folds/highlights softer because shirt itself is bright (extra contrast
//     fights with the natural shirt look)
//   • black tees the opposite — no lift (would gray-wash pattern), STRONGER folds
//     because the black shirt's fold contrast is naturally subtle
//   • colored tees in between, with stronger chromatic adaptation since the
//     shirt's hue dominates the perceived integration
type PresetCfg = {
  tint: number;             // chromatic adaptation mix
  liftFrac: number;         // fraction of garment.lumP5 to use as black-level floor
  liftMin: number;          // absolute byte floor for pattern lift (overrides liftFrac when larger). Dark shirts: ≥55 so pattern blacks don't merge with shirt's near-black background.
  foldMul: number;          // step 2.5 fitAlpha multiplier (narrow-band shading)
  wideFoldMul: number;      // step 2.5b alpha for wide-band shading map
  hlMul: number;            // step 2.6 hlAlpha multiplier
  fabricMul: number;        // step 2.7 fabric texture overlay alpha
  bendExp: number;          // cylinder bend exponent (1.0 = no bend; >1 compresses edges)
  edgeShadowPx: number;     // step 1.5d inner-shadow blur radius (pattern edge → cloth)
  edgeShadowAlpha: number;  // step 1.5d inner-shadow strength (0 disables — white preserves invariance)
};
// White preset is the locked reference — anything that touches map encoding
// is held to "white shirt unchanged". Dark-shirt smoothness is solved at the
// FLOOR (the ratio divisor clamp) inside buildShadingMap/buildHighlightMap,
// not by per-preset multiplier hacks: floor=50 doubles the divisor on near-
// black fabric, halving sensor-noise amplification, while leaving lB>50
// pixels (every white-shirt pixel) byte-identical.
//
// color.tint is small (0.12) because saturated shirts (red, blue, etc.)
// produce very asymmetric chromatic-adaptation gains. At 0.40 a red shirt
// pushes pattern G/B channels to 0.67× → pattern whites read as pink, blues
// turn magenta. 0.12 keeps a hint of color cohesion without overwriting
// pattern colors.
// wideFoldMul = 0 on white: keeps white shirt byte-identical to the prior
// pipeline. The wide-band shading map exists only to give black/colored
// shirts a fold signal in the 30-80 px range where the narrow map's
// 5%-blur kernel sits inside the fold (lB ≈ lS, no signal). Black at 0.85
// is strongest because dark-shirt fold contrast is naturally subtle and
// most photos there have only mid-frequency drape; color at 0.55 is the
// cautious middle.
// black preset (now ACTUALLY reachable after classifyShirt fix):
//   liftMin=50  pattern dark content lifted above shirt's byte 5-30 range
//               so the cat-illustration smoke / silhouette does not merge
//               into a single black blob. Cost: ~20% pattern contrast loss,
//               worth it to preserve pattern shape on dark fabric.
//   foldMul=0.40 / wideFoldMul=0.20  mild fold cue. Combined with A1's
//               [10,120] DoG amplification this gives visible fold lines on
//               bright pattern areas without crushing dark areas.
//   hlMul=0.50  modest bump highlight (was 0.95 — too aggressive when paired
//               with lift). fabricMul=0.15 keeps shirt grain transfer subtle.
const PRESETS: Record<ShirtClass, PresetCfg> = {
  white: { tint: 0.20, liftFrac: 0.10, liftMin: 0,  foldMul: 1.10, wideFoldMul: 0.0,  hlMul: 0.90, fabricMul: 0.20, bendExp: 1.10, edgeShadowPx: 1.5, edgeShadowAlpha: 0.0 },
  black: { tint: 0.30, liftFrac: 0.0,  liftMin: 50, foldMul: 0.40, wideFoldMul: 0.20, hlMul: 0.50, fabricMul: 0.15, bendExp: 1.15, edgeShadowPx: 2.0, edgeShadowAlpha: 0.0 },
  color: { tint: 0.12, liftFrac: 0.08, liftMin: 0,  foldMul: 1.00, wideFoldMul: 0.55, hlMul: 0.92, fabricMul: 0.22, bendExp: 1.12, edgeShadowPx: 1.5, edgeShadowAlpha: 0.0 },
};

const SHADING_CACHE_PREFIX = 'sh-cache:v12:';
const WIDE_SHADING_CACHE_PREFIX = 'wsh-cache:v5:';
const HIGHLIGHT_CACHE_PREFIX = 'hl-cache:v6:';
const FABRIC_CACHE_PREFIX = 'fb-cache:v1:';


// Highlight map for the SCREEN pass: encodes only strong bright bumps via
// the same ratio-with-floor as the shading map, with a small relative
// threshold so faint local brightenings don't trigger. Sub-threshold
// variations stay at byte 0 (screen identity) so the pass doesn't
// desaturate flat / mildly-varying pattern regions.
//
// Mirrors the shading-map encoding: ratio captures the perceptual
// brightness change (a 5-byte bump on near-black fabric is a real
// fold-edge cue; the floor stops near-black noise from registering as a
// "huge" relative bump).
//
// Why screen blend (not hard-light): screen's `bg + (1-bg)·src` preserves
// already-bright channels — yellow's R/G stay at 1, only B (dim) lifts a
// little. Hard-light would wash saturation by lifting all channels toward 1.
//
// Threshold ratio 0.04, scale 600: only relative bumps above ~4% contribute;
// a 15% bump (typical strong shirt highlight) produces byte ~66 which
// combined with low globalAlpha stays subtle.
function buildHighlightMap(photo: HTMLImageElement): HTMLCanvasElement {
  const w = photo.naturalWidth;
  const h = photo.naturalHeight;
  const blurRadius = Math.max(40, Math.round(Math.min(w, h) * 0.05));
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
    // Mirrors buildShadingMap: small-blur denoise + FLOOR=40 + DoG
    // numerator. Wide-area highlights (specular sheen on torso curvature)
    // cancel because both blurs track them; only sharp bump-edges remain.
    const FLOOR = 40;
    const r = (lS - lB) / Math.max(lB, FLOOR);
    const v = Math.max(0, Math.min(255, Math.round((r - 0.04) * 600)));
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
  dctx.filter = `blur(${Math.max(2, Math.round(Math.min(w, h) * 0.003))}px)`;
  dctx.drawImage(origC, 0, 0);
  return denoised;
}

// Pre-process the warped pattern (already drawn into `tmp`) so it reads as
// printed-on-cloth instead of pasted-on-sticker. Three transforms, all
// per-pixel within pattern alpha (transparent BG untouched):
//   1. Chromatic adaptation — shift pattern's color cast toward the shirt's
//      via a per-channel gain `1 - mix·(1 - shirt_norm_channel)`. Preserves
//      luminance, only adds the shirt's hue. Works correctly for any shirt
//      color (white tees pick up subtle warm/cool cast; black/colored tees
//      shift the pattern's whites without dimming them).
//   2. Black level lift — remap `[0..255]` to `[lift..255]` so pattern blacks
//      can't go below the shirt's local shadow level. Pure black ink on a
//      light shirt (where shadow = ~200) was the strongest "vector sticker"
//      cue; lifting kills it. On dark shirts lift ≈ 4-6 → effectively no-op.
//   3. (No blur here — applied at composite time via ctx.filter so the alpha
//      edge softens too, killing the cut-out vector edge.)
function applyGarmentBlend(
  tmp: HTMLCanvasElement,
  garment: GarmentSample,
  preset: PresetCfg,
  bbox: { x: number; y: number; w: number; h: number }
): void {
  const cw = tmp.width;
  const ch = tmp.height;
  const x = Math.max(0, Math.floor(bbox.x));
  const y = Math.max(0, Math.floor(bbox.y));
  const w = Math.min(cw - x, Math.ceil(bbox.w + (bbox.x - x)));
  const h = Math.min(ch - y, Math.ceil(bbox.h + (bbox.y - y)));
  if (w <= 0 || h <= 0) return;
  const ctx = tmp.getContext('2d')!;
  const img = ctx.getImageData(x, y, w, h);
  const d = img.data;
  const [gr, gg, gb] = garment.rgb;
  const gMax = Math.max(gr, gg, gb, 1);
  // lift floor: max(garment-relative, absolute-byte). The relative term
  // (lumP5 * liftFrac) handles the white-shirt "vector ink" cue (pattern
  // blacks must not sink below shirt's shadow level). The absolute term
  // (liftMin) handles the dark-shirt "invisible blob" cue (pattern blacks
  // must be visibly above shirt's mid-tone). White: lumP5*liftFrac=22
  // dominates over liftMin=0 (no change). Black: liftMin=55+ dominates over
  // lumP5*liftFrac=0 (pattern lifted to liftMin).
  const lift = Math.max(garment.lumP5 * preset.liftFrac, preset.liftMin);
  const liftScale = (255 - lift) / 255;
  if (import.meta.env.DEV) {
    console.log(`[blend] lift=${lift.toFixed(0)} liftMin=${preset.liftMin} foldMul=${preset.foldMul} wideFoldMul=${preset.wideFoldMul} fabricMul=${preset.fabricMul}`);
  }
  const cR = 1 - preset.tint * (1 - gr / gMax);
  const cG = 1 - preset.tint * (1 - gg / gMax);
  const cB = 1 - preset.tint * (1 - gb / gMax);
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    d[i] = lift + d[i] * cR * liftScale;
    d[i + 1] = lift + d[i + 1] * cG * liftScale;
    d[i + 2] = lift + d[i + 2] * cB * liftScale;
  }
  ctx.putImageData(img, x, y);
}

// Fabric texture map: high-frequency luminance content of the photo, encoded
// around byte 128 (overlay/hard-light identity). Built from a small-radius
// blur (~0.2% of min dim, capturing weave/grain frequencies) so the result
// is the "shirt's microstructure" — fabric weave, sensor grain, lighting
// micro-patterns. Applied as an overlay-blend pass within pattern alpha at
// low alpha (preset.fabricMul × foldStrength), it transfers the shirt's
// surface character onto the pattern. Without this, the pattern reads as
// "smooth printed surface" against the shirt's textured surface — a key
// sticker-cue.
function buildFabricTexture(photo: HTMLImageElement): HTMLCanvasElement {
  const w = photo.naturalWidth;
  const h = photo.naturalHeight;
  const blurRadius = Math.max(2, Math.round(Math.min(w, h) * 0.002));
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
  const O = origCtx.getImageData(0, 0, w, h);
  const B = blurCtx.getImageData(0, 0, w, h);
  const out = origCtx.createImageData(w, h);
  const Od = O.data;
  const Bd = B.data;
  const Dd = out.data;
  for (let i = 0; i < Od.length; i += 4) {
    const lO = Od[i] * 0.299 + Od[i + 1] * 0.587 + Od[i + 2] * 0.114;
    const lB = Bd[i] * 0.299 + Bd[i + 1] * 0.587 + Bd[i + 2] * 0.114;
    // Amplify slightly (×1.5) so the high-freq content survives the low-alpha
    // overlay blend and ×0.5 dampening from JPEG cache compression.
    const v = Math.max(0, Math.min(255, 128 + (lO - lB) * 1.5));
    Dd[i] = v;
    Dd[i + 1] = v;
    Dd[i + 2] = v;
    Dd[i + 3] = 255;
  }
  origCtx.putImageData(out, 0, 0);
  return origC;
}

// Cylinder-bend approximation. Re-samples the pattern bbox region of `tmp`
// horizontally with a power-curve `src_norm = sign(out) · |out|^p` (p>1
// compresses edges, stretches center). Visually gives the print a slight
// "wrapped on torso" cue that flat pattern composite lacks.
//
// Implementation: copy bbox into a buffer, clear bbox in tmp, then redraw
// in N vertical strips with non-linear horizontal source mapping. drawImage
// with imageSmoothingEnabled does the bilinear sub-pixel sampling so the
// result is smooth even at small bend magnitudes.
//
// Cost: ~24 drawImage calls inside bbox = ~3-5 ms per render. Skipped when
// bendExp is 1.0 (no-op).
function applyCylindricalBend(
  tmp: HTMLCanvasElement,
  bbox: { x: number; y: number; w: number; h: number },
  bendExp: number,
  buf: HTMLCanvasElement
): void {
  if (bendExp <= 1.001) return;
  const cw = tmp.width;
  const ch = tmp.height;
  const x = Math.max(0, Math.floor(bbox.x));
  const y = Math.max(0, Math.floor(bbox.y));
  const w = Math.min(cw - x, Math.ceil(bbox.w + (bbox.x - x)));
  const h = Math.min(ch - y, Math.ceil(bbox.h + (bbox.y - y)));
  if (w <= 0 || h <= 0) return;
  if (buf.width !== w || buf.height !== h) {
    buf.width = w;
    buf.height = h;
  }
  const bctx = buf.getContext('2d')!;
  bctx.clearRect(0, 0, w, h);
  bctx.drawImage(tmp, x, y, w, h, 0, 0, w, h);
  const ctx = tmp.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(x, y, w, h);
  const N = 24;
  for (let i = 0; i < N; i++) {
    const tA = (i / N) * 2 - 1;
    const tB = ((i + 1) / N) * 2 - 1;
    const sA = Math.sign(tA) * Math.pow(Math.abs(tA), bendExp);
    const sB = Math.sign(tB) * Math.pow(Math.abs(tB), bendExp);
    const outA = ((tA + 1) * 0.5) * w;
    const outB = ((tB + 1) * 0.5) * w;
    const srcA = ((sA + 1) * 0.5) * w;
    const srcB = ((sB + 1) * 0.5) * w;
    const sw = srcB - srcA;
    const ow = outB - outA;
    if (sw <= 0 || ow <= 0) continue;
    ctx.drawImage(buf, srcA, 0, sw, h, x + outA, y, ow, h);
  }
}

// Soft inner shadow on the pattern's alpha edge — kills the "vector cut-out
// sticker" cue by darkening a 1.5-2 px ring inside the alpha boundary so the
// print reads as ink absorbed into cloth at its border instead of a decal
// sitting flat on top.
//
// Recipe: Porter-Duff in three composite ops, no per-pixel JS.
//   buf := tmp's bbox region (RGB+alpha)
//   buf := buf with RGB replaced by translucent black, masked to original
//          alpha (source-in fill)
//   buf := buf MINUS blurred(tmp) (destination-out) — the blurred alpha is a
//          slightly-eroded version of the pattern shape; subtracting it from
//          the full-shape black leaves only the soft inner-edge ring.
//   tmp := tmp with `source-atop drawImage(buf)` — paints the ring onto tmp
//          only where tmp has alpha (no spill into the cloth area).
//
// Cost: 4 drawImage + 1 fillRect on a bbox-sized buffer (~250×400 typical) ≈
// 2-4 ms per render. Skipped entirely when alpha ≤ 0 (white preset) or
// when blur ≤ 0.
function applyEdgeInnerShadow(
  tmp: HTMLCanvasElement,
  bbox: { x: number; y: number; w: number; h: number },
  blurPx: number,
  strength: number,
  buf: HTMLCanvasElement
): void {
  if (strength <= 0 || blurPx <= 0) return;
  const cw = tmp.width;
  const ch = tmp.height;
  const x = Math.max(0, Math.floor(bbox.x));
  const y = Math.max(0, Math.floor(bbox.y));
  const w = Math.min(cw - x, Math.ceil(bbox.w + (bbox.x - x)));
  const h = Math.min(ch - y, Math.ceil(bbox.h + (bbox.y - y)));
  if (w <= 0 || h <= 0) return;
  if (buf.width !== w || buf.height !== h) {
    buf.width = w;
    buf.height = h;
  }
  const bctx = buf.getContext('2d')!;
  bctx.setTransform(1, 0, 0, 1, 0, 0);
  bctx.filter = 'none';
  bctx.globalCompositeOperation = 'source-over';
  bctx.clearRect(0, 0, w, h);

  bctx.drawImage(tmp, x, y, w, h, 0, 0, w, h);

  bctx.globalCompositeOperation = 'source-in';
  bctx.fillStyle = `rgba(0,0,0,${strength})`;
  bctx.fillRect(0, 0, w, h);

  bctx.globalCompositeOperation = 'destination-out';
  bctx.filter = `blur(${blurPx}px)`;
  bctx.drawImage(tmp, x, y, w, h, 0, 0, w, h);
  bctx.filter = 'none';
  bctx.globalCompositeOperation = 'source-over';

  const ctx = tmp.getContext('2d')!;
  ctx.save();
  ctx.globalCompositeOperation = 'source-atop';
  ctx.drawImage(buf, 0, 0, w, h, x, y, w, h);
  ctx.restore();
}

function ModelComposite({
  src,
  foldStrength,
  onClick,
  large = false,
  zoom = 1,
}: {
  src: string;
  foldStrength: number;
  onClick?: () => void;
  large?: boolean;
  zoom?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const photoRef = useRef<HTMLImageElement | null>(null);
  const shadingRef = useRef<HTMLCanvasElement | null>(null);
  const wideShadingRef = useRef<HTMLCanvasElement | null>(null);
  const highlightRef = useRef<HTMLCanvasElement | null>(null);
  const fabricRef = useRef<HTMLCanvasElement | null>(null);
  // Reused per-render scratch canvases — avoids 4 × full-res allocations per
  // pattern drag tick. Sized lazily to match photo dimensions.
  const tmpRef = useRef<HTMLCanvasElement | null>(null);
  const smRef = useRef<HTMLCanvasElement | null>(null);
  const wsmRef = useRef<HTMLCanvasElement | null>(null);
  const hmRef = useRef<HTMLCanvasElement | null>(null);
  const fmRef = useRef<HTMLCanvasElement | null>(null);
  // Cylinder bend's source buffer — sized to bbox, not full canvas, so it's
  // smaller than the others. Allocated lazily.
  const bendBufRef = useRef<HTMLCanvasElement | null>(null);
  const edgeShadowBufRef = useRef<HTMLCanvasElement | null>(null);

  // Hydrate from in-memory caches synchronously so a re-mount (e.g. modal)
  // for a previously-rendered src boots straight to 'ready' — no loading UI.
  const initPhoto = photoMemCache.get(src) ?? null;
  const initShading = shadingMemCache.get(src) ?? null;
  const initWideShading = wideShadingMemCache.get(src) ?? null;
  const initHighlight = highlightMemCache.get(src) ?? null;
  const initFabric = fabricMemCache.get(src) ?? null;
  const initPose = initPhoto ? readCachedPose(src) : null;
  if (initPhoto && photoRef.current !== initPhoto) photoRef.current = initPhoto;
  if (initShading && shadingRef.current !== initShading) shadingRef.current = initShading;
  if (initWideShading && wideShadingRef.current !== initWideShading)
    wideShadingRef.current = initWideShading;
  if (initHighlight && highlightRef.current !== initHighlight) highlightRef.current = initHighlight;
  if (initFabric && fabricRef.current !== initFabric) fabricRef.current = initFabric;

  const [photoSize, setPhotoSize] = useState<{ w: number; h: number } | null>(() =>
    initPhoto ? { w: initPhoto.naturalWidth, h: initPhoto.naturalHeight } : null
  );
  const [quad, setQuad] = useState<Quad | null>(() =>
    initPhoto && initPose
      ? quadFromLandmarks(initPose, initPhoto.naturalWidth, initPhoto.naturalHeight)
      : null
  );
  const [status, setStatus] = useState<'loading' | 'pose' | 'ready' | 'fail'>(() =>
    initPhoto &&
    initShading &&
    initWideShading &&
    initHighlight &&
    initFabric &&
    initPose
      ? 'ready'
      : 'loading'
  );

  useEffect(() => {
    let cancelled = false;
    // Fast path: everything already hydrated from mem caches.
    if (
      photoRef.current &&
      shadingRef.current &&
      wideShadingRef.current &&
      highlightRef.current &&
      fabricRef.current &&
      quad
    )
      return;

    setStatus('loading');
    const img = photoRef.current ?? new Image();
    if (!photoRef.current) img.crossOrigin = 'anonymous';

    const onReady = async (image: HTMLImageElement) => {
      if (cancelled) return;
      photoRef.current = image;
      photoMemCache.set(src, image);
      setPhotoSize({ w: image.naturalWidth, h: image.naturalHeight });

      // Pose first: gives us the print quad which doubles as the shirt
      // sampling region for the shading-map preprocess (luminance stretch
      // on dark shirts). Without pose, the central-region heuristic was
      // unreliable — face + background lift the percentile above the dark-
      // shirt threshold. Pose is ~1-2 s cold but <5 ms cached.
      setStatus('pose');
      let lm: PoseLandmark[] | null = null;
      try {
        lm = await detectPoseCached(image, src);
      } catch (e) {
        if (cancelled) return;
        console.warn('pose fail', e);
      }
      if (cancelled) return;
      const detectedQuad = lm
        ? quadFromLandmarks(lm, image.naturalWidth, image.naturalHeight)
        : null;

      // Shading + highlight maps are foldStrength-independent (slider scales
      // effects at render time via globalAlpha). Cache chain: mem cache →
      // localStorage (half-res JPEG, ~50 KB each) → rebuild from photo.
      // The localStorage tier means a page reload skips the ~100-200 ms
      // per-photo ImageData scan and just decodes a small JPEG.
      //
      // Lazy preprocess: dark/colored shirts get luminance-stretched before
      // DoG runs (see preprocessForShading). Computed at most once per src,
      // skipped entirely when both shading caches hit. White / light photos
      // exit preprocessForShading as identity, so this is invariant for them.
      let _shadingInput: ShadingInput | null = null;
      const getShadingInput = () =>
        (_shadingInput ?? (_shadingInput = preprocessForShading(image, detectedQuad)));

      let sh = shadingMemCache.get(src) ?? null;
      if (!sh) {
        const cachedSh = loadCachedMap(SHADING_CACHE_PREFIX, src);
        if (cachedSh) {
          sh = await decodeCachedMap(cachedSh, image.naturalWidth, image.naturalHeight);
          if (cancelled) return;
        } else {
          sh = buildShadingMap(getShadingInput());
          saveCachedMap(SHADING_CACHE_PREFIX, src, sh);
        }
        shadingMemCache.set(src, sh);
      }
      if (cancelled) return;
      shadingRef.current = sh;

      // Wide-band variant — same encoding, big-blur 10% instead of 5%.
      // Captures 30-80 px wrinkles where the 5% kernel sits inside the
      // fold and erases its own signal.
      let wsh = wideShadingMemCache.get(src) ?? null;
      if (!wsh) {
        const cachedWsh = loadCachedMap(WIDE_SHADING_CACHE_PREFIX, src);
        if (cachedWsh) {
          wsh = await decodeCachedMap(cachedWsh, image.naturalWidth, image.naturalHeight);
          if (cancelled) return;
        } else {
          wsh = buildShadingMap(getShadingInput(), 0.1);
          saveCachedMap(WIDE_SHADING_CACHE_PREFIX, src, wsh);
        }
        wideShadingMemCache.set(src, wsh);
      }
      if (cancelled) return;
      wideShadingRef.current = wsh;

      let hl = highlightMemCache.get(src) ?? null;
      if (!hl) {
        const cachedHl = loadCachedMap(HIGHLIGHT_CACHE_PREFIX, src);
        if (cachedHl) {
          hl = await decodeCachedMap(cachedHl, image.naturalWidth, image.naturalHeight);
          if (cancelled) return;
        } else {
          hl = buildHighlightMap(image);
          saveCachedMap(HIGHLIGHT_CACHE_PREFIX, src, hl);
        }
        highlightMemCache.set(src, hl);
      }
      if (cancelled) return;
      highlightRef.current = hl;

      let fb = fabricMemCache.get(src) ?? null;
      if (!fb) {
        const cachedFb = loadCachedMap(FABRIC_CACHE_PREFIX, src);
        if (cachedFb) {
          fb = await decodeCachedMap(cachedFb, image.naturalWidth, image.naturalHeight);
          if (cancelled) return;
        } else {
          fb = buildFabricTexture(image);
          saveCachedMap(FABRIC_CACHE_PREFIX, src, fb);
        }
        fabricMemCache.set(src, fb);
      }
      if (cancelled) return;
      fabricRef.current = fb;

      if (detectedQuad) {
        setQuad(detectedQuad);
        setStatus('ready');
      } else {
        setStatus('fail');
      }
    };

    if (photoRef.current) {
      onReady(photoRef.current);
    } else {
      img.onload = () => onReady(img);
      img.src = src;
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);


  const render = useMemo(() => {
    void foldStrength;
    return () => {
      const photo = photoRef.current;
      const cv = canvasRef.current;
      const pat = getPattern();
      if (!photo || !cv || !photoSize) return;
      cv.width = photoSize.w;
      cv.height = photoSize.h;
      const ctx = cv.getContext('2d')!;
      ctx.drawImage(photo, 0, 0);
      if (!quad || !pat) return;

      // Step 1: warp the SOURCE pattern image directly onto the plate quad
      // via a single affine — skipping the photoPatternCanvas intermediate
      // that previously double-resampled (source → 2K canvas → quad). Single
      // pass preserves source detail, especially for low-res uploads where
      // the old chain compounded bilinear blur.
      //   - clip tmp to the plate quad so any pattern overhang is cut off.
      //   - affine maps source-pixel (sx, sy) into the box's image-space
      //     position inside the plate parallelogram (relU/V/W/H = where the
      //     pattern box sits in plate-fraction coords).
      // tmp is reused across renders (refs) to avoid per-frame allocation
      // and GC pressure when dragging the pattern.
      if (!tmpRef.current) tmpRef.current = document.createElement('canvas');
      const tmp = tmpRef.current;
      if (tmp.width !== cv.width || tmp.height !== cv.height) {
        tmp.width = cv.width;
        tmp.height = cv.height;
      }
      const tctx = tmp.getContext('2d')!;
      tctx.setTransform(1, 0, 0, 1, 0, 0);
      tctx.clearRect(0, 0, cv.width, cv.height);
      tctx.imageSmoothingEnabled = true;
      tctx.imageSmoothingQuality = 'high';
      tctx.save();
      tctx.beginPath();
      tctx.moveTo(quad.tl.x, quad.tl.y);
      tctx.lineTo(quad.tr.x, quad.tr.y);
      tctx.lineTo(quad.br.x, quad.br.y);
      tctx.lineTo(quad.bl.x, quad.bl.y);
      tctx.closePath();
      tctx.clip();
      const W = pat.width;
      const H = pat.height;
      const relU = (pat.box.u - PRINT_U) / PRINT_W_UV;
      const relV = (pat.box.v - PRINT_V) / PRINT_H_UV;
      const relW = pat.box.w / PRINT_W_UV;
      const relH = pat.box.h / PRINT_H_UV;
      const ux = quad.tr.x - quad.tl.x;
      const uy = quad.tr.y - quad.tl.y;
      const vx = quad.bl.x - quad.tl.x;
      const vy = quad.bl.y - quad.tl.y;
      const ex = quad.tl.x + relU * ux + relV * vx;
      const ey = quad.tl.y + relU * uy + relV * vy;
      const ax = (relW / W) * ux;
      const ay = (relW / W) * uy;
      const bx = (relH / H) * vx;
      const by = (relH / H) * vy;
      tctx.setTransform(ax, ay, bx, by, ex, ey);
      tctx.drawImage(pat.img, 0, 0);
      tctx.setTransform(1, 0, 0, 1, 0, 0);
      tctx.restore();

      // Step 1.5a: classify shirt and pick preset. Garment sample lazy-builds
      // on first render after pose detect, then caches per src.
      let garment = garmentMemCache.get(src) ?? null;
      if (!garment) {
        garment = sampleGarment(photo, quad);
        garmentMemCache.set(src, garment);
      }
      const preset = PRESETS[classifyShirt(garment)];

      const bbX0 = Math.min(quad.tl.x, quad.tr.x, quad.bl.x, quad.br.x);
      const bbY0 = Math.min(quad.tl.y, quad.tr.y, quad.bl.y, quad.br.y);
      const bbX1 = Math.max(quad.tl.x, quad.tr.x, quad.bl.x, quad.br.x);
      const bbY1 = Math.max(quad.tl.y, quad.tr.y, quad.bl.y, quad.br.y);
      const bbox = { x: bbX0, y: bbY0, w: bbX1 - bbX0, h: bbY1 - bbY0 };

      // Step 1.5b: cylinder bend. Slightly compresses the pattern toward the
      // body's left/right edges so it reads as wrapped on a torso instead of
      // a flat sticker. Bend exponent comes from preset (~1.10-1.15). Skipped
      // when bendExp ≤ 1.001.
      if (!bendBufRef.current) bendBufRef.current = document.createElement('canvas');
      applyCylindricalBend(tmp, bbox, preset.bendExp, bendBufRef.current);

      // Step 1.5c: print-on-cloth blend. Mutates tmp's RGB in place (alpha
      // untouched so step 2.5/2.6/2.7 masks still work). Iteration is bounded
      // to the print-quad bbox — ~20% of canvas pixels, smooth on drag.
      applyGarmentBlend(tmp, garment, preset, bbox);

      // Step 1.5d: edge inner shadow. Darkens a soft ring inside the alpha
      // boundary so the pattern reads as ink absorbed into cloth, not a flat
      // sticker. White preset has alpha=0 → no-op; black/color get the full
      // effect. The 0.5 px alpha-edge blur in step 2 still runs on top to
      // soften the cut against the photo.
      if (!edgeShadowBufRef.current) edgeShadowBufRef.current = document.createElement('canvas');
      applyEdgeInnerShadow(tmp, bbox, preset.edgeShadowPx, preset.edgeShadowAlpha, edgeShadowBufRef.current);

      // Step 2: alpha-composite the pattern over the shirt (source-over).
      // The 0.5 px blur softens both the pattern interior (sharpness match
      // with photo) AND the alpha edge (kills the cut-out vector edge that
      // reads as "sticker"). Pattern's own alpha decides coverage —
      // semi-transparent edges blend softly, transparent BG keeps shirt.
      ctx.save();
      ctx.filter = 'blur(0.5px)';
      ctx.drawImage(tmp, 0, 0);
      ctx.restore();

      // Step 2.5: vacuum-fit via hard-light with the relative-shading map.
      //
      // The shading map is photo / blur(photo) re-encoded so mid-gray (128)
      // is the multiplicative identity (ratio = 1). Hard-light at mid-gray
      // is mathematically the no-op, so pattern's nominal color in flat
      // shirt regions is preserved exactly regardless of foldStrength.
      // Below mid-gray (folds): hard-light's `2·bg·src` darkens — visible
      // fold lines through the pattern. Above mid-gray (bumps/highlights):
      // hard-light's `1 - 2·(1-bg)·(1-src)` lightens — bumps "pop" out.
      //
      // Why hard-light and not multiply: multiply only darkens. The "立体感"
      // (3D feel) cue requires BOTH dark fold valleys AND bright bump tops.
      // Without the highlights the pattern reads as flat-tinted dirt rather
      // than printed-on-cloth.
      //
      // foldStrength → globalAlpha attenuates the whole effect uniformly:
      //   0 → α=0   (no fit, pattern flat over shirt)
      //   1 → α=0.7 (default, visible fit)
      //   1.43+ → α=1.0 (clamped, full natural fit)
      // The post-blur denoise inside buildShadingMap is what keeps this
      // step from re-introducing the grainy/rotten look that the prior
      // hard-light high-pass produced.
      if (shadingRef.current) {
        const fitAlpha = preset.foldMul * Math.min(1.0, foldStrength * 0.7);
        if (fitAlpha > 0) {
          if (!smRef.current) smRef.current = document.createElement('canvas');
          const sm = smRef.current;
          if (sm.width !== cv.width || sm.height !== cv.height) {
            sm.width = cv.width;
            sm.height = cv.height;
          }
          const sctx = sm.getContext('2d')!;
          sctx.globalCompositeOperation = 'source-over';
          sctx.clearRect(0, 0, cv.width, cv.height);
          sctx.drawImage(tmp, 0, 0);
          sctx.globalCompositeOperation = 'source-in';
          sctx.drawImage(shadingRef.current, 0, 0);
          ctx.save();
          ctx.globalCompositeOperation = 'hard-light';
          ctx.globalAlpha = fitAlpha;
          ctx.drawImage(sm, 0, 0);
          ctx.restore();
        }
      }

      // Step 2.5b: wide-band fold pass.
      //
      // Step 2.5's narrow map (5% blur) erases its own signal on folds wider
      // than ~50 px because the kernel sits inside the fold body — common on
      // soft-drape t-shirts where 30-80 px folds dominate. The wide map
      // (10% blur) sees those folds clearly because lB averages mostly
      // outside-fold material at the fold center → DoG signal returns.
      //
      // White preset zeroes wideFoldMul, so white-shirt output is byte-
      // identical to the pre-wide-map era (no extra hard-light pass touches
      // it). Black/colored shirts get the additional fold cue at presets
      // 0.85 / 0.55, scaled by the same foldStrength·0.7 envelope as the
      // narrow pass.
      if (wideShadingRef.current && preset.wideFoldMul > 0) {
        const wideAlpha = preset.wideFoldMul * Math.min(1.0, foldStrength * 0.7);
        if (wideAlpha > 0) {
          if (!wsmRef.current) wsmRef.current = document.createElement('canvas');
          const wsm = wsmRef.current;
          if (wsm.width !== cv.width || wsm.height !== cv.height) {
            wsm.width = cv.width;
            wsm.height = cv.height;
          }
          const wctx = wsm.getContext('2d')!;
          wctx.globalCompositeOperation = 'source-over';
          wctx.clearRect(0, 0, cv.width, cv.height);
          wctx.drawImage(tmp, 0, 0);
          wctx.globalCompositeOperation = 'source-in';
          wctx.drawImage(wideShadingRef.current, 0, 0);
          ctx.save();
          ctx.globalCompositeOperation = 'hard-light';
          ctx.globalAlpha = wideAlpha;
          ctx.drawImage(wsm, 0, 0);
          ctx.restore();
        }
      }

      // Step 2.6: weak screen highlight on strong bumps only. Pattern picks
      // up the shirt's bright bumps via screen blend (additive lift bounded
      // by 1-bg, so already-bright pattern pixels barely change). Threshold
      // baked into the highlight map (ratio > 1.05) keeps flat / mildly
      // varying regions at byte 0 = screen identity. Low globalAlpha keeps
      // even strong bumps from washing saturation.
      if (highlightRef.current) {
        const hlAlpha = preset.hlMul * Math.min(0.35, foldStrength * 0.15);
        if (hlAlpha > 0) {
          if (!hmRef.current) hmRef.current = document.createElement('canvas');
          const hm = hmRef.current;
          if (hm.width !== cv.width || hm.height !== cv.height) {
            hm.width = cv.width;
            hm.height = cv.height;
          }
          const hctx = hm.getContext('2d')!;
          hctx.globalCompositeOperation = 'source-over';
          hctx.clearRect(0, 0, cv.width, cv.height);
          hctx.drawImage(tmp, 0, 0);
          hctx.globalCompositeOperation = 'source-in';
          hctx.drawImage(highlightRef.current, 0, 0);
          ctx.save();
          ctx.globalCompositeOperation = 'screen';
          ctx.globalAlpha = hlAlpha;
          ctx.drawImage(hm, 0, 0);
          ctx.restore();
        }
      }

      // Step 2.7: fabric texture overlay. Transfers the shirt's high-frequency
      // microstructure (weave / sensor grain / lighting micro-pattern) onto
      // the pattern. The fabric map is encoded around byte 128 = overlay
      // identity, so flat regions of the fabric (rare on real photos) leave
      // pattern unchanged. Strength is preset.fabricMul × foldStrength*0.5,
      // capped low so it adds character without graying the pattern.
      if (fabricRef.current) {
        const fabAlpha = preset.fabricMul * Math.min(1.0, foldStrength * 0.5);
        if (fabAlpha > 0) {
          if (!fmRef.current) fmRef.current = document.createElement('canvas');
          const fm = fmRef.current;
          if (fm.width !== cv.width || fm.height !== cv.height) {
            fm.width = cv.width;
            fm.height = cv.height;
          }
          const fctx = fm.getContext('2d')!;
          fctx.globalCompositeOperation = 'source-over';
          fctx.clearRect(0, 0, cv.width, cv.height);
          fctx.drawImage(tmp, 0, 0);
          fctx.globalCompositeOperation = 'source-in';
          fctx.drawImage(fabricRef.current, 0, 0);
          ctx.save();
          ctx.globalCompositeOperation = 'overlay';
          ctx.globalAlpha = fabAlpha;
          ctx.drawImage(fm, 0, 0);
          ctx.restore();
        }
      }

      // Step 3 (hard-light high-pass) was removed. Stacking it on top of
      // step 2.5's shading multiply double-baked the photo's high-frequency
      // content (sensor noise, JPEG block artifacts, fabric microstructure)
      // into the pattern, producing a "rotten" / grainy look in fold areas.
      // Step 2.5's relative-shading multiply already gives the full vacuum-
      // fit cue — folds darken the pattern smoothly via the photo / blur
      // ratio. Adding hard-light high-pass on top contributed extra punch
      // at the cost of visible noise. The reference renders we're matching
      // (e.g. Image #8) show clean pattern colors with subtle smooth fold
      // modulation only; one fold-modulation layer is enough.
    };
  }, [quad, photoSize, foldStrength]);

  useEffect(() => {
    render();
    const unsub = subscribePattern(render);
    return unsub;
  }, [render]);

  const aspect = photoSize ? photoSize.w / photoSize.h : 0.667;
  const itemStyle: React.CSSProperties = large
    ? {
        aspectRatio: `${aspect}`,
        height: `${85 * (zoom ?? 1)}vh`,
        maxWidth: zoom && zoom > 1 ? undefined : '90vw',
      }
    : { flex: `${aspect} 1 0`, aspectRatio: `${aspect}` };
  return (
    <div
      className={`model-item ${large ? 'model-item-large' : ''}`}
      style={itemStyle}
      onClick={onClick}
      data-model-url={src}
      data-model-status={status}
    >
      <canvas ref={canvasRef} className="model-canvas" />
      {status !== 'ready' && (
        <span className={`model-tag tag-${status}`}>
          {status === 'loading' ? '加载中…' : status === 'pose' ? '识别姿态…' : '识别失败'}
        </span>
      )}
    </div>
  );
}

export default function ModelGrid() {
  const [foldStrength, setFoldStrength] = useState(2.0);
  const [selected, setSelected] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const photoUrls = useModelUrls();

  useEffect(() => {
    if (!selected) return;
    setZoom(1);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelected(null);
      else if (e.key === '+' || e.key === '=')
        setZoom((z) => Math.min(2.5, +(z + 0.2).toFixed(2)));
      else if (e.key === '-' || e.key === '_')
        setZoom((z) => Math.max(0.4, +(z - 0.2).toFixed(2)));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected]);

  return (
    <div className="model-grid-root">
      <div className="model-grid-toolbar">
        <span className="model-grid-title">真人模特</span>
        <div className="fold-control">
          <label htmlFor="grid-fold">褶皱强度</label>
          <input
            id="grid-fold"
            type="range"
            min={0}
            max={4}
            step={0.25}
            value={foldStrength}
            onChange={(e) => setFoldStrength(Number(e.target.value))}
          />
          <span className="fold-value">{foldStrength.toFixed(2)}</span>
        </div>
      </div>
      <div className="model-grid">
        {photoUrls.map((url) => (
          <ModelComposite
            key={url}
            src={url}
            foldStrength={foldStrength}
            onClick={() => setSelected(url)}
          />
        ))}
      </div>
      {selected && (
        <div
          className="model-modal"
          onClick={() => setSelected(null)}
          role="dialog"
          aria-modal="true"
        >
          <button
            className="model-modal-close"
            onClick={(e) => {
              e.stopPropagation();
              setSelected(null);
            }}
            aria-label="关闭"
          >
            ×
          </button>
          <div
            className="model-modal-scroll"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="model-modal-content">
              <ModelComposite
                src={selected}
                foldStrength={foldStrength}
                large
                zoom={zoom}
              />
            </div>
          </div>
          <div
            className="model-modal-controls"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="modal-zoom-btn"
              onClick={() => setZoom((z) => Math.max(0.4, +(z - 0.2).toFixed(2)))}
              aria-label="缩小"
              title="缩小"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <path
                  d="M5 12h14"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
            <span className="modal-zoom-value">{Math.round(zoom * 100)}%</span>
            <button
              className="modal-zoom-btn"
              onClick={() => setZoom((z) => Math.min(2.5, +(z + 0.2).toFixed(2)))}
              aria-label="放大"
              title="放大"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <path
                  d="M5 12h14M12 5v14"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
            <button
              className="modal-zoom-btn modal-zoom-reset"
              onClick={() => setZoom(1)}
              title="重置"
            >
              1×
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

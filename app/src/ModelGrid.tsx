import { useEffect, useMemo, useRef, useState } from 'react';
import { detectPoseCached, POSE_INDEX, readCachedPose, type PoseLandmark } from './poseDetector';
import { getPattern, subscribePattern } from './textureStore';
import { PRINT_ASPECT, PRINT_H_UV, PRINT_U, PRINT_V, PRINT_W_UV } from './modelAssets';

// Module-level in-memory caches keyed by src URL. localStorage already caches
// pose + high-pass, but each lookup re-decodes a data URL into an Image —
// adding a frame of "加载中" UI on every mount. The mem caches keep the live
// HTMLImageElement / HTMLCanvasElement so the modal's second mount renders
// instantly without ever showing a loading badge.
const photoMemCache = new Map<string, HTMLImageElement>();
const highPassMemCache = new Map<string, HTMLCanvasElement>();
const shadingMemCache = new Map<string, HTMLCanvasElement>();
const memHpKey = (src: string, s: number) => `${src}|s=${s}`;

const HIGHPASS_CACHE_PREFIX = 'hp-cache:v1:';

function loadCachedHighPass(key: string): HTMLImageElement | null {
  try {
    const data = localStorage.getItem(HIGHPASS_CACHE_PREFIX + key);
    if (!data) return null;
    const img = new Image();
    img.src = data;
    return img;
  } catch {
    return null;
  }
}

function saveCachedHighPass(key: string, canvas: HTMLCanvasElement): void {
  try {
    const data = canvas.toDataURL('image/jpeg', 0.6);
    localStorage.setItem(HIGHPASS_CACHE_PREFIX + key, data);
  } catch {
    // quota — ignore
  }
}

type ModelEntry = { url: string; mtime: number };
const toUrls = (list: ModelEntry[]) => list.map((m) => `${m.url}?v=${m.mtime}`);

// Dev: poll /api/models so add/delete in /public/models reflects without
// restarting Vite (build-time __MODELS__ is frozen at config load). The
// dev plugin also broadcasts a custom HMR event on directory change.
function useModelUrls(): string[] {
  const [urls, setUrls] = useState<string[]>(() => toUrls(__MODELS__));
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const r = await fetch('/api/models');
        if (!r.ok) return;
        const list = (await r.json()) as ModelEntry[];
        if (!cancelled) setUrls(toUrls(list));
      } catch {
        // ignore — keep last known list
      }
    };
    refresh();
    if (import.meta.hot) {
      import.meta.hot.on('models-changed', refresh);
      return () => {
        cancelled = true;
        import.meta.hot?.off('models-changed', refresh);
      };
    }
    return () => {
      cancelled = true;
    };
  }, []);
  return urls;
}

type Pt = { x: number; y: number };
type Quad = { tl: Pt; tr: Pt; br: Pt; bl: Pt };

function lerpPt(a: Pt, b: Pt, t: number): Pt {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

// Calibration of MediaPipe landmarks against the cloth, in normalized
// cloth-V units (V=0 at cloth top, V=1 at hem).
//
// MIDSHOULDER_CLOTH_V: MediaPipe's shoulder joints sit at the deltoid
//   attachment, ~5-7 cm below the cloth's top corner (which is the shoulder
//   seam). At cloth-center this is roughly the neckline level → V ≈ 0.10.
// MIDHIP_CLOTH_V:      The hem extends below the hip joint by ~6-8 cm on a
//   typical t-shirt → hip-joint at V ≈ 0.90.
// SHOULDER_SPAN_OF_CLOTH_W: the cloth extends past the shoulder joints out
//   to the sleeve attachment, so detected shoulder span is ~0.85× cloth W.
const MIDSHOULDER_CLOTH_V = 0.10;
const MIDHIP_CLOTH_V = 0.90;
const SHOULDER_SPAN_OF_CLOTH_W = 0.85;

const BODY_AXIS_CLOTH_V_RANGE = MIDHIP_CLOTH_V - MIDSHOULDER_CLOTH_V;
// Top-of-print position along the shoulder→hip axis (parametric t).
const PRINT_TOP_T = (PRINT_V - MIDSHOULDER_CLOTH_V) / BODY_AXIS_CLOTH_V_RANGE;
// Print width (cloth fraction) → fraction of shoulder span via calibration.
// Drives off PRINT_W_UV so 3D / UV editor / photos all stay in sync.
const PRINT_W_FRAC = PRINT_W_UV / SHOULDER_SPAN_OF_CLOTH_W;

function quadFromLandmarks(lm: PoseLandmark[], w: number, h: number): Quad {
  const ls = lm[POSE_INDEX.leftShoulder];
  const rs = lm[POSE_INDEX.rightShoulder];
  const lh = lm[POSE_INDEX.leftHip];
  const rh = lm[POSE_INDEX.rightHip];
  const toPt = (p: PoseLandmark): Pt => ({ x: p.x * w, y: p.y * h });
  const leftShoulder = toPt(ls);   // subject's left  = viewer's right
  const rightShoulder = toPt(rs);  // subject's right = viewer's left
  const leftHip = toPt(lh);
  const rightHip = toPt(rh);

  const topMid: Pt = {
    x: (leftShoulder.x + rightShoulder.x) / 2,
    y: (leftShoulder.y + rightShoulder.y) / 2,
  };
  const botMid: Pt = {
    x: (leftHip.x + rightHip.x) / 2,
    y: (leftHip.y + rightHip.y) / 2,
  };

  // Vertical anchor: where the top edge of the print plate sits along the
  // shoulder→hip axis. Position only — does NOT control height.
  const printTop = lerpPt(topMid, botMid, PRINT_TOP_T);

  // Width-direction angle = average of shoulder-line and hip-line angles.
  // Averaging halves a spurious shoulder tilt (e.g. raised arm) instead of
  // letting it run away.
  const shoulderAngle = Math.atan2(
    leftShoulder.y - rightShoulder.y,
    leftShoulder.x - rightShoulder.x
  );
  const hipAngle = Math.atan2(
    leftHip.y - rightHip.y,
    leftHip.x - rightHip.x
  );
  const tiltAngle = (shoulderAngle + hipAngle) / 2;

  // Width: from shoulder span (most stable cm reference on a clothed photo).
  // Height: locked to the print plate's physical aspect — never derived from
  // shoulder→hip distance, otherwise body-proportion / perspective variations
  // would stretch the pattern differently on every model.
  const shoulderLen = Math.hypot(
    leftShoulder.x - rightShoulder.x,
    leftShoulder.y - rightShoulder.y
  );
  const halfW = shoulderLen * 0.5 * PRINT_W_FRAC;
  const halfX = Math.cos(tiltAngle) * halfW;
  const halfY = Math.sin(tiltAngle) * halfW;

  // Down vector = perpendicular to width axis (rotate width 90° CW in
  // image-space, so it points toward the hip), magnitude = printedWidth /
  // PRINT_ASPECT. This guarantees printedHeight / printedWidth ≡ PRINT_ASPECT.
  const printedW = halfW * 2;
  const printedH = printedW / PRINT_ASPECT;
  const downX = -Math.sin(tiltAngle) * printedH;
  const downY = Math.cos(tiltAngle) * printedH;

  // tl/bl on subject's-right side (viewer's image-left for front-facing).
  return {
    tl: { x: printTop.x - halfX, y: printTop.y - halfY },
    tr: { x: printTop.x + halfX, y: printTop.y + halfY },
    bl: { x: printTop.x - halfX + downX, y: printTop.y - halfY + downY },
    br: { x: printTop.x + halfX + downX, y: printTop.y + halfY + downY },
  };
}

function buildHighPass(photo: HTMLImageElement, strength: number): HTMLCanvasElement {
  const w = photo.naturalWidth;
  const h = photo.naturalHeight;
  const blurRadius = Math.max(8, Math.round(Math.min(w, h) * 0.012));
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
    const v = (lO - lB) * strength + 128;
    const c = v < 0 ? 0 : v > 255 ? 255 : v;
    Dd[i] = c;
    Dd[i + 1] = c;
    Dd[i + 2] = c;
    Dd[i + 3] = 255;
  }
  origCtx.putImageData(out, 0, 0);
  return origC;
}

// Per-pixel relative shading map: photo / blur(photo, MEDIUM), encoded for
// HARD-LIGHT (mid-gray 128 ≡ ratio 1.0 ≡ mathematical identity). Folds map
// to bytes < 128 → hard-light darkens pattern. Bumps / highlights map to
// > 128 → hard-light lightens pattern (capped per-channel for already-bright
// patterns). Result: bidirectional "vacuum-fit" — printed-on look with both
// the dark fold lines AND subtle bumps showing through the pattern.
//
// Why mid-gray identity matters: the pattern's nominal color in flat shirt
// areas (where ratio ≈ 1, byte ≈ 128) is preserved exactly under hard-light,
// regardless of the shirt photo's absolute brightness or globalAlpha. This
// is the property that makes the foldStrength slider safe — it only changes
// fold/highlight pixels, never flat-area pixels.
//
// Two blurs: the LARGE one (5% of min dim) is the local-mean estimator for
// the ratio; the SMALL post-blur (0.3% of min dim, ~4-6 px) denoises the
// per-pixel ratio jitter. Without the post-blur, photo sensor noise + JPEG
// blocking artifacts read straight into the pattern as "rotten" texture.
// 4-6 px is far below the typical fold width (10-30 px) so fold detail
// survives.
function buildShadingMap(photo: HTMLImageElement): HTMLCanvasElement {
  const w = photo.naturalWidth;
  const h = photo.naturalHeight;
  const blurRadius = Math.max(40, Math.round(Math.min(w, h) * 0.05));
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
    const lB = Math.max(1, Bd[i] * 0.299 + Bd[i + 1] * 0.587 + Bd[i + 2] * 0.114);
    const ratio = lO / lB;
    // Encode FOLDS ONLY: ratio < 1 → byte < 128 (hard-light darkens),
    // ratio ≥ 1 → byte 128 (hard-light identity, no change). The highlight
    // branch of hard-light (`1 - 2·(1-bg)·(1-src)`) lifts every dim color
    // channel toward 1, which desaturates any non-grayscale pattern color
    // (yellow → pale yellow, blue → pale blue) the moment a shirt-bump
    // pixel goes above the local mean. Capping at 128 throws away the
    // "bump pops out" cue but keeps pattern saturation intact — the
    // dominant 3D cue is the dark fold line anyway.
    const v = Math.max(0, Math.min(128, 128 + (ratio - 1) * 256));
    Dd[i] = v;
    Dd[i + 1] = v;
    Dd[i + 2] = v;
    Dd[i + 3] = 255;
  }
  origCtx.putImageData(out, 0, 0);
  // Post-blur denoise: removes per-pixel ratio noise without affecting
  // medium-frequency fold structure.
  const denoised = document.createElement('canvas');
  denoised.width = w;
  denoised.height = h;
  const dctx = denoised.getContext('2d')!;
  dctx.filter = `blur(${Math.max(3, Math.round(Math.min(w, h) * 0.003))}px)`;
  dctx.drawImage(origC, 0, 0);
  return denoised;
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
  const highPassRef = useRef<HTMLCanvasElement | null>(null);
  const shadingRef = useRef<HTMLCanvasElement | null>(null);

  // Hydrate from in-memory caches synchronously so a re-mount (e.g. modal)
  // for a previously-rendered src boots straight to 'ready' — no loading UI.
  const initPhoto = photoMemCache.get(src) ?? null;
  const initHp = highPassMemCache.get(memHpKey(src, foldStrength)) ?? null;
  const initShading = shadingMemCache.get(src) ?? null;
  const initPose = initPhoto ? readCachedPose(src) : null;
  if (initPhoto && photoRef.current !== initPhoto) photoRef.current = initPhoto;
  if (initHp && highPassRef.current !== initHp) highPassRef.current = initHp;
  if (initShading && shadingRef.current !== initShading) shadingRef.current = initShading;

  const [photoSize, setPhotoSize] = useState<{ w: number; h: number } | null>(() =>
    initPhoto ? { w: initPhoto.naturalWidth, h: initPhoto.naturalHeight } : null
  );
  const [quad, setQuad] = useState<Quad | null>(() =>
    initPhoto && initPose
      ? quadFromLandmarks(initPose, initPhoto.naturalWidth, initPhoto.naturalHeight)
      : null
  );
  const [status, setStatus] = useState<'loading' | 'pose' | 'ready' | 'fail'>(() =>
    initPhoto && initHp && initPose ? 'ready' : 'loading'
  );

  useEffect(() => {
    let cancelled = false;
    // Fast path: everything already hydrated from mem caches.
    if (photoRef.current && highPassRef.current && quad) return;

    setStatus('loading');
    const img = photoRef.current ?? new Image();
    if (!photoRef.current) img.crossOrigin = 'anonymous';

    const onReady = async (image: HTMLImageElement) => {
      if (cancelled) return;
      photoRef.current = image;
      photoMemCache.set(src, image);
      setPhotoSize({ w: image.naturalWidth, h: image.naturalHeight });

      let hp = highPassMemCache.get(memHpKey(src, foldStrength)) ?? null;
      if (!hp) {
        const hpKey = `${src}|s=${foldStrength}`;
        const cachedHp = loadCachedHighPass(hpKey);
        if (cachedHp) {
          await new Promise<void>((res) => {
            if (cachedHp.complete) res();
            else cachedHp.onload = () => res();
          });
          if (cancelled) return;
          const c = document.createElement('canvas');
          c.width = image.naturalWidth;
          c.height = image.naturalHeight;
          c.getContext('2d')!.drawImage(cachedHp, 0, 0, c.width, c.height);
          hp = c;
        } else {
          hp = buildHighPass(image, foldStrength);
          saveCachedHighPass(hpKey, hp);
        }
        highPassMemCache.set(memHpKey(src, foldStrength), hp);
      }
      if (cancelled) return;
      highPassRef.current = hp;

      // Shading map is foldStrength-independent (slider scales effect at
      // render time via globalAlpha). Cache mem-only — too large for
      // localStorage (full-res grayscale image per photo).
      let sh = shadingMemCache.get(src) ?? null;
      if (!sh) {
        sh = buildShadingMap(image);
        shadingMemCache.set(src, sh);
      }
      if (cancelled) return;
      shadingRef.current = sh;

      setStatus('pose');
      try {
        const lm = await detectPoseCached(image, src);
        if (cancelled) return;
        if (lm) {
          setQuad(quadFromLandmarks(lm, image.naturalWidth, image.naturalHeight));
          setStatus('ready');
        } else {
          setStatus('fail');
        }
      } catch (e) {
        if (cancelled) return;
        console.warn('pose fail', e);
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

  useEffect(() => {
    if (!photoRef.current) return;
    const memHp = highPassMemCache.get(memHpKey(src, foldStrength));
    if (memHp) {
      highPassRef.current = memHp;
      return;
    }
    const hpKey = `${src}|s=${foldStrength}`;
    const cached = loadCachedHighPass(hpKey);
    if (cached) {
      const finish = () => {
        const c = document.createElement('canvas');
        c.width = photoRef.current!.naturalWidth;
        c.height = photoRef.current!.naturalHeight;
        c.getContext('2d')!.drawImage(cached, 0, 0, c.width, c.height);
        highPassRef.current = c;
        highPassMemCache.set(memHpKey(src, foldStrength), c);
      };
      if (cached.complete) finish();
      else cached.onload = finish;
    } else {
      const built = buildHighPass(photoRef.current, foldStrength);
      highPassRef.current = built;
      highPassMemCache.set(memHpKey(src, foldStrength), built);
      saveCachedHighPass(hpKey, built);
    }
  }, [foldStrength, src]);

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
      const tmp = document.createElement('canvas');
      tmp.width = cv.width;
      tmp.height = cv.height;
      const tctx = tmp.getContext('2d')!;
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

      // Step 2: composite onto the photo via createPattern + fill — fill
      // uses anti-aliased path rasterization, so the quad boundary is smooth.
      // Step 2: alpha-composite the pattern over the shirt (source-over).
      // Pattern's own alpha decides coverage — opaque white shows AS white,
      // semi-transparent edges blend softly, transparent BG keeps shirt.
      ctx.drawImage(tmp, 0, 0);

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
        const fitAlpha = Math.min(1.0, foldStrength * 0.7);
        if (fitAlpha > 0) {
          const sm = document.createElement('canvas');
          sm.width = cv.width;
          sm.height = cv.height;
          const sctx = sm.getContext('2d')!;
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

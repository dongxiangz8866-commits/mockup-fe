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

  // Hydrate from in-memory caches synchronously so a re-mount (e.g. modal)
  // for a previously-rendered src boots straight to 'ready' — no loading UI.
  const initPhoto = photoMemCache.get(src) ?? null;
  const initHp = highPassMemCache.get(memHpKey(src, foldStrength)) ?? null;
  const initPose = initPhoto ? readCachedPose(src) : null;
  if (initPhoto && photoRef.current !== initPhoto) photoRef.current = initPhoto;
  if (initHp && highPassRef.current !== initHp) highPassRef.current = initHp;

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

      // Step 2.5: vacuum-fit. Bake the shirt's lighting (low-frequency
      // gradient + mid-frequency folds) into the pattern by partial-
      // multiplying the photo through the pattern alpha. Without this the
      // pattern reads as a flat sticker — colors are right but it doesn't
      // wrap the cloth.
      //
      // Why partial: full multiply would re-collapse white pattern pixels
      // (white × white shirt = white, the bug we just fixed). globalAlpha
      // attenuates the multiply uniformly:
      //   white × shirt-fold(0.85) at α=0.5  →  0.5·0.85 + 0.5 = 0.925
      //     → fold visibly darkens white, but white still reads as white
      //   yellow × shirt-fold at α=0.5      →  yellow·0.925
      //     → colors keep saturation, fold cm onto them
      // The mask (source-in via tmp.alpha) limits the multiply to the
      // pattern region; surrounding shirt already shows its own folds
      // from the source photo and must stay untouched.
      //
      // foldStrength slider drives α directly so the user gets a smooth
      // "no fit ↔ strong fit" axis. 0.5 (=foldStrength 1.0) is the default
      // sweet spot.
      const litCanvas = document.createElement('canvas');
      litCanvas.width = cv.width;
      litCanvas.height = cv.height;
      const lctx = litCanvas.getContext('2d')!;
      lctx.drawImage(tmp, 0, 0);
      lctx.globalCompositeOperation = 'source-in';
      lctx.drawImage(photo, 0, 0);
      ctx.save();
      ctx.globalCompositeOperation = 'multiply';
      ctx.globalAlpha = Math.min(0.85, foldStrength * 0.5);
      ctx.drawImage(litCanvas, 0, 0);
      ctx.restore();

      // Step 3: fold/weave overlay, masked to the pattern's actual alpha (NOT
      // its bounding box). tmp already holds the warped pattern with PNG
      // transparency intact; reuse that alpha as a mask so transparent PNG
      // pixels keep the photo unchanged. Without this, hard-light + photo's
      // own high-pass doubles the cloth weave in transparent areas → visible
      // black grid.
      if (highPassRef.current) {
        const hpMasked = document.createElement('canvas');
        hpMasked.width = cv.width;
        hpMasked.height = cv.height;
        const hpCtx = hpMasked.getContext('2d')!;
        hpCtx.drawImage(tmp, 0, 0);
        hpCtx.globalCompositeOperation = 'source-in';
        hpCtx.drawImage(highPassRef.current, 0, 0);
        ctx.save();
        ctx.globalCompositeOperation = 'hard-light';
        ctx.drawImage(hpMasked, 0, 0);
        ctx.restore();
      }
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
  const [foldStrength, setFoldStrength] = useState(1.0);
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

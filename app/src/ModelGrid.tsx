import { useEffect, useMemo, useRef, useState } from 'react';
import { detectPoseCached, POSE_INDEX, type PoseLandmark } from './poseDetector';
import { photoPatternCanvas, subscribePattern, getPatternRelBox } from './textureStore';

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

const PHOTO_URLS = __MODELS__.map((m) => `${m.url}?v=${m.mtime}`);

type Pt = { x: number; y: number };
type Quad = { tl: Pt; tr: Pt; br: Pt; bl: Pt };

function quadFromLandmarks(lm: PoseLandmark[], w: number, h: number): Quad {
  const ls = lm[POSE_INDEX.leftShoulder];
  const rs = lm[POSE_INDEX.rightShoulder];
  const lh = lm[POSE_INDEX.leftHip];
  const rh = lm[POSE_INDEX.rightHip];
  const px = (p: PoseLandmark) => p.x * w;
  const py = (p: PoseLandmark) => p.y * h;
  const insetX = 0.05;
  const topT = 0.08;
  const botT = 0.78;
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  return {
    tl: { x: lerp(px(rs), px(ls), insetX), y: lerp(py(rs), py(rh), topT) },
    tr: { x: lerp(px(ls), px(rs), insetX), y: lerp(py(ls), py(lh), topT) },
    br: { x: lerp(px(lh), px(rh), insetX), y: lerp(py(rs), py(rh), botT) },
    bl: { x: lerp(px(rh), px(lh), insetX), y: lerp(py(ls), py(lh), botT) },
  };
}

function affineTo(
  ctx: CanvasRenderingContext2D,
  s0: Pt, s1: Pt, s2: Pt,
  d0: Pt, d1: Pt, d2: Pt
): boolean {
  const denom = (s1.x - s0.x) * (s2.y - s0.y) - (s2.x - s0.x) * (s1.y - s0.y);
  if (Math.abs(denom) < 1e-6) return false;
  const a = ((d1.x - d0.x) * (s2.y - s0.y) - (d2.x - d0.x) * (s1.y - s0.y)) / denom;
  const c = ((s1.x - s0.x) * (d2.x - d0.x) - (s2.x - s0.x) * (d1.x - d0.x)) / denom;
  const b = ((d1.y - d0.y) * (s2.y - s0.y) - (d2.y - d0.y) * (s1.y - s0.y)) / denom;
  const d = ((s1.x - s0.x) * (d2.y - d0.y) - (s2.x - s0.x) * (d1.y - d0.y)) / denom;
  const e = d0.x - a * s0.x - c * s0.y;
  const f = d0.y - b * s0.x - d * s0.y;
  ctx.transform(a, b, c, d, e, f);
  return true;
}

function drawTriangle(
  ctx: CanvasRenderingContext2D,
  src: HTMLCanvasElement,
  s0: Pt, s1: Pt, s2: Pt,
  d0: Pt, d1: Pt, d2: Pt
) {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(d0.x, d0.y);
  ctx.lineTo(d1.x, d1.y);
  ctx.lineTo(d2.x, d2.y);
  ctx.closePath();
  ctx.clip();
  if (affineTo(ctx, s0, s1, s2, d0, d1, d2)) {
    ctx.drawImage(src, 0, 0);
  }
  ctx.restore();
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
  const [quad, setQuad] = useState<Quad | null>(null);
  const [photoSize, setPhotoSize] = useState<{ w: number; h: number } | null>(null);
  const [status, setStatus] = useState<'loading' | 'pose' | 'ready' | 'fail'>('loading');

  useEffect(() => {
    setStatus('loading');
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = async () => {
      photoRef.current = img;
      setPhotoSize({ w: img.naturalWidth, h: img.naturalHeight });

      const hpKey = `${src}|s=${foldStrength}`;
      const cachedHp = loadCachedHighPass(hpKey);
      if (cachedHp) {
        await new Promise<void>((res) => {
          if (cachedHp.complete) res();
          else cachedHp.onload = () => res();
        });
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext('2d')!.drawImage(cachedHp, 0, 0, c.width, c.height);
        highPassRef.current = c;
      } else {
        const built = buildHighPass(img, foldStrength);
        highPassRef.current = built;
        saveCachedHighPass(hpKey, built);
      }

      setStatus('pose');
      try {
        const lm = await detectPoseCached(img, src);
        if (lm) {
          setQuad(quadFromLandmarks(lm, img.naturalWidth, img.naturalHeight));
          setStatus('ready');
        } else {
          setStatus('fail');
        }
      } catch (e) {
        console.warn('pose fail', e);
        setStatus('fail');
      }
    };
    img.src = src;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  useEffect(() => {
    if (!photoRef.current) return;
    const hpKey = `${src}|s=${foldStrength}`;
    const cached = loadCachedHighPass(hpKey);
    if (cached) {
      const finish = () => {
        const c = document.createElement('canvas');
        c.width = photoRef.current!.naturalWidth;
        c.height = photoRef.current!.naturalHeight;
        c.getContext('2d')!.drawImage(cached, 0, 0, c.width, c.height);
        highPassRef.current = c;
      };
      if (cached.complete) finish();
      else cached.onload = finish;
    } else {
      const built = buildHighPass(photoRef.current, foldStrength);
      highPassRef.current = built;
      saveCachedHighPass(hpKey, built);
    }
  }, [foldStrength, src]);

  const render = useMemo(() => {
    void foldStrength;
    return () => {
      const photo = photoRef.current;
      const cv = canvasRef.current;
      if (!photo || !cv || !photoSize) return;
      cv.width = photoSize.w;
      cv.height = photoSize.h;
      const ctx = cv.getContext('2d')!;
      ctx.drawImage(photo, 0, 0);
      if (!quad) return;

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(quad.tl.x, quad.tl.y);
      ctx.lineTo(quad.tr.x, quad.tr.y);
      ctx.lineTo(quad.br.x, quad.br.y);
      ctx.lineTo(quad.bl.x, quad.bl.y);
      ctx.closePath();
      ctx.clip();
      ctx.globalCompositeOperation = 'multiply';
      const pw = photoPatternCanvas.width;
      const ph = photoPatternCanvas.height;
      const cQ: Pt = {
        x: (quad.tl.x + quad.tr.x + quad.br.x + quad.bl.x) / 4,
        y: (quad.tl.y + quad.tr.y + quad.br.y + quad.bl.y) / 4,
      };
      const cP: Pt = { x: pw / 2, y: ph / 2 };
      const tlP: Pt = { x: 0, y: 0 };
      const trP: Pt = { x: pw, y: 0 };
      const brP: Pt = { x: pw, y: ph };
      const blP: Pt = { x: 0, y: ph };
      drawTriangle(ctx, photoPatternCanvas, tlP, trP, cP, quad.tl, quad.tr, cQ);
      drawTriangle(ctx, photoPatternCanvas, trP, brP, cP, quad.tr, quad.br, cQ);
      drawTriangle(ctx, photoPatternCanvas, brP, blP, cP, quad.br, quad.bl, cQ);
      drawTriangle(ctx, photoPatternCanvas, blP, tlP, cP, quad.bl, quad.tl, cQ);
      const relBox = getPatternRelBox();
      if (highPassRef.current && relBox) {
        const bilerp = (u: number, v: number): Pt => {
          const lx = quad.tl.x + (quad.bl.x - quad.tl.x) * v;
          const ly = quad.tl.y + (quad.bl.y - quad.tl.y) * v;
          const rx = quad.tr.x + (quad.br.x - quad.tr.x) * v;
          const ry = quad.tr.y + (quad.br.y - quad.tr.y) * v;
          return { x: lx + (rx - lx) * u, y: ly + (ry - ly) * u };
        };
        const u0 = relBox.u;
        const v0 = relBox.v;
        const u1 = relBox.u + relBox.w;
        const v1 = relBox.v + relBox.h;
        const sTL = bilerp(u0, v0);
        const sTR = bilerp(u1, v0);
        const sBR = bilerp(u1, v1);
        const sBL = bilerp(u0, v1);
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(sTL.x, sTL.y);
        ctx.lineTo(sTR.x, sTR.y);
        ctx.lineTo(sBR.x, sBR.y);
        ctx.lineTo(sBL.x, sBL.y);
        ctx.closePath();
        ctx.clip();
        ctx.globalCompositeOperation = 'hard-light';
        ctx.drawImage(highPassRef.current, 0, 0);
        ctx.restore();
      }
      ctx.restore();
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
  const [foldStrength, setFoldStrength] = useState(1.5);
  const [selected, setSelected] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);

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
        {PHOTO_URLS.map((url) => (
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

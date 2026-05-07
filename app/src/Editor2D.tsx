import { useCallback, useEffect, useRef, useState } from 'react';
import {
  TEX_H,
  TEX_W,
  markTextureDirty,
  sharedCtx,
  photoPatternCtx,
  PHOTO_PATTERN_W,
  PHOTO_PATTERN_H,
  setPatternRelBox,
} from './textureStore';
import { loadUvOutline, type UvOutline } from './uvOutline';

const MODEL_URL = '/sweatshirt.glb';
const DISPLAY_W = 380;
const DISPLAY_H = 320;

const PRINT_W_CM = 30;
const PRINT_H_CM = 35;

const PRINT_U = 0.097;
const PRINT_V = 0.080;
const PRINT_W_UV = 0.140;
const PRINT_H_UV = 0.158;

const FOCUS_BOUNDS = { minU: 0.020, maxU: 0.314, minV: 0.020, maxV: 0.285 };

const UV_ANISOTROPY = 1.32;
const SNAP_THRESHOLD_UV = 0.003;

const PATTERN_CACHE_KEY = 'pattern-cache:v1';
type PatternCache = { dataUrl: string; box: Box };

function loadPatternCache(): PatternCache | null {
  try {
    const raw = localStorage.getItem(PATTERN_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      typeof parsed?.dataUrl !== 'string' ||
      typeof parsed?.box?.u !== 'number'
    )
      return null;
    return parsed as PatternCache;
  } catch {
    return null;
  }
}

function savePatternCache(c: PatternCache) {
  try {
    localStorage.setItem(PATTERN_CACHE_KEY, JSON.stringify(c));
  } catch {
    // quota — ignore
  }
}

function imageToDataUrl(img: HTMLImageElement): string {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext('2d')!.drawImage(img, 0, 0);
  return c.toDataURL('image/png');
}

type Box = { u: number; v: number; w: number; h: number };
type DragMode =
  | { kind: 'move'; offU: number; offV: number }
  | { kind: 'resize'; corner: 'nw' | 'ne' | 'se' | 'sw'; orig: Box; ratio: number }
  | null;
type SnapState = { v: boolean; h: boolean };
type Transform = {
  uMin: number;
  vMin: number;
  scale: number;
  offX: number;
  offY: number;
};

function computeTransform(): Transform {
  const uvW = FOCUS_BOUNDS.maxU - FOCUS_BOUNDS.minU;
  const uvH = FOCUS_BOUNDS.maxV - FOCUS_BOUNDS.minV;
  const scale = Math.min(DISPLAY_W / uvW, DISPLAY_H / uvH);
  const offX = (DISPLAY_W - uvW * scale) / 2;
  const offY = (DISPLAY_H - uvH * scale) / 2;
  return { uMin: FOCUS_BOUNDS.minU, vMin: FOCUS_BOUNDS.minV, scale, offX, offY };
}

function fitBox(ratio: number): Box {
  const targetW = PRINT_W_UV * 0.85;
  let w = targetW;
  let h = w / ratio;
  if (h > PRINT_H_UV * 0.85) {
    h = PRINT_H_UV * 0.85;
    w = h * ratio;
  }
  return {
    u: PRINT_U + (PRINT_W_UV - w) / 2,
    v: PRINT_V + (PRINT_H_UV - h) / 2,
    w,
    h,
  };
}

function clampBoxToView(b: Box): Box {
  const minVisible = 0.01;
  const u = Math.max(
    FOCUS_BOUNDS.minU + minVisible - b.w,
    Math.min(FOCUS_BOUNDS.maxU - minVisible, b.u)
  );
  const v = Math.max(
    FOCUS_BOUNDS.minV + minVisible - b.h,
    Math.min(FOCUS_BOUNDS.maxV - minVisible, b.v)
  );
  return { ...b, u, v };
}

function snapToCenter(b: Box): { box: Box; snap: SnapState } {
  const cx = PRINT_U + PRINT_W_UV / 2;
  const cy = PRINT_V + PRINT_H_UV / 2;
  const boxCx = b.u + b.w / 2;
  const boxCy = b.v + b.h / 2;
  const v = Math.abs(boxCx - cx) < SNAP_THRESHOLD_UV;
  const h = Math.abs(boxCy - cy) < SNAP_THRESHOLD_UV;
  const u = v ? cx - b.w / 2 : b.u;
  const vv = h ? cy - b.h / 2 : b.v;
  return { box: { ...b, u, v: vv }, snap: { v, h } };
}

function paintTexture(img: HTMLImageElement | null, box: Box | null) {
  sharedCtx.fillStyle = '#ffffff';
  sharedCtx.fillRect(0, 0, TEX_W, TEX_H);
  photoPatternCtx.fillStyle = '#ffffff';
  photoPatternCtx.fillRect(0, 0, PHOTO_PATTERN_W, PHOTO_PATTERN_H);
  if (!img || !box || !img.complete || img.naturalWidth === 0) {
    setPatternRelBox(null);
    markTextureDirty();
    return;
  }

  const tx = box.u * TEX_W;
  const tw = box.w * TEX_W;
  const thRaw = box.h * TEX_H;
  const th = thRaw / UV_ANISOTROPY;
  const ty = box.v * TEX_H + (thRaw - th) / 2;
  const clipX = PRINT_U * TEX_W;
  const clipY = PRINT_V * TEX_H;
  const clipW = PRINT_W_UV * TEX_W;
  const clipH = PRINT_H_UV * TEX_H;

  sharedCtx.save();
  sharedCtx.beginPath();
  sharedCtx.rect(clipX, clipY, clipW, clipH);
  sharedCtx.clip();
  sharedCtx.imageSmoothingEnabled = true;
  sharedCtx.imageSmoothingQuality = 'high';
  sharedCtx.drawImage(img, tx, ty, tw, th);
  sharedCtx.restore();

  const relU = (box.u - PRINT_U) / PRINT_W_UV;
  const relV = (box.v - PRINT_V) / PRINT_H_UV;
  const relW = box.w / PRINT_W_UV;
  const relH = box.h / PRINT_H_UV;
  setPatternRelBox({ u: relU, v: relV, w: relW, h: relH });
  photoPatternCtx.save();
  photoPatternCtx.beginPath();
  photoPatternCtx.rect(0, 0, PHOTO_PATTERN_W, PHOTO_PATTERN_H);
  photoPatternCtx.clip();
  photoPatternCtx.imageSmoothingEnabled = true;
  photoPatternCtx.imageSmoothingQuality = 'high';
  photoPatternCtx.drawImage(
    img,
    relU * PHOTO_PATTERN_W,
    relV * PHOTO_PATTERN_H,
    relW * PHOTO_PATTERN_W,
    relH * PHOTO_PATTERN_H
  );
  photoPatternCtx.restore();

  markTextureDirty();
}

function calcDpi(natural: number, uvDim: number, cm: number) {
  const printedCm = (uvDim / (uvDim === 0 ? 1 : uvDim)) * 0; // unused placeholder, real calc below
  void printedCm;
  const ratio = uvDim / (PRINT_W_UV); // pattern UV size / print area UV size
  const printedCmActual = ratio * cm;
  if (printedCmActual <= 0) return 0;
  const inches = printedCmActual / 2.54;
  return Math.round(natural / inches);
}

export default function Editor2D() {
  const [outline, setOutline] = useState<UvOutline | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [snap, setSnap] = useState<SnapState>({ v: false, h: false });
  const imgRef = useRef<HTMLImageElement | null>(null);
  const ratioRef = useRef<number>(1);
  const dragRef = useRef<DragMode>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadUvOutline(MODEL_URL).then(setOutline).catch((e) => {
      console.error('UV outline failed', e);
    });
  }, []);

  useEffect(() => {
    const cached = loadPatternCache();
    if (!cached) return;
    const img = new Image();
    img.onload = () => {
      const ratio = img.naturalWidth / img.naturalHeight;
      ratioRef.current = ratio;
      imgRef.current = img;
      setImgUrl(cached.dataUrl);
      setBox(cached.box);
    };
    img.src = cached.dataUrl;
  }, []);

  useEffect(() => {
    paintTexture(imgRef.current, box);
    if (imgUrl && box) {
      savePatternCache({ dataUrl: imgUrl, box });
    }
  }, [box, imgUrl]);

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const blobUrl = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => {
      const ratio = img.naturalWidth / img.naturalHeight;
      ratioRef.current = ratio;
      imgRef.current = img;
      const dataUrl = imageToDataUrl(img);
      URL.revokeObjectURL(blobUrl);
      setImgUrl(dataUrl);
      setBox(fitBox(ratio));
    };
    img.src = blobUrl;
  };

  const reset = () => {
    if (imgRef.current) setBox(fitBox(ratioRef.current));
  };

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const m = dragRef.current;
      if (!m || !stageRef.current) return;
      const xf = computeTransform();
      const rect = stageRef.current.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const u = (px - xf.offX) / xf.scale + xf.uMin;
      const v = (py - xf.offY) / xf.scale + xf.vMin;

      if (m.kind === 'move') {
        setBox((b) => {
          if (!b) return b;
          const moved = clampBoxToView({ ...b, u: u - m.offU, v: v - m.offV });
          const { box: snapped, snap: s } = snapToCenter(moved);
          setSnap(s);
          return snapped;
        });
        return;
      }

      const o = m.orig;
      const r = m.ratio;
      const corner = m.corner;
      const right = corner === 'se' || corner === 'ne';
      const bottom = corner === 'se' || corner === 'sw';

      let newW = right ? u - o.u : o.u + o.w - u;
      newW = Math.max(0.005, Math.min(0.5, newW));
      const newH = newW / r;
      const nu = right ? o.u : o.u + o.w - newW;
      const nv = bottom ? o.v : o.v + o.h - newH;
      setBox(clampBoxToView({ u: nu, v: nv, w: newW, h: newH }));
    },
    []
  );

  const onPointerUp = () => {
    dragRef.current = null;
    setSnap({ v: false, h: false });
  };

  if (!outline) {
    return (
      <div className="editor-root">
        <div className="editor-loading">加载 UV 模板…</div>
      </div>
    );
  }

  const xf = computeTransform();
  const uvToX = (u: number) => xf.offX + (u - xf.uMin) * xf.scale;
  const uvToY = (v: number) => xf.offY + (v - xf.vMin) * xf.scale;

  const printCenterU = PRINT_U + PRINT_W_UV / 2;
  const printCenterV = PRINT_V + PRINT_H_UV / 2;
  const frontIsland = outline.islands.find(
    (isl) =>
      isl.uvBounds.minU <= printCenterU &&
      printCenterU <= isl.uvBounds.maxU &&
      isl.uvBounds.minV <= printCenterV &&
      printCenterV <= isl.uvBounds.maxV
  );
  const islandPathD = frontIsland?.pathD ?? outline.pathD;

  const printX = uvToX(PRINT_U);
  const printY = uvToY(PRINT_V);
  const printDispW = PRINT_W_UV * xf.scale;
  const printDispH = PRINT_H_UV * xf.scale;

  const cx = printX + printDispW / 2;
  const cy = printY + printDispH / 2;

  const dpiW = box && imgRef.current
    ? calcDpi(imgRef.current.naturalWidth, box.w, PRINT_W_CM)
    : 0;
  const dpiTier = dpiW >= 200 ? 'good' : dpiW >= 100 ? 'warn' : 'bad';

  const onStageClick = (e: React.MouseEvent) => {
    if (
      (e.target as HTMLElement).closest('.pattern-box, .stage-icon')
    )
      return;
    fileInputRef.current?.click();
  };

  return (
    <div className="editor-root">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={onFile}
        hidden
      />
      <div className="editor-toolbar">
        {box && imgRef.current && (
          <span className={`dpi-badge dpi-${dpiTier}`}>
            {dpiW} DPI{' '}
            {dpiTier === 'bad'
              ? '· 分辨率偏低'
              : dpiTier === 'warn'
              ? '· 建议更高分辨率'
              : ''}
          </span>
        )}
      </div>

      <div
        ref={stageRef}
        className="editor-stage"
        style={{ width: DISPLAY_W, height: DISPLAY_H }}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={onStageClick}
      >
        {imgUrl && (
          <div className="stage-icons">
            <button
              className="stage-icon"
              onClick={(e) => {
                e.stopPropagation();
                fileInputRef.current?.click();
              }}
              title="替换图案"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path
                  d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2M12 3v13M7 8l5-5 5 5"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <button
              className="stage-icon"
              onClick={(e) => {
                e.stopPropagation();
                reset();
              }}
              title="重置位置"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path
                  d="M4 4v6h6M20 20v-6h-6M20 8a8 8 0 0 0-14-2M4 16a8 8 0 0 0 14 2"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        )}
        <svg
          width={DISPLAY_W}
          height={DISPLAY_H}
          className="editor-svg"
          viewBox={`0 0 ${DISPLAY_W} ${DISPLAY_H}`}
        >
          <g
            transform={`translate(${xf.offX - xf.uMin * xf.scale} ${xf.offY -
              xf.vMin * xf.scale}) scale(${xf.scale})`}
          >
            <path d={islandPathD} className="uv-outline" vectorEffect="non-scaling-stroke" />
          </g>

          <rect
            x={printX}
            y={printY}
            width={printDispW}
            height={printDispH}
            className="print-area"
          />
          {(['tl', 'tr', 'bl', 'br'] as const).map((c) => {
            const SIZE = 14;
            const x = c === 'tl' || c === 'bl' ? printX : printX + printDispW;
            const y = c === 'tl' || c === 'tr' ? printY : printY + printDispH;
            const dx = c === 'tl' || c === 'bl' ? SIZE : -SIZE;
            const dy = c === 'tl' || c === 'tr' ? SIZE : -SIZE;
            return (
              <g key={c} className="bracket">
                <line x1={x} y1={y} x2={x + dx} y2={y} />
                <line x1={x} y1={y} x2={x} y2={y + dy} />
              </g>
            );
          })}

          {snap.v && (
            <line
              x1={cx}
              y1={printY - 6}
              x2={cx}
              y2={printY + printDispH + 6}
              className="snap-line"
            />
          )}
          {snap.h && (
            <line
              x1={printX - 6}
              y1={cy}
              x2={printX + printDispW + 6}
              y2={cy}
              className="snap-line"
            />
          )}

          <text
            x={printX + printDispW / 2}
            y={printY + printDispH + 22}
            className="dim-label"
            textAnchor="middle"
          >
            可印区域 {PRINT_W_CM} × {PRINT_H_CM} cm
          </text>
        </svg>

        {imgUrl && box && (
          <div
            className="pattern-box"
            style={{
              left: uvToX(box.u),
              top: uvToY(box.v),
              width: box.w * xf.scale,
              height: box.h * xf.scale,
              backgroundImage: `url(${imgUrl})`,
              backgroundSize: '100% 100%',
            }}
            onPointerDown={(e) => {
              if ((e.target as HTMLElement).classList.contains('handle')) return;
              e.stopPropagation();
              (e.target as Element).setPointerCapture(e.pointerId);
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              const stageRect = stageRef.current!.getBoundingClientRect();
              const px = e.clientX - stageRect.left;
              const py = e.clientY - stageRect.top;
              const u = (px - xf.offX) / xf.scale + xf.uMin;
              const v = (py - xf.offY) / xf.scale + xf.vMin;
              void r;
              dragRef.current = {
                kind: 'move',
                offU: u - box.u,
                offV: v - box.v,
              };
            }}
          >
            {(['nw', 'ne', 'se', 'sw'] as const).map((c) => (
              <div
                key={c}
                className={`handle handle-${c}`}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  (e.target as Element).setPointerCapture(e.pointerId);
                  dragRef.current = {
                    kind: 'resize',
                    corner: c,
                    orig: box,
                    ratio: ratioRef.current,
                  };
                }}
              />
            ))}
          </div>
        )}

        {!imgUrl && (
          <div className="empty-hint">
            点击此处上传图案 (PNG / JPG)
          </div>
        )}
      </div>
    </div>
  );
}

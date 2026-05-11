import { PRINT_H_UV, PRINT_U, PRINT_V, PRINT_W_UV } from './modelAssets';
import {
  applyCylindricalBend,
  applyEdgeInnerShadow,
  applyGarmentBlend,
  classifyShirt,
  PRESETS,
  sampleGarment,
  type GarmentSample,
  type Quad,
} from './shading';
import type { PatternState } from './textureStore';

type PatternRecord = NonNullable<PatternState>;

// Photo-keyed (independent of pattern / quad position).
const garmentMemCache = new Map<string, GarmentSample>();

// Scratch buffers reused across frames to avoid 4× full-res allocs per drag tick.
export type FrameScratches = {
  tmp: React.MutableRefObject<HTMLCanvasElement | null>;
  shading: React.MutableRefObject<HTMLCanvasElement | null>;
  wideShading: React.MutableRefObject<HTMLCanvasElement | null>;
  highlight: React.MutableRefObject<HTMLCanvasElement | null>;
  fabric: React.MutableRefObject<HTMLCanvasElement | null>;
  bend: React.MutableRefObject<HTMLCanvasElement | null>;
  edgeShadow: React.MutableRefObject<HTMLCanvasElement | null>;
};

export type FrameMaps = {
  shading: HTMLCanvasElement | null;
  wideShading: HTMLCanvasElement | null;
  highlight: HTMLCanvasElement | null;
  fabric: HTMLCanvasElement | null;
};

export type ComposeArgs = {
  ctx: CanvasRenderingContext2D;
  cv: HTMLCanvasElement;
  photo: HTMLImageElement;
  pat: PatternRecord;
  src: string;
  quad: Quad;
  foldStrength: number;
  maps: FrameMaps;
  scratches: FrameScratches;
};

function ensureScratch(
  ref: React.MutableRefObject<HTMLCanvasElement | null>,
  w: number,
  h: number
): HTMLCanvasElement {
  if (!ref.current) ref.current = document.createElement('canvas');
  const c = ref.current;
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  return c;
}

// Single-affine warp (source → quad). The earlier source→2K→quad chain
// double-resampled and blurred low-res uploads. Clip to quad so overhang
// is cut.
function warpPatternIntoTmp(tmp: HTMLCanvasElement, quad: Quad, pat: PatternRecord): void {
  const tctx = tmp.getContext('2d')!;
  tctx.setTransform(1, 0, 0, 1, 0, 0);
  tctx.clearRect(0, 0, tmp.width, tmp.height);
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
}

function quadBbox(quad: Quad) {
  const x0 = Math.min(quad.tl.x, quad.tr.x, quad.bl.x, quad.br.x);
  const y0 = Math.min(quad.tl.y, quad.tr.y, quad.bl.y, quad.br.y);
  const x1 = Math.max(quad.tl.x, quad.tr.x, quad.bl.x, quad.br.x);
  const y1 = Math.max(quad.tl.y, quad.tr.y, quad.bl.y, quad.br.y);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// scratch ← tmp masked-in by `map`, then ctx ← scratch via `blendMode` at
// `alpha`. Shared by Step 2.5 / 2.5b / 2.6 / 2.7.
function composeLayer(
  ctx: CanvasRenderingContext2D,
  tmp: HTMLCanvasElement,
  map: HTMLCanvasElement,
  blendMode: GlobalCompositeOperation,
  alpha: number,
  scratchRef: React.MutableRefObject<HTMLCanvasElement | null>
): void {
  if (alpha <= 0) return;
  const scratch = ensureScratch(scratchRef, tmp.width, tmp.height);
  const sctx = scratch.getContext('2d')!;
  sctx.globalCompositeOperation = 'source-over';
  sctx.clearRect(0, 0, scratch.width, scratch.height);
  sctx.drawImage(tmp, 0, 0);
  sctx.globalCompositeOperation = 'source-in';
  sctx.drawImage(map, 0, 0);
  ctx.save();
  ctx.globalCompositeOperation = blendMode;
  ctx.globalAlpha = alpha;
  ctx.drawImage(scratch, 0, 0);
  ctx.restore();
}

export function composeFrame(args: ComposeArgs): void {
  const { ctx, cv, photo, pat, src, quad, foldStrength, maps, scratches } = args;

  cv.width = ctx.canvas.width;
  cv.height = ctx.canvas.height;
  ctx.drawImage(photo, 0, 0);

  const tmp = ensureScratch(scratches.tmp, cv.width, cv.height);
  warpPatternIntoTmp(tmp, quad, pat);

  // Step 1.5a: classify shirt; sample lazy-built then cached per src.
  let garment = garmentMemCache.get(src) ?? null;
  if (!garment) {
    garment = sampleGarment(photo, quad);
    garmentMemCache.set(src, garment);
  }
  const preset = PRESETS[classifyShirt(garment)];
  const bbox = quadBbox(quad);

  // Step 1.5b/c/d: cylinder bend + garment blend + edge inner shadow.
  // applyGarmentBlend mutates tmp.RGB only (alpha kept for later masks).
  if (!scratches.bend.current) scratches.bend.current = document.createElement('canvas');
  applyCylindricalBend(tmp, bbox, preset.bendExp, scratches.bend.current);
  applyGarmentBlend(tmp, garment, preset, bbox);
  if (!scratches.edgeShadow.current) scratches.edgeShadow.current = document.createElement('canvas');
  applyEdgeInnerShadow(tmp, bbox, preset.edgeShadowPx, preset.edgeShadowAlpha, scratches.edgeShadow.current);

  // Step 2: alpha-composite pattern over shirt. 0.5 px blur softens both
  // interior (sharpness match) AND alpha edge (kills cut-out cue).
  ctx.save();
  ctx.filter = 'blur(0.5px)';
  ctx.drawImage(tmp, 0, 0);
  ctx.restore();

  // Step 2.5 / 2.5b / 2.6 / 2.7 — see docs/synthesis-pipeline.md for the
  // hard-light/screen/overlay math + cap=128 reasoning.
  if (maps.shading) {
    composeLayer(
      ctx, tmp, maps.shading, 'hard-light',
      preset.foldMul * Math.min(1.0, foldStrength * 0.7),
      scratches.shading
    );
  }
  if (maps.wideShading && preset.wideFoldMul > 0) {
    composeLayer(
      ctx, tmp, maps.wideShading, 'hard-light',
      preset.wideFoldMul * Math.min(1.0, foldStrength * 0.7),
      scratches.wideShading
    );
  }
  if (maps.highlight) {
    composeLayer(
      ctx, tmp, maps.highlight, 'screen',
      preset.hlMul * Math.min(0.35, foldStrength * 0.15),
      scratches.highlight
    );
  }
  if (maps.fabric) {
    composeLayer(
      ctx, tmp, maps.fabric, 'overlay',
      preset.fabricMul * Math.min(1.0, foldStrength * 0.5),
      scratches.fabric
    );
  }
}

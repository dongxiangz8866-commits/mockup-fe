import type { CanvasKit, Image, RuntimeEffect, Surface } from 'canvaskit-wasm';
import type { Quad } from '../shading';
import type { Mesh } from './buildMesh';
import { COMPOSITE_SKSL, packUniforms, type CompositeUniforms } from './skSLComposite';

// One main (on-screen, preserveDrawingBuffer for export) + one offscreen
// (GPU, same context) surface per backing canvas, rebuilt only on resize.
type Cached = { main: Surface; off: Surface; w: number; h: number };
const cache = new WeakMap<HTMLCanvasElement, Cached>();

let effect: RuntimeEffect | null = null;
function getEffect(ck: CanvasKit): RuntimeEffect | null {
  if (!effect) {
    effect = ck.RuntimeEffect.Make(COMPOSITE_SKSL, (e) =>
      console.error('[canvaskit] SkSL compile error:', e)
    );
  }
  return effect;
}

function getSurfaces(ck: CanvasKit, canvas: HTMLCanvasElement): Cached | null {
  const c = cache.get(canvas);
  if (c && c.w === canvas.width && c.h === canvas.height) return c;
  c?.main.delete();
  c?.off.delete();
  // preserveDrawingBuffer:1 — toDataURL/toBlob (ResultActions 放大/复制 +
  // the headless harness) read blank without it on a WebGL surface.
  const main =
    ck.MakeWebGLCanvasSurface(canvas, ck.ColorSpace.SRGB, { preserveDrawingBuffer: 1 }) ??
    ck.MakeSWCanvasSurface(canvas);
  if (!main) return null;
  const info = {
    width: canvas.width,
    height: canvas.height,
    colorType: ck.ColorType.RGBA_8888,
    alphaType: ck.AlphaType.Premul,
    colorSpace: ck.ColorSpace.SRGB,
  };
  const off = main.getCanvas().makeSurface(info) ?? ck.MakeSurface(canvas.width, canvas.height);
  if (!off) return null;
  const next = { main, off, w: canvas.width, h: canvas.height };
  cache.set(canvas, next);
  return next;
}

export type RenderArgs = {
  ck: CanvasKit;
  canvas: HTMLCanvasElement;
  patternImg: Image;
  photoImg: Image;
  lightImg: Image;
  shadingImg: Image;
  smoothImg: Image;
  displaceImg: Image;
  fineImg: Image;
  hairImg: Image;
  /** alpha = garment mask — pass-1 DstIn clip. */
  clothClipImg: Image;
  /** rgb = garment mask (opaque) — debug-6 child only. */
  clothImg: Image;
  /** photo blurred at ~3% min-dim — freq-sep low-pass source. */
  photoLowImg: Image;
  mesh: Mesh;
  photoW: number;
  photoH: number;
  surfaceScale: number;
  uniforms: Omit<CompositeUniforms, 'surfW' | 'surfH' | 'mapW' | 'mapH'>;
};

export function renderCanvasKit(a: RenderArgs): void {
  const { ck } = a;
  const surf = getSurfaces(ck, a.canvas);
  const eff = getEffect(ck);
  if (!surf || !eff) return;
  const sw = a.canvas.width;
  const sh = a.canvas.height;

  // ── Pass 1: warp the pattern into the offscreen, clip to garment ──
  const oc = surf.off.getCanvas();
  oc.clear(ck.TRANSPARENT);
  oc.save();
  oc.scale(a.surfaceScale, a.surfaceScale); // mesh positions are photo px
  // MipmapMode.Linear so the pattern minifies cleanly when the warp at high
  // depthWrap squeezes the pattern texels denser than 1 src-px per dst-px.
  // Without trilinear, those regions alias into a jagged shimmer that the
  // eye reads as "hard lines around the conformed area" (user 2026-05-20).
  // Decal still kills sampling outside [0,1] so the cloth-clip path is
  // unchanged. Skia generates the mip chain lazily on first sample.
  const patShader = a.patternImg.makeShaderOptions(
    ck.TileMode.Decal, ck.TileMode.Decal, ck.FilterMode.Linear, ck.MipmapMode.Linear
  );
  const patPaint = new ck.Paint();
  patPaint.setShader(patShader);
  patPaint.setAntiAlias(true);
  const verts = ck.MakeVertices(
    ck.VertexMode.Triangles, a.mesh.positions, a.mesh.texcoords, null, a.mesh.indices, false
  );
  oc.drawVertices(verts, ck.BlendMode.Src, patPaint);
  const clipPaint = new ck.Paint();
  clipPaint.setBlendMode(ck.BlendMode.DstIn);
  oc.drawImageRect(
    a.clothClipImg,
    ck.XYWHRect(0, 0, a.clothClipImg.width(), a.clothClipImg.height()),
    ck.XYWHRect(0, 0, a.photoW, a.photoH),
    clipPaint,
    false
  );
  oc.restore();
  surf.off.flush();
  const warped = surf.off.makeImageSnapshot();

  // ── Pass 2: per-pixel composite (frag parity) via RuntimeEffect ──
  const opts = [ck.TileMode.Clamp, ck.TileMode.Clamp, ck.FilterMode.Linear, ck.MipmapMode.None] as const;
  const children = [
    warped.makeShaderOptions(...opts),
    a.photoImg.makeShaderOptions(...opts),
    a.lightImg.makeShaderOptions(...opts),
    a.shadingImg.makeShaderOptions(...opts),
    a.smoothImg.makeShaderOptions(...opts),
    a.displaceImg.makeShaderOptions(...opts),
    a.fineImg.makeShaderOptions(...opts),
    a.hairImg.makeShaderOptions(...opts),
    a.clothImg.makeShaderOptions(...opts),
    a.photoLowImg.makeShaderOptions(...opts),
  ];
  const u = packUniforms({
    ...a.uniforms,
    surfW: sw,
    surfH: sh,
    mapW: a.photoW,
    mapH: a.photoH,
  });
  const compShader = eff.makeShaderWithChildren(u, children);
  const mc = surf.main.getCanvas();
  mc.clear(ck.TRANSPARENT);
  const compPaint = new ck.Paint();
  compPaint.setShader(compShader);
  mc.drawRect(ck.XYWHRect(0, 0, sw, sh), compPaint);
  surf.main.flush();

  verts.delete();
  patShader.delete();
  patPaint.delete();
  clipPaint.delete();
  children.forEach((c) => c.delete());
  compShader.delete();
  compPaint.delete();
  warped.delete();
}

// Closed-loop calibration probe. Reads back the just-rendered main surface
// over the print quad and returns the printed region's PERCEPTUAL luma
// spread (P90−P10, sRGB→~L*). The caller turns this into a residual that
// pulls foldK toward a fixed target — so "fold contrast" is MEASURED on the
// real (garment,pattern,light) output, not predicted from color (which is
// un-exhaustible). Runs once per photo/pattern (gated by renderKey), never
// on drag, so it stays off the 60 fps path. Returns −1 if unavailable.
export function measurePrintedContrast(
  ck: CanvasKit,
  canvas: HTMLCanvasElement,
  quad: Quad,
  surfaceScale: number
): number {
  const surf = cache.get(canvas);
  if (!surf) { if (import.meta.env.DEV) console.log('[foldCalib] no cached surface'); return -1; }
  const sw = canvas.width;
  const sh = canvas.height;
  const xs = [quad.tl.x, quad.tr.x, quad.bl.x, quad.br.x].map((v) => v * surfaceScale);
  const ys = [quad.tl.y, quad.tr.y, quad.bl.y, quad.br.y].map((v) => v * surfaceScale);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const x1 = Math.min(sw, Math.ceil(Math.max(...xs)));
  const y1 = Math.min(sh, Math.ceil(Math.max(...ys)));
  const bw = x1 - x0;
  const bh = y1 - y0;
  if (bw < 8 || bh < 8) { if (import.meta.env.DEV) console.log(`[foldCalib] bbox ${bw}x${bh}`); return -1; }

  const snap = surf.main.makeImageSnapshot([x0, y0, x1, y1]);
  const px = snap.readPixels(0, 0, {
    width: bw,
    height: bh,
    colorType: ck.ColorType.RGBA_8888,
    alphaType: ck.AlphaType.Unpremul,
    colorSpace: ck.ColorSpace.SRGB,
  }) as Uint8Array | null;
  snap.delete();
  if (!px) { if (import.meta.env.DEV) console.log('[foldCalib] readPixels null'); return -1; }

  // Stride-sample (~4 k points), sRGB byte → perceptual luma.
  const stride = Math.max(1, Math.floor(Math.sqrt((bw * bh) / 4096))) * 4;
  const lums: number[] = [];
  for (let i = 0; i + 2 < px.length; i += stride) {
    if (px[i + 3] < 8) continue; // transparent (outside the composited rect)
    const l = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) / 255;
    lums.push(Math.pow(l, 1 / 2.2));
  }
  if (lums.length < 32) { if (import.meta.env.DEV) console.log(`[foldCalib] only ${lums.length} samples`); return -1; }
  lums.sort((a, b) => a - b);
  const p = (q: number) => lums[Math.min(lums.length - 1, Math.round((lums.length - 1) * q))];
  return p(0.9) - p(0.1);
}

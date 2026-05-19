import type { CanvasKit, Image, RuntimeEffect, Surface } from 'canvaskit-wasm';
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
  const patShader = a.patternImg.makeShaderOptions(
    ck.TileMode.Decal, ck.TileMode.Decal, ck.FilterMode.Linear, ck.MipmapMode.None
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

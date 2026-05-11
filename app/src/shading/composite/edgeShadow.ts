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
export function applyEdgeInnerShadow(
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

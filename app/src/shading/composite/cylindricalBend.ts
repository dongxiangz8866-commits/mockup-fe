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
export function applyCylindricalBend(
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

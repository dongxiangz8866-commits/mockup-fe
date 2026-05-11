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
export function buildHighlightMap(photo: HTMLImageElement): HTMLCanvasElement {
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

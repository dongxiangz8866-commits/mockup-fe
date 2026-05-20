// Photo low-pass for frequency-separation compositing (/canvaskit only).
//
// The "贴合" we're chasing here ISN'T low-frequency fold lighting (that's the
// fold-light path in skSLComposite which we keep as the default). It's the
// fact that on a real-world screen-printed tee photo, the FABRIC GRAIN /
// micro-noise of the shirt is visible THROUGH the print color — the print
// reads as woven into the cotton, not floating on top.
//
// Standard photo-retouching trick, applied in reverse:
//
//   photo   = photoLow + photoHigh          (frequency split at radius R)
//   printed = mix(photoLow, patternColor, α) + photoHigh
//           = photo + α · (patternColor − photoLow)
//
// → the photo's HIGH freq (grain, weave, sub-fold mottling) passes through
// the print unchanged; only the LOW freq (shirt's overall color) gets
// replaced by the pattern. No fold detection, no SNR gate, no closed loop.
//
// Blur radius (% min-dim) sets the band split point. The math runs the
// OPPOSITE direction from my first-pass intuition:
//
//   • SMALL R (≈ grain size, 3–6 px): blur smooths ONLY sub-grain noise;
//     folds + shading + body curvature are all PRESERVED in photoLow ⇒
//     end up REPLACED by the pattern. HIGH = just fabric texture. Print
//     stays clean.
//
//   • BIG R (≫ grain): blur smooths over 30+ px windows; mid-scale
//     features (small folds, lighting blobs) end up in HIGH and get DUMPED
//     onto the pattern as cloudy artifacts. This is the 2026-05-20 bug —
//     R=3% on a red-shirt test photo with heavy shading produced ghostly
//     grey blobs on a white print.
//
// So R should be JUST above grain size — small. The Doraemon reference
// looked clean partly because the shirt was flat-lit; on a harshly-lit
// photo even a small R can't hide all shading and you'll need to fall back
// to the legacy fold-light path. R = 0.5% min-dim ≈ 5 px on a 1000-px photo.
export function buildPhotoLowPass(
  photo: HTMLImageElement,
  radiusFrac: number,
): HTMLCanvasElement {
  const w = photo.naturalWidth;
  const h = photo.naturalHeight;
  const r = Math.max(2, Math.round(Math.min(w, h) * radiusFrac));
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d')!;
  ctx.filter = `blur(${r}px)`;
  ctx.drawImage(photo, 0, 0);
  return out;
}

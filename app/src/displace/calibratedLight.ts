import { sampleLightStats, softenLightMap } from '../canvaskit/lightStats';
import type { Quad } from '../shading';

// /canvaskit-style perceptual calibration of the LIGHT map, baked into a
// canvas so /gradient's existing GLSL uLight slot stays untouched. Replaces
// buildLumaLight (ImageMagick LIGHT port) whose sigmoid + 2× clamp was
// crushing trusted-dark pixels to L≈0 → printed = rgb·0 = visible black
// patches on the artwork.
//
// Pipeline matches /canvaskit (CanvasKitPage / CanvasKitStage):
//   1. softenLightMap        — blur hard shadow blobs into gentle gradients
//   2. sampleLightStats      — measure cloth∩quad signal spread + SNR
//   3. rebake every pixel    — depthN = clamp(depth/spread, 0, 1) (z-score),
//                              L' = 1 − depthN · TARGET_SPREAD · confidence · onCloth
//
// On a black tee the DoG light is mostly JPEG/sensor noise — sampleLightStats
// returns confidence≈0 → calibrated L collapses to identity (255) → no spurious
// dark patches. On a flat studio white tee the trusted fold depth fits exactly
// into TARGET_SPREAD so "fold depth" reads the same across photos.
const TARGET_SPREAD = 0.28;

export function buildCalibratedLight(
  rawLight: HTMLCanvasElement,
  cloth: HTMLCanvasElement | null,
  quad: Quad | null
): HTMLCanvasElement {
  const soft = softenLightMap(rawLight);
  const stats = sampleLightStats(soft, cloth, quad);

  const w = soft.width;
  const h = soft.height;
  const sd = soft.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h).data;

  const cd = cloth
    ? cloth.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, cloth.width, cloth.height).data
    : null;
  const cScaleX = cloth ? cloth.width / w : 0;
  const cScaleY = cloth ? cloth.height / h : 0;

  const sigma = Math.max(0.04, stats.spread);
  const gain = TARGET_SPREAD * stats.confidence;

  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const octx = out.getContext('2d')!;
  const od = octx.createImageData(w, h);
  const dd = od.data;

  for (let y = 0; y < h; y++) {
    const cyPx = cd ? Math.min(cloth!.height - 1, Math.max(0, Math.round(y * cScaleY))) : 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const depth = 1 - sd[i] / 255;
      const dN = Math.min(1, depth / sigma);
      let onCloth = 1;
      if (cd) {
        const cxPx = Math.min(cloth!.width - 1, Math.max(0, Math.round(x * cScaleX)));
        onCloth = cd[(cyPx * cloth!.width + cxPx) * 4] / 255;
      }
      const Lnew = 1 - Math.max(0, dN * gain * onCloth);
      const b = Math.max(0, Math.min(255, Math.round(Lnew * 255)));
      dd[i] = b;
      dd[i + 1] = b;
      dd[i + 2] = b;
      dd[i + 3] = 255;
    }
  }
  octx.putImageData(od, 0, 0);

  if (import.meta.env.DEV) {
    console.log(
      `[calibratedLight] spread=${stats.spread.toFixed(3)} conf=${stats.confidence.toFixed(2)} ` +
        `→ gain=${gain.toFixed(3)} (sigma=${sigma.toFixed(3)})`
    );
  }
  return out;
}

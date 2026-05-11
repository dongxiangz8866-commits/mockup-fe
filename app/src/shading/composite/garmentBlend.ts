import type { GarmentSample } from '../types';
import type { PresetCfg } from './presets';

// Pre-process the warped pattern (already drawn into `tmp`) so it reads as
// printed-on-cloth instead of pasted-on-sticker. Three transforms, all
// per-pixel within pattern alpha (transparent BG untouched):
//   1. Chromatic adaptation — shift pattern's color cast toward the shirt's
//      via a per-channel gain `1 - mix·(1 - shirt_norm_channel)`. Preserves
//      luminance, only adds the shirt's hue. Works correctly for any shirt
//      color (white tees pick up subtle warm/cool cast; black/colored tees
//      shift the pattern's whites without dimming them).
//   2. Black level lift — remap `[0..255]` to `[lift..255]` so pattern blacks
//      can't go below the shirt's local shadow level. Pure black ink on a
//      light shirt (where shadow = ~200) was the strongest "vector sticker"
//      cue; lifting kills it. On dark shirts lift ≈ 4-6 → effectively no-op.
//   3. (No blur here — applied at composite time via ctx.filter so the alpha
//      edge softens too, killing the cut-out vector edge.)
export function applyGarmentBlend(
  tmp: HTMLCanvasElement,
  garment: GarmentSample,
  preset: PresetCfg,
  bbox: { x: number; y: number; w: number; h: number }
): void {
  const cw = tmp.width;
  const ch = tmp.height;
  const x = Math.max(0, Math.floor(bbox.x));
  const y = Math.max(0, Math.floor(bbox.y));
  const w = Math.min(cw - x, Math.ceil(bbox.w + (bbox.x - x)));
  const h = Math.min(ch - y, Math.ceil(bbox.h + (bbox.y - y)));
  if (w <= 0 || h <= 0) return;
  const ctx = tmp.getContext('2d')!;
  const img = ctx.getImageData(x, y, w, h);
  const d = img.data;
  const [gr, gg, gb] = garment.rgb;
  const gMax = Math.max(gr, gg, gb, 1);
  // lift floor: max(garment-relative, absolute-byte). The relative term
  // (lumP5 * liftFrac) handles the white-shirt "vector ink" cue (pattern
  // blacks must not sink below shirt's shadow level). The absolute term
  // (liftMin) handles the dark-shirt "invisible blob" cue (pattern blacks
  // must be visibly above shirt's mid-tone). White: lumP5*liftFrac=22
  // dominates over liftMin=0 (no change). Black: liftMin=55+ dominates over
  // lumP5*liftFrac=0 (pattern lifted to liftMin).
  const lift = Math.max(garment.lumP5 * preset.liftFrac, preset.liftMin);
  const liftScale = (255 - lift) / 255;
  if (import.meta.env.DEV) {
    console.log(`[blend] lift=${lift.toFixed(0)} liftMin=${preset.liftMin} foldMul=${preset.foldMul} wideFoldMul=${preset.wideFoldMul} fabricMul=${preset.fabricMul}`);
  }
  const cR = 1 - preset.tint * (1 - gr / gMax);
  const cG = 1 - preset.tint * (1 - gg / gMax);
  const cB = 1 - preset.tint * (1 - gb / gMax);
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    d[i] = lift + d[i] * cR * liftScale;
    d[i + 1] = lift + d[i + 1] * cG * liftScale;
    d[i + 2] = lift + d[i + 2] * cB * liftScale;
  }
  ctx.putImageData(img, x, y);
}

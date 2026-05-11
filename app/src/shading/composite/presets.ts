import type { ShirtClass } from '../types';

// Per-shirt-type tunable preset. Decided once per photo from the GarmentSample;
// keeps the render pipeline branchless. Captures the asymmetry between shirts:
//   • white tees need pattern blacks lifted so they don't read as ink-on-paper,
//     and folds/highlights softer because shirt itself is bright (extra contrast
//     fights with the natural shirt look)
//   • black tees the opposite — no lift (would gray-wash pattern), STRONGER folds
//     because the black shirt's fold contrast is naturally subtle
//   • colored tees in between, with stronger chromatic adaptation since the
//     shirt's hue dominates the perceived integration
export type PresetCfg = {
  tint: number;             // chromatic adaptation mix
  liftFrac: number;         // fraction of garment.lumP5 to use as black-level floor
  liftMin: number;          // absolute byte floor for pattern lift (overrides liftFrac when larger). Dark shirts: ≥55 so pattern blacks don't merge with shirt's near-black background.
  foldMul: number;          // step 2.5 fitAlpha multiplier (narrow-band shading)
  wideFoldMul: number;      // step 2.5b alpha for wide-band shading map
  hlMul: number;            // step 2.6 hlAlpha multiplier
  fabricMul: number;        // step 2.7 fabric texture overlay alpha
  bendExp: number;          // cylinder bend exponent (1.0 = no bend; >1 compresses edges)
  edgeShadowPx: number;     // step 1.5d inner-shadow blur radius (pattern edge → cloth)
  edgeShadowAlpha: number;  // step 1.5d inner-shadow strength (0 disables — white preserves invariance)
};

// White preset is the locked reference — anything that touches map encoding
// is held to "white shirt unchanged". Dark-shirt smoothness is solved at the
// FLOOR (the ratio divisor clamp) inside buildShadingMap/buildHighlightMap,
// not by per-preset multiplier hacks: floor=50 doubles the divisor on near-
// black fabric, halving sensor-noise amplification, while leaving lB>50
// pixels (every white-shirt pixel) byte-identical.
//
// color.tint is small (0.12) because saturated shirts (red, blue, etc.)
// produce very asymmetric chromatic-adaptation gains. At 0.40 a red shirt
// pushes pattern G/B channels to 0.67× → pattern whites read as pink, blues
// turn magenta. 0.12 keeps a hint of color cohesion without overwriting
// pattern colors.
// wideFoldMul = 0 on white: keeps white shirt byte-identical to the prior
// pipeline. The wide-band shading map exists only to give black/colored
// shirts a fold signal in the 30-80 px range where the narrow map's
// 5%-blur kernel sits inside the fold (lB ≈ lS, no signal). Black at 0.85
// is strongest because dark-shirt fold contrast is naturally subtle and
// most photos there have only mid-frequency drape; color at 0.55 is the
// cautious middle.
// black preset (now ACTUALLY reachable after classifyShirt fix):
//   liftMin=50  pattern dark content lifted above shirt's byte 5-30 range
//               so the cat-illustration smoke / silhouette does not merge
//               into a single black blob. Cost: ~20% pattern contrast loss,
//               worth it to preserve pattern shape on dark fabric.
//   foldMul=0.40 / wideFoldMul=0.20  mild fold cue. Combined with A1's
//               [10,120] DoG amplification this gives visible fold lines on
//               bright pattern areas without crushing dark areas.
//   hlMul=0.50  modest bump highlight (was 0.95 — too aggressive when paired
//               with lift). fabricMul=0.15 keeps shirt grain transfer subtle.
export const PRESETS: Record<ShirtClass, PresetCfg> = {
  white: { tint: 0.20, liftFrac: 0.10, liftMin: 0,  foldMul: 1.10, wideFoldMul: 0.0,  hlMul: 0.90, fabricMul: 0.20, bendExp: 1.10, edgeShadowPx: 1.5, edgeShadowAlpha: 0.0 },
  black: { tint: 0.30, liftFrac: 0.0,  liftMin: 50, foldMul: 0.40, wideFoldMul: 0.20, hlMul: 0.50, fabricMul: 0.15, bendExp: 1.15, edgeShadowPx: 2.0, edgeShadowAlpha: 0.0 },
  color: { tint: 0.12, liftFrac: 0.08, liftMin: 0,  foldMul: 1.00, wideFoldMul: 0.55, hlMul: 0.92, fabricMul: 0.22, bendExp: 1.12, edgeShadowPx: 1.5, edgeShadowAlpha: 0.0 },
};

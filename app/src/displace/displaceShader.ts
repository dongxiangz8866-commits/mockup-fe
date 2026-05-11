import * as THREE from 'three';

// We use flipY=false on every texture (matches sharedTexture convention) and
// flip vUv.y in the vertex shader so vUv.y == 0 corresponds to canvas row 0
// (top of the photo). This keeps gx / gy interpretation in displace samples
// consistent with the canvas-y-down convention used at build time, so we
// don't need to negate either axis in the fragment shader.
export const vert = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = vec2(uv.x, 1.0 - uv.y);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const frag = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  uniform sampler2D uPhoto;
  uniform sampler2D uPattern;
  uniform sampler2D uDisplace;
  uniform sampler2D uLight;
  uniform sampler2D uShading;    // wide DoG raw — debug view only

  uniform float uStrength;       // 0..1 slider — scales displace offset
  uniform float uDispSign;       // +1 = pattern flows into folds (default); -1 = reverse
  uniform float uDepthWrap;      // 0 = use Sobel-disp from uDisplace; >0 = treat uDisplace texture as RAW DEPTH and warp radially around uPrintCenterUV
  uniform vec2  uPrintCenterUV;  // print quad center in PHOTO uv (top-down) — only used when uDepthWrap > 0
  uniform float uZCenter;        // depth at uPrintCenterUV, pre-computed CPU-side so the fragment shader doesn't re-sample the same texel per pixel
  uniform vec3  uEnvRGB;         // photo-wide mean RGB (0..1), print quad masked out — env color cast estimate
  uniform float uTint;           // 0..0.5 chromatic adaptation strength toward envWhite
  uniform float uSceneBrightness;// 0.5..1.0 auto from garment lum — overall pattern brightness target (black-shirt scene 0.5 to dim print, white scene 1.0 native)
  uniform float uLift;           // 0..0.3 black-level lift — pairs with sceneBrightness on dark shirts so the dimmed pattern still has a visible floor above shirt black
  uniform float uLightStrength;  // 0..1 — how much the light multiply attenuates pattern (shadow modulation)

  // DoG-Sobel displace amplitude in pixels — only consumed when uDepthWrap=0
  // (DoG-旧 mode). The depth path scales by uDepthWrap directly. Hardcoded
  // since the legacy DoG path is for comparison only and never needed runtime
  // tuning.
  const float DOG_AMP_PX = 10.0;
  uniform vec2  uPhotoSize;      // photo dimensions in pixels
  uniform vec2  uQuadTL;
  uniform vec2  uQuadTR;
  uniform vec2  uQuadBL;
  uniform int   uDebugMode;    // 0=composite, 1=displace, 2=light

  // Affine inverse using TL / TR / BL — three points are enough to invert a
  // parallelogram, which is what the existing ModelGrid pipeline uses for the
  // pattern warp. Skips real perspective recovery (would need BR + iterative
  // solve) — perspective shear in the print region is small enough on a
  // clothed torso that the quality bar matches the rest of the project.
  vec2 photoToPatternUV(vec2 puv) {
    vec2 ex = uQuadTR - uQuadTL;
    vec2 ey = uQuadBL - uQuadTL;
    vec2 d  = puv - uQuadTL;
    float det = ex.x * ey.y - ex.y * ey.x;
    return vec2(
      ( d.x * ey.y - d.y * ey.x) / det,
      (-d.x * ex.y + d.y * ex.x) / det
    );
  }

  void main() {
    vec2 puv = vUv;

    // dispCol always sampled so the 'displace' debug view keeps working
    // regardless of which path is active (Sobel vs depth radial warp).
    vec4 dispCol = texture2D(uDisplace, puv);

    vec2 puvWarped;
    if (uDepthWrap > 0.0) {
      // RADIAL DEPTH WARP — uDisplace is bound to the RAW DEPTH map.
      //
      // At the chest center, depth gradient ≈ 0 (front of body cylinder is
      // locally flat to the camera), so Sobel-of-depth produces no displacement
      // there — same problem the photo-DoG path has. Instead we use the
      // ABSOLUTE depth drop relative to the print's center as a radial
      // outward push. Math:
      //   drop = (Z_center - Z_pixel) / Z_center    // 0 at front, → 1 at body silhouette
      //   warpedPos = printCenter + (puv - printCenter) * (1 + drop * uDepthWrap)
      // Output far from print center on the body's curving-away side reads
      // pattern from FURTHER OUT in source → pattern compresses at body edges
      // = cylinder wrap appearance, driven by actual depth not by a fixed
      // angle slider.
      float zHere = dispCol.r;
      float drop = clamp((uZCenter - zHere) / max(uZCenter, 0.01), 0.0, 1.0);
      vec2 fromCenter = puv - uPrintCenterUV;
      puvWarped = uPrintCenterUV + fromCenter * (1.0 + drop * uDepthWrap * uStrength * uDispSign);
    } else {
      // Original Sobel-of-DoG path.
      vec2 disp = (dispCol.rg - vec2(0.5)) * 2.0;     // [-1, 1]
      vec2 offUV = disp * DOG_AMP_PX * uStrength * uDispSign / uPhotoSize;
      puvWarped = puv + offUV;
    }

    vec2 patUV = photoToPatternUV(puvWarped);

    vec4 patCol = texture2D(uPattern, patUV);
    // Manual bounds: ClampToEdge would otherwise smear the pattern's edge
    // pixels across the whole shirt outside [0,1].
    float inside =
      step(0.0, patUV.x) * step(patUV.x, 1.0) *
      step(0.0, patUV.y) * step(patUV.y, 1.0);
    patCol.a *= inside;

    // Environmental chromatic adaptation, sourced from the full-photo mean
    // (uEnvRGB, with print quad masked out CPU-side). Garment-based estimate
    // was unstable on dark / saturated shirts (skipped them entirely). Full-
    // image mean carries the scene's actual color cast independent of shirt
    // color. Gating: only apply when the scene shows a clear color cast
    // (envSat > ~0.15) — neutral scenes shouldn't pull pattern colors.
    float envMin = min(min(uEnvRGB.r, uEnvRGB.g), uEnvRGB.b);
    float envMax = max(max(uEnvRGB.r, uEnvRGB.g), max(uEnvRGB.b, 0.001));
    float envSat = (envMax - envMin) / envMax;
    vec3  envWhite = uEnvRGB / envMax;                  // normalize so we keep only the color cast, not the magnitude
    // Most natural-light photos average to a near-neutral grey (envSat
    // 0.03–0.10). The previous 0.10→0.30 ramp gated 色彩融合 off for the
    // vast majority of inputs. Widened to 0.03→0.12 so mildly warm/cool
    // scenes still pick up tint; truly grey scenes (envSat<0.03) still
    // skipped.
    float adaptW = uTint * smoothstep(0.03, 0.12, envSat);
    patCol.rgb = patCol.rgb * mix(vec3(1.0), envWhite, adaptW);

    // Pattern brightness / floor model (paired auto-tune from garment lum):
    //   • uSceneBrightness  (0.5..1.0) — overall pattern dim factor. Applied
    //     FIRST so the lift floor below isn't multiplied away.
    //   • uLift             (0..0.3)   — black-point lift, applied AFTER
    //     sceneBrightness, so even on black shirts the dimmed pattern has
    //     a visible floor above pure shirt-black instead of crushing.
    //   • uLightStrength    (auto white=1.0/black=0.5) — shadow modulation
    //     strength against the photo's wide-DoG light map. Unchanged.
    // Example, pattern white (1.0) on black shirt (sceneBrightness=0.5,
    // uLift=0.15, lightFactor=~0.7):
    //   1.0*0.5 = 0.5  →  0.5*(1-0.15)+0.15 = 0.575  →  0.575*0.7 ≈ 0.4
    // → mid-grey, reads as ink on black fabric, not crushed.
    vec3 rgb = patCol.rgb * uSceneBrightness;
    rgb = rgb * (1.0 - uLift) + vec3(uLift);
    float light = texture2D(uLight, puv).r;            // 0..1 (multiply ident=1)
    float lightFactor = mix(1.0, light, uLightStrength);
    // mix(1.0, x, a) keeps fractional-alpha edge softening identical to the
    // pre-change pipeline so anti-aliased print outlines don't shift.
    vec3 printed = rgb * mix(1.0, lightFactor, patCol.a);

    vec4 photoCol = texture2D(uPhoto, puv);
    vec3 composite = mix(photoCol.rgb, printed, patCol.a);

    vec3 outRGB = composite;
    if (uDebugMode == 1) outRGB = vec3(dispCol.rg, 0.5);
    else if (uDebugMode == 2) outRGB = vec3(light);
    else if (uDebugMode == 3) outRGB = vec3(texture2D(uShading, puv).r);

    gl_FragColor = vec4(outRGB, 1.0);
  }
`;

export type DisplaceUniforms = {
  uPhoto: { value: THREE.Texture | null };
  uPattern: { value: THREE.Texture | null };
  uDisplace: { value: THREE.Texture | null };
  uLight: { value: THREE.Texture | null };
  uShading: { value: THREE.Texture | null };
  uStrength: { value: number };
  uDispSign: { value: number };
  uDepthWrap: { value: number };
  uPrintCenterUV: { value: THREE.Vector2 };
  uZCenter: { value: number };
  uEnvRGB: { value: THREE.Vector3 };
  uTint: { value: number };
  uSceneBrightness: { value: number };
  uLift: { value: number };
  uLightStrength: { value: number };
  uPhotoSize: { value: THREE.Vector2 };
  uQuadTL: { value: THREE.Vector2 };
  uQuadTR: { value: THREE.Vector2 };
  uQuadBL: { value: THREE.Vector2 };
  uDebugMode: { value: number };
};

export function makeUniforms(): DisplaceUniforms {
  return {
    uPhoto: { value: null },
    uPattern: { value: null },
    uDisplace: { value: null },
    uLight: { value: null },
    uShading: { value: null },
    uStrength: { value: 1.0 },
    uDispSign: { value: 1.0 },
    uDepthWrap: { value: 0.0 },                       // 0 = Sobel disp; depth path enables this
    uPrintCenterUV: { value: new THREE.Vector2(0.5, 0.5) },
    uZCenter: { value: 0.5 },
    uEnvRGB: { value: new THREE.Vector3(0.5, 0.5, 0.5) },
    uTint: { value: 0.10 },
    uSceneBrightness: { value: 1.0 },
    uLift: { value: 0.0 },
    uLightStrength: { value: 1.0 },
    uPhotoSize: { value: new THREE.Vector2(1, 1) },
    uQuadTL: { value: new THREE.Vector2(0, 0) },
    uQuadTR: { value: new THREE.Vector2(1, 0) },
    uQuadBL: { value: new THREE.Vector2(0, 1) },
    uDebugMode: { value: 0 },
  };
}

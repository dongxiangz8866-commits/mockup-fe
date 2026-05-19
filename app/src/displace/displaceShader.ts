import * as THREE from 'three';

// MESH-WARP ARCHITECTURE (2026-05-13).
//
// Previously: single 2×2 quad + per-fragment UV warp inside the fragment
// shader. That made every pixel an independent decision point — any
// noise in the warp source (∇shading, dye bands, weave texture) became
// per-pixel artefacts (wave fragmentation, horizontal slashes).
//
// Now: 32×32 subdivided plane (1089 vertices). The vertex shader samples
// the warp sources at each vertex's UV and outputs the warped pattern UV
// as a varying. The GPU rasterizer then bilinearly interpolates that UV
// across each triangle. Two structural wins:
//
//   1. Sparse sampling (one decision per ~50 px in photo space, given a
//      32-subdivided plane on a 1500 px photo) is itself a low-pass on
//      the noisy fold detector — neighbouring vertices land on
//      similar-enough warp values that the interpolated UV field is
//      smooth.
//   2. GPU interpolation guarantees C⁰ continuity between adjacent
//      triangles. There is NO mechanism by which the pattern can crack
//      into wave fragments or horizontal slash bands; the warp field is
//      piecewise-linear over the mesh by construction.
//
// Fragment shader becomes much simpler: it just samples the pattern at
// the interpolated warped UV and composites with photo/light/occlusion
// at the nominal UV. No more 9-tap blurs, no more per-fragment gradient
// math, no more cap/threshold-tuning rabbit hole.
//
// Trade-off: warp resolution is limited by vertex density. Folds smaller
// than the vertex spacing (~50 px) can't be represented as bends in the
// warp field — they'll be averaged out. Acceptable: the user feedback
// trail through 5+ iterations was that per-pixel resolution was too
// noisy, not that we lacked sub-50-px detail.
export const vert = /* glsl */ `
  // Same flipY=false texture convention as before — flip uv.y so vUv.y=0
  // is the photo's top row.
  varying vec2 vUv;
  varying vec2 vPuvWarped;

  uniform sampler2D uDisplace;
  uniform sampler2D uShading;
  uniform sampler2D uSmoothField;
  uniform sampler2D uPhoto;

  uniform float uStrength;
  uniform float uDispSign;
  uniform float uDepthWrap;
  uniform float uWrinkleStrength;
  // Low-pass fold field ADDED into the depth z (CPU sample at print center
  // = uSmoothCenter, analogous to uZCenter). 0 ⇒ no z perturbation ⇒ the
  // cylinder wrap math is byte-identical to before this experiment.
  uniform float uSmoothWarp;
  uniform float uSmoothCenter;
  uniform vec2  uPrintCenterUV;
  uniform float uZCenter;
  uniform vec3  uGarmentRGB;
  uniform vec2  uPhotoSize;
  // Per-image shading percentiles measured inside the pose quad on the CPU
  // (sampleShadingStats). Used to remap each shading sample into a stable
  // [0..1] range so the wrinkle slider has consistent meaning across photos
  // with different DoG contrast (outdoor vs studio, dark vs light shirts).
  // p10 ≈ "deep fold" reference, p90 ≈ "flat cloth" reference.
  uniform float uShadingP10;
  uniform float uShadingP90;

  // Matches fragment-side constants (see frag block above main).
  const float DOG_AMP_PX = 10.0;
  // 2026-05-14: halved 20→10 together with FOLD_GRAD 60→25 to stop the
  // V-shape bend on high-contrast outdoor photos. Per-garment dark-boost
  // is applied on the JS side now — DisplacePage multiplies the slider
  // value by a luminance-based factor (~1.7× on black, ~0.7× on white)
  // before passing as uWrinkleStrength. Keep this constant at 10 — the
  // safe baseline for colored / light shirts. Anything higher and the
  // FOLD_GRAD-scaled-together-with-SHADING_DROP pair start bending the
  // pattern outline on cleanly-shaded non-dark photos.
  const float SHADING_DROP_AMP_PX = 10.0;
  const float SHADING_DROP_NOISE = 0.05;
  const float SHADING_DROP_FLOOR = 0.20;

  // Fold-direction push — per-vertex ∇uShading. The per-fragment version
  // produced wave fragmentation because ∇ direction flipped on sub-pixel
  // noise; per-vertex spacing is ~47 px in photo space which IS a low-pass
  // (adjacent vertices' ∇s are coherent on real folds, average out on
  // noise), and GPU bilinear interpolation between vertices guarantees
  // smooth in-triangle UV regardless of vertex-to-vertex ∇ differences.
  // FOLD_GRAD_TAP=15 photo px → 30-px sample span, captures fold-edge
  // gradient cleanly without picking up sub-fold weave. FOLD_GRAD_AMP_PX=
  // 60 lands ~9 px push per slider unit on typical 0.15 gradient
  // magnitude — comparable to radial push, complementary direction.
  const float FOLD_GRAD_TAP = 15.0;
  const float FOLD_GRAD_AMP_PX = 25.0;

  void main() {
    vec2 puv = vec2(uv.x, 1.0 - uv.y);
    vUv = puv;

    vec4 dispCol = texture2D(uDisplace, puv);

    vec2 puvWarped;
    if (uDepthWrap > 0.0) {
      // RADIAL DEPTH WARP — drop = (Z_center − Z_pixel) / Z_center.
      // Outward push proportional to local depth drop and distance from
      // print center; same math as the old per-fragment version, just
      // evaluated at vertex granularity now.
      // FOLD-INTO-DEPTH (2026-05-19 user idea). Write the low-pass fold
      // field straight into the depth z and let the SAME proven absolute-
      // radial-drop cylinder wrap consume it — value injection, NOT a
      // gradient and NOT a separate shading push (the operators that all
      // failed). z' = z + k·w on BOTH the sampled z and the print-center
      // reference, so drop' = (z'_center − z'_here)/z'_center is exactly
      // the user's "treat the wrinkle as extra depth". A bright crest
      // (high w) → higher z' → smaller drop → less outward push; a dark
      // fold (low w) → more drop → print compresses into it. No cloth-mask
      // gate on purpose: the warp must stay globally smooth (the sealed
      // "never modulate displacement by a non-smooth signal" rule) — the
      // 8% low-pass is what keeps z' smooth across the garment edge, the
      // same way DAv2 depth is smooth. uSmoothWarp=0 ⇒ z'=z ⇒ unchanged.
      float zHere = dispCol.r + uSmoothWarp * texture2D(uSmoothField, puv).r;
      float zCenterEff = uZCenter + uSmoothWarp * uSmoothCenter;
      float drop = clamp((zCenterEff - zHere) / max(zCenterEff, 0.01), 0.0, 1.0);
      vec2 fromCenter = puv - uPrintCenterUV;
      // The warp field MUST stay globally smooth. Do NOT modulate this
      // displacement by the cloth mask: B3 multiplied it by per-vertex
      // clothHere and the near-binary mask transition sheared the pattern
      // into an irregular "变形" at the garment boundary (the documented
      // "warp magnitude modulated by a non-smooth signal → 碎/切/形变"
      // failure). The cloth mask only clips ALPHA in the fragment shader
      // (visibility, geometry-free); off-garment the print is invisible
      // regardless of how this smooth warp moved it.
      puvWarped = uPrintCenterUV + fromCenter * (1.0 + drop * uDepthWrap * uStrength * uDispSign);

      // LOCAL FOLD COMPRESSION — coherent radial push modulated by local
      // shading depression. Single uShading sample per vertex (the map is
      // already CPU-blurred by buildShadingMap; no need for the in-shader
      // 9-tap that the per-fragment version had to add). Cloth-chromaticity
      // gate stays — keeps dye-mask in chroma terms so V-neck skin and hair
      // don't drive the warp.
      //
      // sNorm remaps raw shading into [0..1] using this photo's quad-ROI
      // percentiles (p10 = deep-fold reference, p90 = flat-cloth reference).
      // Without this, a flat-light studio shot with weak DoG signal would
      // need slider=3 to warp at all, while an outdoor shot with strong DoG
      // signal would over-warp at slider=0.5. After remap, both photos sit
      // in the same [0..1] band and the slider is the only knob.
      float invSpread = 1.0 / max(uShadingP90 - uShadingP10, 0.01);
      float sHere = texture2D(uShading, puv).r;
      float sNormHere = clamp((sHere - uShadingP10) * invSpread, 0.0, 1.0);
      float shadingDrop = 1.0 - sNormHere;
      vec4 fpHere = texture2D(uPhoto, puv);
      float fpMax = max(max(fpHere.r, fpHere.g), max(fpHere.b, 1.0/255.0));
      vec3 fpChroma = fpHere.rgb / fpMax;
      float gMaxC = max(max(uGarmentRGB.r, uGarmentRGB.g), max(uGarmentRGB.b, 1.0/255.0));
      vec3 gChromaC = uGarmentRGB / gMaxC;
      float clothMaskFold = 1.0 - smoothstep(0.20, 0.55, distance(fpChroma, gChromaC));
      shadingDrop *= clothMaskFold;
      float foldStrength = smoothstep(SHADING_DROP_NOISE, SHADING_DROP_FLOOR, shadingDrop);
      float fcLen = length(fromCenter);
      vec2 radialDir = fcLen > 1e-4 ? fromCenter / fcLen : vec2(0.0);
      puvWarped += radialDir * foldStrength * SHADING_DROP_AMP_PX * uWrinkleStrength * uStrength * uDispSign / uPhotoSize;

      // FOLD-DIRECTION PUSH — ∇uShading at the vertex. Adds a component
      // perpendicular to the fold ridge so letters bend ALONG the fold
      // contour (not just radially from print center). On a vertical
      // cowl drape, this pushes pattern UV horizontally; on a horizontal
      // chest fold, vertically. Direction-coherence is preserved by mesh
      // interpolation — see FOLD_GRAD_TAP / FOLD_GRAD_AMP_PX block.
      vec2 fdTx = vec2(FOLD_GRAD_TAP) / uPhotoSize;
      // Normalize each tap through the same p10/p90 remap as sHere so the
      // gradient magnitude is also stable across photos.
      float sLg = clamp((texture2D(uShading, puv + vec2(-fdTx.x, 0.0)).r - uShadingP10) * invSpread, 0.0, 1.0);
      float sRg = clamp((texture2D(uShading, puv + vec2( fdTx.x, 0.0)).r - uShadingP10) * invSpread, 0.0, 1.0);
      float sUg = clamp((texture2D(uShading, puv + vec2(0.0, -fdTx.y)).r - uShadingP10) * invSpread, 0.0, 1.0);
      float sDg = clamp((texture2D(uShading, puv + vec2(0.0,  fdTx.y)).r - uShadingP10) * invSpread, 0.0, 1.0);
      vec2 foldGrad = vec2(sRg - sLg, sDg - sUg) * clothMaskFold;
      puvWarped += foldGrad * FOLD_GRAD_AMP_PX * uWrinkleStrength * uStrength * uDispSign / uPhotoSize;
    } else {
      // Legacy Sobel-of-DoG fallback (depth path unavailable).
      vec2 disp = (dispCol.rg - vec2(0.5)) * 2.0;
      vec2 offUV = disp * DOG_AMP_PX * uStrength * uDispSign / uPhotoSize;
      puvWarped = puv + offUV;
    }

    vPuvWarped = puvWarped;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const frag = /* glsl */ `
  precision highp float;
  varying vec2 vUv;          // nominal photo UV — for photo/light/hair/shading samples
  varying vec2 vPuvWarped;   // mesh-warped photo UV — for pattern sample

  uniform sampler2D uPhoto;
  uniform sampler2D uPattern;
  uniform sampler2D uDisplace;     // depth (or Sobel byte map in legacy path)
  uniform sampler2D uWrinkleDisplace;
  uniform sampler2D uLight;
  uniform sampler2D uShading;
  uniform sampler2D uSmoothField;
  uniform sampler2D uHairMask;
  uniform sampler2D uClothMask;    // garment mask (R=1 cloth) — B-route warp/relight gate

  uniform vec3  uEnvRGB;
  uniform vec3  uGarmentRGB;
  uniform float uOcclusionStart;
  uniform float uOcclusionEnd;
  uniform float uTint;
  uniform float uSceneBrightness;
  uniform float uLift;
  uniform float uLightStrength;
  uniform vec2  uPhotoSize;
  uniform vec2  uQuadTL;
  uniform vec2  uQuadTR;
  uniform vec2  uQuadBL;
  uniform float uPatternAspect;    // pattern bitmap width/height — for aspect-preserving fit
  uniform int   uDebugMode;
  uniform float uDepthWrap;        // kept for the legacy-path debug view only
  uniform float uWrinkleStrength;  // kept so the debug ∇Shading view matches live signal

  // Affine inverse of the print quad — same as before, uses TL/TR/BL.
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

    // ASPECT-PRESERVING FIT (contain). photoToPatternUV gives quad-normalized
    // (u,v) ∈ [0,1]²; sampling the pattern with that directly stretches the
    // whole bitmap onto the quad, and the quad is locked to the physical print
    // area aspect (PRINT_ASPECT ≈ 1:1, modelAssets.ts). A wide logo squashed
    // into a near-square quad is the "上下变形" the user reported.
    //
    // Fix: place the artwork at its native aspect, centered inside the print
    // rectangle (what a real print shop does), with transparent letterbox
    // margins. Work in physical-proportional units where 1 = quad height, so
    // the quad spans quadAspect × 1. Pick the largest box of aspect
    // uPatternAspect that fits, center it, remap into its [0,1]² — the margin
    // falls outside [0,1] and the existing fwidth edge-cut clips it away.
    vec2 q = photoToPatternUV(vPuvWarped);
    float quadW = length((uQuadTR - uQuadTL) * uPhotoSize);
    float quadH = length((uQuadBL - uQuadTL) * uPhotoSize);
    float quadAspect = quadW / max(quadH, 1e-4);
    float boxW = (uPatternAspect >= quadAspect) ? quadAspect : uPatternAspect;
    float boxH = (uPatternAspect >= quadAspect) ? quadAspect / max(uPatternAspect, 1e-4) : 1.0;
    float boxLeft = (quadAspect - boxW) * 0.5;
    float boxTop  = (1.0 - boxH) * 0.5;
    vec2 patUV = vec2(
      (q.x * quadAspect - boxLeft) / boxW,
      (q.y - boxTop) / boxH
    );

    vec4 patCol = texture2D(uPattern, patUV);

    // Same edge-soft cut as before — keeps a one-pixel-wide AA at the
    // quad boundary, kills the smear-to-edge ClampToEdge would give.
    vec2 fw = max(fwidth(patUV), vec2(1e-4));
    vec2 lo = smoothstep(vec2(0.0), fw, patUV);
    vec2 hi = vec2(1.0) - smoothstep(vec2(1.0) - fw, vec2(1.0), patUV);
    float inside = lo.x * lo.y * hi.x * hi.y;
    patCol.a *= inside;

    // CLOTH CLIP (Route B / B4). B3's mask only gated the warp, so the print
    // still rendered as a floating rectangle wherever the quad spilled past
    // the shirt (onto arms / background). Clip its alpha to the garment mask
    // sampled at the on-screen UV: the print now ends at the shirt silhouette
    // and feathers out at the seam = "edge conforms to cloth". Soft smoothstep
    // (not a hard cut) + the CPU-side morphological close on uClothMask keep
    // this off failure-archive A's hole-dropping path; the white 1×1
    // mask-absent fallback makes clothClip→1 ⇒ exact pre-clip behavior.
    float clothClip = smoothstep(0.25, 0.6, texture2D(uClothMask, puv).r);
    patCol.a *= clothClip;

    // Environmental chromatic adaptation (sampled at nominal puv since
    // env color is a property of the scene, not the displaced pattern).
    float envMin = min(min(uEnvRGB.r, uEnvRGB.g), uEnvRGB.b);
    float envMax = max(max(uEnvRGB.r, uEnvRGB.g), max(uEnvRGB.b, 0.001));
    float envSat = (envMax - envMin) / envMax;
    vec3  envWhite = uEnvRGB / envMax;
    float adaptW = uTint * smoothstep(0.03, 0.12, envSat);
    patCol.rgb = patCol.rgb * mix(vec3(1.0), envWhite, adaptW);

    // Pattern brightness / floor model — unchanged.
    vec3 rgb = patCol.rgb * uSceneBrightness;
    rgb = rgb * (1.0 - uLift) + vec3(uLift);
    float light = texture2D(uLight, puv).r;
    float lightFactor = mix(1.0, light, uLightStrength);

    vec4 photoCol = texture2D(uPhoto, puv);

    // Foreground occlusion — ML hair only (chroma path stays dead per
    // 2026-05-12 finding; uOcclusionStart/End uniforms retained).
    vec2 hairTexel = 1.0 / uPhotoSize * 2.0;
    float hairProb = texture2D(uHairMask, puv).r;
    hairProb = max(hairProb, texture2D(uHairMask, puv + vec2( hairTexel.x, 0.0)).r);
    hairProb = max(hairProb, texture2D(uHairMask, puv + vec2(-hairTexel.x, 0.0)).r);
    hairProb = max(hairProb, texture2D(uHairMask, puv + vec2(0.0,  hairTexel.y)).r);
    hairProb = max(hairProb, texture2D(uHairMask, puv + vec2(0.0, -hairTexel.y)).r);
    float occlMask = (1.0 - hairProb);

    float effLightFactor = mix(1.0, lightFactor, occlMask);
    vec3 printed = rgb * mix(1.0, effLightFactor, patCol.a);
    vec3 composite = mix(photoCol.rgb, printed, patCol.a * occlMask);

    vec3 outRGB = composite;
    if (uDebugMode == 1) {
      vec4 dispCol = texture2D(uDisplace, puv);
      outRGB = vec3(dispCol.rg, 0.5);
    }
    else if (uDebugMode == 2) outRGB = vec3(light);
    else if (uDebugMode == 3) outRGB = vec3(texture2D(uShading, puv).r);
    else if (uDebugMode == 4) outRGB = vec3(texture2D(uWrinkleDisplace, puv).r);
    else if (uDebugMode == 5) {
      // Per-pixel reference of the fold-strength scalar — shows the raw
      // signal source so we can see what the vertex shader is sampling
      // at each vertex. Same math the vertex uses, evaluated densely.
      float sDbg = texture2D(uShading, puv).r;
      float depressionDbg = clamp((0.5 - sDbg) * 2.0, 0.0, 1.0);
      vec4 fpDbg = texture2D(uPhoto, puv);
      float fpMaxDbg = max(max(fpDbg.r, fpDbg.g), max(fpDbg.b, 1.0/255.0));
      vec3 fpChromaDbg = fpDbg.rgb / fpMaxDbg;
      float gMaxDbg = max(max(uGarmentRGB.r, uGarmentRGB.g), max(uGarmentRGB.b, 1.0/255.0));
      vec3 gChromaDbg = uGarmentRGB / gMaxDbg;
      float clothMaskDbg = 1.0 - smoothstep(0.20, 0.55, distance(fpChromaDbg, gChromaDbg));
      depressionDbg *= clothMaskDbg;
      float strengthDbg = smoothstep(0.05, 0.20, depressionDbg);
      outRGB = vec3(strengthDbg);
    }
    else if (uDebugMode == 6) outRGB = vec3(texture2D(uClothMask, puv).r);
    else if (uDebugMode == 7) outRGB = vec3(texture2D(uSmoothField, puv).r);

    gl_FragColor = vec4(outRGB, 1.0);
  }
`;

export type DisplaceUniforms = {
  uPhoto: { value: THREE.Texture | null };
  uPattern: { value: THREE.Texture | null };
  uDisplace: { value: THREE.Texture | null };
  uWrinkleDisplace: { value: THREE.Texture | null };
  uLight: { value: THREE.Texture | null };
  uShading: { value: THREE.Texture | null };
  uSmoothField: { value: THREE.Texture | null };
  uHairMask: { value: THREE.Texture | null };
  uClothMask: { value: THREE.Texture | null };
  uStrength: { value: number };
  uDispSign: { value: number };
  uDepthWrap: { value: number };
  uWrinkleStrength: { value: number };
  uSmoothWarp: { value: number };
  uSmoothCenter: { value: number };
  uShadingP10: { value: number };
  uShadingP90: { value: number };
  uPrintCenterUV: { value: THREE.Vector2 };
  uZCenter: { value: number };
  uZRange: { value: number };
  uEnvRGB: { value: THREE.Vector3 };
  uGarmentRGB: { value: THREE.Vector3 };
  uOcclusionStart: { value: number };
  uOcclusionEnd: { value: number };
  uTint: { value: number };
  uSceneBrightness: { value: number };
  uLift: { value: number };
  uLightStrength: { value: number };
  uPhotoSize: { value: THREE.Vector2 };
  uQuadTL: { value: THREE.Vector2 };
  uQuadTR: { value: THREE.Vector2 };
  uQuadBL: { value: THREE.Vector2 };
  uPatternAspect: { value: number };
  uDebugMode: { value: number };
};

export function makeUniforms(): DisplaceUniforms {
  return {
    uPhoto: { value: null },
    uPattern: { value: null },
    uDisplace: { value: null },
    uWrinkleDisplace: { value: null },
    uLight: { value: null },
    uShading: { value: null },
    uSmoothField: { value: null },
    uHairMask: { value: null },
    uClothMask: { value: null },
    uStrength: { value: 1.0 },
    uDispSign: { value: 1.0 },
    uDepthWrap: { value: 0.0 },
    uWrinkleStrength: { value: 1.0 },
    uSmoothWarp: { value: 0.0 },
    uSmoothCenter: { value: 0.0 },
    uShadingP10: { value: 0.35 },
    uShadingP90: { value: 0.50 },
    uPrintCenterUV: { value: new THREE.Vector2(0.5, 0.5) },
    uZCenter: { value: 0.5 },
    uZRange: { value: 0.08 },
    uEnvRGB: { value: new THREE.Vector3(0.5, 0.5, 0.5) },
    uGarmentRGB: { value: new THREE.Vector3(0.5, 0.5, 0.5) },
    uOcclusionStart: { value: 0.15 },
    uOcclusionEnd: { value: 0.45 },
    uTint: { value: 0.10 },
    uSceneBrightness: { value: 1.0 },
    uLift: { value: 0.0 },
    uLightStrength: { value: 1.0 },
    uPhotoSize: { value: new THREE.Vector2(1, 1) },
    uQuadTL: { value: new THREE.Vector2(0, 0) },
    uQuadTR: { value: new THREE.Vector2(1, 0) },
    uQuadBL: { value: new THREE.Vector2(0, 1) },
    uPatternAspect: { value: 1.0 },
    uDebugMode: { value: 0 },
  };
}

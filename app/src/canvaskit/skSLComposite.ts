// SkSL pass-2 composite — a faithful port of displaceShader.frag main(),
// MINUS the warp/contain/edge-cut/cloth-clip (those are baked into pass 1:
// the drawVertices mesh already places the warped, contain-fit, cloth-
// clipped pattern into the offscreen `uPattern`). Pass 2 only does the
// per-pixel photo composite: env chromatic adaptation, lift, scene
// brightness, light × hair-occlusion, and the 7 debug views.
//
// Child shaders (order MUST match the array passed to
// makeShaderWithChildren): pattern, photo, light, shading, smooth,
// displace, fine, hair, cloth.
//
// pattern is offscreen and SURFACE-sized → sample at fragCoord directly.
// every map is photo-native → sample at uv*uMapSz. Child .eval() returns
// premultiplied; only `pattern` carries alpha so it is unpremultiplied to
// match the frag's straight-alpha texture2D math; everything else is opaque.

export const COMPOSITE_SKSL = /* glsl */ `
uniform shader uPattern;
uniform shader uPhoto;
uniform shader uLight;
uniform shader uShading;
uniform shader uSmooth;
uniform shader uDisplace;
uniform shader uFine;
uniform shader uHair;
uniform shader uCloth;

uniform float2 uSurf;
uniform float2 uMapSz;
uniform float3 uEnvRGB;
uniform float3 uGarmentRGB;
uniform float  uTint;
uniform float  uSceneBrightness;
uniform float  uLift;
uniform float  uLightStrength;
uniform float  uDebugMode;
uniform float  uDepthWrap;
uniform float  uWrinkleStrength;
uniform float  uShadingP10;
uniform float  uShadingP90;

half4 main(float2 fc) {
  float2 uv = fc / uSurf;
  float2 mp = uv * uMapSz;

  half4 pPM = uPattern.eval(fc);
  float pa = pPM.a;
  half3 pat = pa > 0.0001 ? pPM.rgb / pa : half3(0.0);
  half3 photoCol = uPhoto.eval(mp).rgb;

  // Environmental chromatic adaptation (scene property → nominal uv).
  float envMin = min(min(uEnvRGB.r, uEnvRGB.g), uEnvRGB.b);
  float envMax = max(max(uEnvRGB.r, uEnvRGB.g), max(uEnvRGB.b, 0.001));
  float envSat = (envMax - envMin) / envMax;
  half3 envWhite = half3(uEnvRGB / envMax);
  float adaptW = uTint * smoothstep(0.03, 0.12, envSat);
  pat = pat * mix(half3(1.0), envWhite, adaptW);

  half3 rgb = pat * uSceneBrightness;
  rgb = rgb * (1.0 - uLift) + half3(uLift);
  float light = uLight.eval(mp).r;
  float lightFactor = mix(1.0, light, uLightStrength);

  // Foreground occlusion — ML hair only (5-tap max, ~2 px).
  float hair = uHair.eval(mp).r;
  hair = max(hair, uHair.eval(mp + float2(2.0, 0.0)).r);
  hair = max(hair, uHair.eval(mp + float2(-2.0, 0.0)).r);
  hair = max(hair, uHair.eval(mp + float2(0.0, 2.0)).r);
  hair = max(hair, uHair.eval(mp + float2(0.0, -2.0)).r);
  float occl = 1.0 - hair;

  float effLF = mix(1.0, lightFactor, occl);
  half3 printed = rgb * mix(1.0, effLF, pa);
  half3 comp = mix(photoCol, printed, pa * occl);

  half3 outRGB = comp;
  int dm = int(uDebugMode + 0.5);
  if (dm == 1) { half4 d = uDisplace.eval(mp); outRGB = half3(d.r, d.g, 0.5); }
  else if (dm == 2) outRGB = half3(light);
  else if (dm == 3) outRGB = half3(uShading.eval(mp).r);
  else if (dm == 4) outRGB = half3(uFine.eval(mp).r);
  else if (dm == 5) {
    float sDbg = uShading.eval(mp).r;
    float depr = clamp((0.5 - sDbg) * 2.0, 0.0, 1.0);
    half4 fpD = uPhoto.eval(mp);
    float fpMaxD = max(max(fpD.r, fpD.g), max(fpD.b, 1.0 / 255.0));
    half3 fpC = fpD.rgb / fpMaxD;
    float gMaxD = max(max(uGarmentRGB.r, uGarmentRGB.g), max(uGarmentRGB.b, 1.0 / 255.0));
    half3 gC = half3(uGarmentRGB / gMaxD);
    float clothD = 1.0 - smoothstep(0.20, 0.55, distance(fpC, gC));
    depr = depr * clothD;
    outRGB = half3(smoothstep(0.05, 0.20, depr));
  }
  else if (dm == 6) outRGB = half3(uCloth.eval(mp).r);
  else if (dm == 7) outRGB = half3(uSmooth.eval(mp).r);

  return half4(outRGB, 1.0);
}
`;

// Child shader names in the exact order makeShaderWithChildren expects.
export const CHILD_ORDER = [
  'pattern', 'photo', 'light', 'shading', 'smooth', 'displace', 'fine', 'hair', 'cloth',
] as const;

export type CompositeUniforms = {
  surfW: number;
  surfH: number;
  mapW: number;
  mapH: number;
  envRGB: [number, number, number];
  garmentRGB: [number, number, number];
  tint: number;
  sceneBrightness: number;
  lift: number;
  lightStrength: number;
  debugMode: number;
  depthWrap: number;
  wrinkleStrength: number;
  shadingP10: number;
  shadingP90: number;
};

// Flatten in SkSL declaration order — CanvasKit packs runtime-effect
// uniforms tightly (float3 = 3 floats, no std140 padding). 19 floats.
export function packUniforms(u: CompositeUniforms): Float32Array {
  return new Float32Array([
    u.surfW, u.surfH,
    u.mapW, u.mapH,
    u.envRGB[0], u.envRGB[1], u.envRGB[2],
    u.garmentRGB[0], u.garmentRGB[1], u.garmentRGB[2],
    u.tint,
    u.sceneBrightness,
    u.lift,
    u.lightStrength,
    u.debugMode,
    u.depthWrap,
    u.wrinkleStrength,
    u.shadingP10,
    u.shadingP90,
  ]);
}

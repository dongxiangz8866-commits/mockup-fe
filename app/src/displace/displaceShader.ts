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
  uniform float uAmpPx;          // max ±pixels at strength=1
  uniform float uDispSign;       // +1 = pattern flows into folds (default); -1 = reverse
  uniform float uDepthWrap;      // 0 = use Sobel-disp from uDisplace; >0 = treat uDisplace texture as RAW DEPTH and warp radially around uPrintCenterUV
  uniform vec2  uPrintCenterUV;  // print quad center in PHOTO uv (top-down) — only used when uDepthWrap > 0
  uniform float uZCenter;        // depth at uPrintCenterUV, pre-computed CPU-side so the fragment shader doesn't re-sample the same texel per pixel
  uniform float uHalfAngle;      // RADIANS: half-extent of the cylinder the print subtends on the body. 0 = flat. ~0.31 (≈18°, total 36°) is a typical chest print on a torso. >1.0 starts to feel fish-eye.
  uniform float uBodyShade;      // 0..0.4 cosine-falloff darkening toward pattern-u edges (cylinder Lambertian)
  uniform vec3  uGarmentRGB;     // shirt color sampled from the print quad (0..1 normalized)
  uniform float uTint;           // 0..0.5 chromatic adaptation: how much the print picks up shirt's color cast
  uniform float uLift;           // 0..0.4 black-level lift: pattern blacks rise to byte uLift*255 (kills "ink-on-paper" cue on light shirts; on dark shirts kills "invisible blob" merging)
  uniform float uLightStrength;  // 0..1 — how much the light multiply attenuates pattern
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
      vec2 offUV = disp * uAmpPx * uStrength * uDispSign / uPhotoSize;
      puvWarped = puv + offUV;
    }

    vec2 patUV = photoToPatternUV(puvWarped);

    // True cylinder projection in pattern-u (pose-aligned: the quad u-axis is
    // the shoulder line). Forward physics: a flat artwork wrapped onto a
    // cylinder of half-angular-extent α projects to x = sin(u·α)/sin(α). We
    // invert to find the source u for each output x. uHalfAngle = 0 →
    // identity (flat sticker). Power-function approximations (pow(u, p))
    // give "fish-eye" distortion at high values because they violate the
    // sin/asin geometry — center over-stretches, edges over-compress.
    float u = (patUV.x - 0.5) * 2.0;                  // [-1, 1] across the print
    float sa = sin(max(uHalfAngle, 1e-4));
    float srcU = asin(clamp(u * sa, -1.0, 1.0)) / max(uHalfAngle, 1e-4);
    patUV.x = srcU * 0.5 + 0.5;

    vec4 patCol = texture2D(uPattern, patUV);
    // Manual bounds: ClampToEdge would otherwise smear the pattern's edge
    // pixels across the whole shirt outside [0,1].
    float inside =
      step(0.0, patUV.x) * step(patUV.x, 1.0) *
      step(0.0, patUV.y) * step(patUV.y, 1.0);
    patCol.a *= inside;

    // Cloth integration — this is what kills the "sticker pasted on top"
    // look. Three transforms applied to the pattern's RGB inside its alpha:
    //   1. Chromatic adaptation: shift pattern's color cast toward the
    //      shirt's hue. Per-channel gain (1 - tint·(1 - shirt_norm_channel))
    //      preserves luminance, only adds the shirt's color cast.
    //   2. Black-level lift: remap [0..1] to [lift..1] so pattern blacks
    //      can't sink below the shirt's local shadow (kills "vector ink"
    //      cue on light shirts; raises pattern dark content above shirt's
    //      near-black noise floor on dark shirts).
    //   3. Lighting (below): photo-driven light map × body-curvature cos.
    float gMax = max(max(uGarmentRGB.r, uGarmentRGB.g), max(uGarmentRGB.b, 0.001));
    vec3 chrom = vec3(1.0) - uTint * (vec3(1.0) - uGarmentRGB / gMax);
    float liftScale = 1.0 - uLift;
    patCol.rgb = vec3(uLift) + patCol.rgb * chrom * liftScale;

    // Light map alone is too aggressive for dark shirts: A1 stretch + DoG
    // can push fold bytes down to ~50, mapping to a 0.4× multiply that
    // crushes the print's color. uLightStrength interpolates between the
    // raw map (1.0 = full effect) and identity (0.0 = no light at all).
    float light = texture2D(uLight, puv).r;            // 0..1 (multiply ident=1)
    float lightFactor = mix(1.0, light, uLightStrength);
    // Body-curvature Lambertian: cos(θ) where θ is the cylinder angle at the
    // print's projected u position. Uses the SAME uHalfAngle as the bend so
    // the geometric and shading cues are consistent.
    float bodyFactor = mix(1.0, cos(u * uHalfAngle), uBodyShade);
    vec3 printed = patCol.rgb * mix(1.0, lightFactor * bodyFactor, patCol.a);

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
  uAmpPx: { value: number };
  uDispSign: { value: number };
  uDepthWrap: { value: number };
  uPrintCenterUV: { value: THREE.Vector2 };
  uZCenter: { value: number };
  uHalfAngle: { value: number };
  uBodyShade: { value: number };
  uGarmentRGB: { value: THREE.Vector3 };
  uTint: { value: number };
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
    uAmpPx: { value: 10.0 },
    uDispSign: { value: 1.0 },
    uDepthWrap: { value: 0.0 },                       // 0 = Sobel disp; depth path enables this
    uPrintCenterUV: { value: new THREE.Vector2(0.5, 0.5) },
    uZCenter: { value: 0.5 },
    uHalfAngle: { value: 0.0 },   // OFF by default — cylinder warp on its own reads as fish-eye
    uBodyShade: { value: 0.0 },
    uGarmentRGB: { value: new THREE.Vector3(0.5, 0.5, 0.5) },
    uTint: { value: 0.20 },
    uLift: { value: 0.05 },
    uLightStrength: { value: 0.3 },
    uPhotoSize: { value: new THREE.Vector2(1, 1) },
    uQuadTL: { value: new THREE.Vector2(0, 0) },
    uQuadTR: { value: new THREE.Vector2(1, 0) },
    uQuadBL: { value: new THREE.Vector2(0, 1) },
    uDebugMode: { value: 0 },
  };
}

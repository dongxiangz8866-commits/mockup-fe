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

    vec4 dispCol = texture2D(uDisplace, puv);
    vec2 disp = (dispCol.rg - vec2(0.5)) * 2.0;       // [-1, 1]
    vec2 offUV = disp * uAmpPx * uStrength / uPhotoSize;

    vec2 patUV = photoToPatternUV(puv + offUV);
    vec4 patCol = texture2D(uPattern, patUV);
    // Manual bounds: ClampToEdge would otherwise smear the pattern's edge
    // pixels across the whole shirt outside [0,1].
    float inside =
      step(0.0, patUV.x) * step(patUV.x, 1.0) *
      step(0.0, patUV.y) * step(patUV.y, 1.0);
    patCol.a *= inside;

    // Light map alone is too aggressive for dark shirts: A1 stretch + DoG
    // can push fold bytes down to ~50, mapping to a 0.4× multiply that
    // crushes the print's color. uLightStrength interpolates between the
    // raw map (1.0 = full effect) and identity (0.0 = no light at all).
    float light = texture2D(uLight, puv).r;            // 0..1 (multiply ident=1)
    float lightFactor = mix(1.0, light, uLightStrength);
    vec3 printed = patCol.rgb * mix(1.0, lightFactor, patCol.a);

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
    uLightStrength: { value: 0.3 },
    uPhotoSize: { value: new THREE.Vector2(1, 1) },
    uQuadTL: { value: new THREE.Vector2(0, 0) },
    uQuadTR: { value: new THREE.Vector2(1, 0) },
    uQuadBL: { value: new THREE.Vector2(0, 1) },
    uDebugMode: { value: 0 },
  };
}

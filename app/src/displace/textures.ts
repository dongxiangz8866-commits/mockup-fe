import * as THREE from 'three';

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`load failed: ${src}`));
    img.src = src;
  });
}

export function rasterizePattern(img: HTMLImageElement): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext('2d')!.drawImage(img, 0, 0);
  return c;
}

// All textures here use NoColorSpace. The DisplaceCanvas pairs this with
// `outputColorSpace = LinearSRGBColorSpace` on the renderer so the photo's
// sRGB bytes pass straight through: no shader-side decode, no renderer-side
// re-encode. Custom ShaderMaterial in three.js does NOT auto-inject sRGB
// decoding (only built-in materials like MeshStandardMaterial do); marking
// the texture sRGB while leaving the shader unchanged would cause double
// sRGB encoding at output time → photo renders darker than the source.
//
// flipY=false matches `textureStore.sharedTexture` and keeps the displace
// map's gradient encoding consistent with canvas-y-down. The vertex shader
// compensates by flipping vUv.y so the photo still displays top-up.

export function canvasToTexture(canvas: HTMLCanvasElement): THREE.Texture {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.NoColorSpace;
  t.flipY = false;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

export function imageToTexture(img: HTMLImageElement): THREE.Texture {
  const t = new THREE.Texture(img);
  t.colorSpace = THREE.NoColorSpace;
  t.flipY = false;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

// Encoded-data textures (displace, light, shading) — same setup. The byte
// values are direct numeric encodings, never perceptual colors.
export function dataCanvasToTexture(canvas: HTMLCanvasElement): THREE.Texture {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.NoColorSpace;
  t.flipY = false;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

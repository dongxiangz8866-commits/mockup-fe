import * as THREE from 'three';

export const TEX_W = 4096;
export const TEX_H = 4096;

export const GRID_COLS = 16;
export const GRID_ROWS = 18;

const canvas = document.createElement('canvas');
canvas.width = TEX_W;
canvas.height = TEX_H;

export const sharedCanvas = canvas;
export const sharedCtx = canvas.getContext('2d')!;

export const sharedTexture = new THREE.CanvasTexture(canvas);
sharedTexture.colorSpace = THREE.SRGBColorSpace;
sharedTexture.flipY = false;
sharedTexture.anisotropy = 16;
sharedTexture.minFilter = THREE.LinearMipmapLinearFilter;
sharedTexture.magFilter = THREE.LinearFilter;
sharedTexture.generateMipmaps = true;

// 2048-wide so the pattern stays sharp when warped onto large (4-5K) photos —
// at 1024 the pattern was upsampled which softened the edges.
// Aspect matches the print plate (16in × 18in = 40.64 × 45.72 cm).
export const PHOTO_PATTERN_W = 2048;
export const PHOTO_PATTERN_H = Math.round((2048 * 45.72) / 40.64);

const photoCanvas = document.createElement('canvas');
photoCanvas.width = PHOTO_PATTERN_W;
photoCanvas.height = PHOTO_PATTERN_H;
export const photoPatternCanvas = photoCanvas;
export const photoPatternCtx = photoCanvas.getContext('2d')!;

let listeners: Array<() => void> = [];
export function subscribePattern(cb: () => void): () => void {
  listeners.push(cb);
  return () => {
    listeners = listeners.filter((l) => l !== cb);
  };
}

export const markTextureDirty = () => {
  sharedTexture.needsUpdate = true;
  for (const l of listeners) l();
};

if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { __sharedCanvas: HTMLCanvasElement; __sharedTex: typeof sharedTexture }).__sharedCanvas = sharedCanvas;
  (window as unknown as { __sharedCanvas: HTMLCanvasElement; __sharedTex: typeof sharedTexture }).__sharedTex = sharedTexture;
}

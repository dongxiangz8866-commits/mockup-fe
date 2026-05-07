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

export const markTextureDirty = () => {
  sharedTexture.needsUpdate = true;
};

if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { __sharedCanvas: HTMLCanvasElement; __sharedTex: typeof sharedTexture }).__sharedCanvas = sharedCanvas;
  (window as unknown as { __sharedCanvas: HTMLCanvasElement; __sharedTex: typeof sharedTexture }).__sharedTex = sharedTexture;
}

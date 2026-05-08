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

// Source pattern image + its UV box. Real-model composite warps this image
// directly onto the photo via a single affine — no intermediate downsampled
// canvas — so source resolution survives all the way to the quad rasterization.
//
// `img` is CanvasImageSource (HTMLImageElement | ImageBitmap | …) so callers
// can pass either the raw <img> or a pre-resized ImageBitmap — useful when
// the source is low-res and was bicubic-upsampled via createImageBitmap with
// resizeQuality:'high' (sharper than canvas's bilinear upsample).
export type PatternBox = { u: number; v: number; w: number; h: number };
export type PatternState = {
  img: CanvasImageSource;
  width: number;
  height: number;
  box: PatternBox;
} | null;
let pattern: PatternState = null;
export const getPattern = (): PatternState => pattern;
export const setPattern = (p: PatternState): void => {
  pattern = p;
};

let listeners: Array<() => void> = [];
export function subscribePattern(cb: () => void): () => void {
  listeners.push(cb);
  return () => {
    listeners = listeners.filter((l) => l !== cb);
  };
}

// rAF-coalesced notification. Pattern drag fires markTextureDirty on every
// pointermove (60-120 Hz on modern devices). Each subscriber redraws a full-
// resolution photo composite with multiple blends, so synchronous fan-out
// turns drag into a slideshow. requestAnimationFrame caps notifications to
// at most one per browser frame and lets multiple dirty events coalesce.
let pendingNotify = false;
const notifyListeners = () => {
  pendingNotify = false;
  for (const l of listeners) l();
};

export const markTextureDirty = () => {
  sharedTexture.needsUpdate = true;
  if (pendingNotify) return;
  pendingNotify = true;
  requestAnimationFrame(notifyListeners);
};

if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { __sharedCanvas: HTMLCanvasElement; __sharedTex: typeof sharedTexture }).__sharedCanvas = sharedCanvas;
  (window as unknown as { __sharedCanvas: HTMLCanvasElement; __sharedTex: typeof sharedTexture }).__sharedTex = sharedTexture;
}

import { pipeline, RawImage } from '@huggingface/transformers';

// DAv2 Base = ~100 MB ONNX. First-load cached by browser; subsequent visits
// hit the disk cache. Lazy module-level singleton avoids re-initializing the
// graph between photo switches.
let pipePromise: Promise<unknown> | null = null;

const MODEL_ID = 'onnx-community/depth-anything-v2-base';

// Try WebGPU first (1-3s inference on Apple Silicon / modern dGPU). Fall back
// to default backend (WASM, ~10-20s for Base size) if WebGPU isn't available
// or model loading fails on it.
async function makePipe(): Promise<unknown> {
  try {
    return await pipeline('depth-estimation', MODEL_ID, {
      device: 'webgpu',
      dtype: 'fp32',
    });
  } catch (e) {
    console.warn('[depth] webgpu init failed, falling back to wasm:', e);
    return await pipeline('depth-estimation', MODEL_ID);
  }
}

// Same rationale as poseDetector.getLandmarker: clear the slot on rejection
// so a single CDN / WebGPU init flake doesn't permanently poison the cache.
export function getDepthPipe(): Promise<unknown> {
  if (pipePromise) return pipePromise;
  const p = makePipe();
  p.catch(() => {
    if (pipePromise === p) pipePromise = null;
  });
  pipePromise = p;
  return p;
}

// Run DAv2 on the photo and return a grayscale depth canvas at PHOTO native
// resolution (model itself runs at its preferred input size — typically 518²;
// the result is upscaled to photo dims so subsequent Sobel runs at full res).
export async function estimateDepth(photo: HTMLImageElement): Promise<HTMLCanvasElement> {
  // Pair with getDepthPipe's rejection reset: first attempt may flake on
  // CDN / WebGPU init; second attempt re-inits from scratch and usually
  // succeeds. Without this, transient hiccups bubble up as "all failed".
  let pipe: (img: RawImage) => Promise<{ depth: RawImage }>;
  try {
    pipe = (await getDepthPipe()) as (img: RawImage) => Promise<{ depth: RawImage }>;
  } catch (e) {
    console.warn('[depth] first init threw, retrying once in 500ms:', e);
    await new Promise((r) => setTimeout(r, 500));
    pipe = (await getDepthPipe()) as (img: RawImage) => Promise<{ depth: RawImage }>;
  }
  // Convert HTMLImageElement → RawImage via canvas readback. Avoids the URL
  // fetch path inside transformers (which trips on blob: URLs from
  // URL.createObjectURL and on cross-origin photo sources without CORS).
  const w = photo.naturalWidth;
  const h = photo.naturalHeight;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(photo, 0, 0);
  const imgData = ctx.getImageData(0, 0, w, h);
  const raw = new RawImage(new Uint8ClampedArray(imgData.data), w, h, 4);
  const result = await pipe(raw);
  const depthRaw = result.depth;

  // RawImage from transformers is grayscale Uint8Array (channels=1).
  const w0 = depthRaw.width;
  const h0 = depthRaw.height;
  const tmp = document.createElement('canvas');
  tmp.width = w0;
  tmp.height = h0;
  const tctx = tmp.getContext('2d')!;
  const td = tctx.createImageData(w0, h0);
  // Replicate single-channel grayscale to RGB.
  for (let i = 0; i < depthRaw.data.length; i++) {
    const v = depthRaw.data[i];
    td.data[i * 4] = v;
    td.data[i * 4 + 1] = v;
    td.data[i * 4 + 2] = v;
    td.data[i * 4 + 3] = 255;
  }
  tctx.putImageData(td, 0, 0);

  // Two-step: blur at the DAv2 native resolution first (small canvas, cheap
  // kernel, predictable Skia behavior for large blur radii), THEN upscale to
  // photo size. The displace shader's radial wrap reads
  //   drop = (zCenter - zHere) / zCenter
  // per fragment and multiplies it into the warp offset, so any local depth
  // variation (clothing folds, hair shadows, the print already on the shirt,
  // jewelry) bends adjacent pixels of the pattern by different amounts and
  // turns straight horizontal lines into waves. We want only the smooth
  // front-to-side body-cylinder slope to survive — everything else has to
  // go. A native-resolution kernel of w0/12 ≈ 43 px on a 518² depth = a
  // 12-pixel feature wipe, well above the scale of clothing noise.
  const blurred = document.createElement('canvas');
  blurred.width = w0;
  blurred.height = h0;
  const bctx = blurred.getContext('2d')!;
  const blurPxNative = Math.max(8, Math.round(w0 / 12));
  bctx.filter = `blur(${blurPxNative}px)`;
  bctx.drawImage(tmp, 0, 0);
  console.log('[depth] blurred at native', w0, 'x', h0, 'with', blurPxNative, 'px → upscaling to', photo.naturalWidth, 'x', photo.naturalHeight);

  const out = document.createElement('canvas');
  out.width = photo.naturalWidth;
  out.height = photo.naturalHeight;
  const octx = out.getContext('2d')!;
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(blurred, 0, 0, out.width, out.height);
  return out;
}

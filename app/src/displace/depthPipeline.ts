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

export function getDepthPipe(): Promise<unknown> {
  if (!pipePromise) pipePromise = makePipe();
  return pipePromise;
}

// Run DAv2 on the photo and return a grayscale depth canvas at PHOTO native
// resolution (model itself runs at its preferred input size — typically 518²;
// the result is upscaled to photo dims so subsequent Sobel runs at full res).
export async function estimateDepth(photo: HTMLImageElement): Promise<HTMLCanvasElement> {
  const pipe = (await getDepthPipe()) as (img: RawImage) => Promise<{ depth: RawImage }>;
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

  // Upscale (bilinear) to photo native size. Sobel later runs at this res so
  // depth gradient resolution matches the displace shader's photo-uv sampling.
  const out = document.createElement('canvas');
  out.width = photo.naturalWidth;
  out.height = photo.naturalHeight;
  const octx = out.getContext('2d')!;
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(tmp, 0, 0, out.width, out.height);
  return out;
}

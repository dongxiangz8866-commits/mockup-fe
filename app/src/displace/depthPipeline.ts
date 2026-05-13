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

export type DepthMaps = {
  /** Macro depth — heavy blur, drives the radial body-cylinder wrap. Local
   *  fold detail is wiped on purpose so the radial drop reads only the
   *  smooth front-to-side curvature. */
  depth: HTMLCanvasElement;
  /** Fine depth — light blur, preserves clothing-fold gradients. Consumed
   *  by the in-shader Sobel-of-depth term so vertical drape / cowl creases
   *  bend the pattern locally. Same source inference as `depth`; just a
   *  different blur of the same raw DAv2 output. */
  depthFine: HTMLCanvasElement;
};

// Run DAv2 on the photo and return TWO grayscale depth canvases at PHOTO
// native resolution — see DepthMaps. The model itself runs at its preferred
// input size (~518²); both outputs are upscaled to photo dims.
export async function estimateDepth(photo: HTMLImageElement): Promise<DepthMaps> {
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
  // photo size. We emit TWO blur levels off the same source:
  //   • MACRO (w0/12 ≈ 43 px on 518²) — for the radial wrap. Wipes folds,
  //     hair shadows, print-on-shirt edges, jewelry by design; only the
  //     smooth front-to-side body-cylinder slope survives. Pre-2026-05-13
  //     this was the only output, and its design comment is preserved:
  //     local depth variation bends adjacent pattern pixels by different
  //     amounts, which turns straight pattern lines into waves under the
  //     radial-wrap formula — bad if you only have radial wrap.
  //   • FINE (w0/96 ≈ 5 px on 518²) — for the in-shader depth-gradient term
  //     (∇z added to the warp offset). Here we WANT folds to bend pattern,
  //     because the gradient term is what produces local drape compliance.
  //     The 5 px kernel still smooths DAv2 per-pixel noise but preserves
  //     fold-scale features (~20-100 px in photo space). Pre-2026-05-13 we
  //     used w0/64 ≈ 8 px and the shader's 4-px central-diff sampler ended
  //     up reading gradient from INSIDE the blur peak — fold response was
  //     near-zero. The shader now central-diffs at FOLD_TAP=12 px, which
  //     pairs with a tighter native blur to give a real fold response.
  const macroBlurPx = Math.max(8, Math.round(w0 / 12));
  const fineBlurPx = Math.max(2, Math.round(w0 / 96));

  const macroOut = blurAndUpscale(tmp, macroBlurPx, photo.naturalWidth, photo.naturalHeight);
  const fineOut = blurAndUpscale(tmp, fineBlurPx, photo.naturalWidth, photo.naturalHeight);
  console.log(
    '[depth] blurred at native', w0, 'x', h0,
    'with macro=' + macroBlurPx + 'px, fine=' + fineBlurPx + 'px',
    '→ upscaling to', photo.naturalWidth, 'x', photo.naturalHeight
  );

  return { depth: macroOut, depthFine: fineOut };
}

function blurAndUpscale(
  src: HTMLCanvasElement,
  blurPx: number,
  outW: number,
  outH: number
): HTMLCanvasElement {
  const blurred = document.createElement('canvas');
  blurred.width = src.width;
  blurred.height = src.height;
  const bctx = blurred.getContext('2d')!;
  bctx.filter = `blur(${blurPx}px)`;
  bctx.drawImage(src, 0, 0);

  const out = document.createElement('canvas');
  out.width = outW;
  out.height = outH;
  const octx = out.getContext('2d')!;
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(blurred, 0, 0, outW, outH);
  return out;
}

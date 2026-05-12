import { ImageSegmenter, FilesetResolver } from '@mediapipe/tasks-vision';

// MediaPipe Selfie Multiclass Segmenter — 256² input, 6 output classes:
//   0=background, 1=hair, 2=body-skin, 3=face-skin, 4=clothes, 5=accessories
// We only consume class 1 (hair) to feed the displace path's foreground
// occlusion mask. Compared with the chroma-distance heuristic, this gives
// crisp per-strand boundaries (the high-frequency hair detail that previously
// granulated the print is now a clean 0/1 mask plus the model's own
// confidence-weighted soft edge).

const WASM_BASE =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite';

const HAIR_CLASS = 1;

let segmenterPromise: Promise<ImageSegmenter> | null = null;

// Same lazy-singleton-with-rejection-reset pattern as poseDetector and
// depthPipeline: a transient CDN/WASM-init flake on first call would
// otherwise permanently poison the singleton until full page reload.
function getSegmenter(): Promise<ImageSegmenter> {
  if (segmenterPromise) return segmenterPromise;
  const p = (async () => {
    const vision = await FilesetResolver.forVisionTasks(WASM_BASE);
    return ImageSegmenter.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
      runningMode: 'IMAGE',
      outputCategoryMask: true,
      outputConfidenceMasks: false,
    });
  })();
  p.catch(() => {
    if (segmenterPromise === p) segmenterPromise = null;
  });
  segmenterPromise = p;
  return p;
}

// Returns an L8-style RGBA canvas at photo native resolution where R=255
// means HAIR and R=0 means non-hair. Pose-style three-tier caching is done
// by useHairMask; this function only handles the inference step.
export async function segmentHair(photo: HTMLImageElement): Promise<HTMLCanvasElement> {
  let seg: ImageSegmenter;
  try {
    seg = await getSegmenter();
  } catch (e) {
    console.warn('[hair] first init threw, retrying once in 500ms:', e);
    await new Promise((r) => setTimeout(r, 500));
    seg = await getSegmenter();
  }

  // segment() returns a CATEGORY_MASK (Uint8 per-pixel class id) sized to
  // model input (256² internal, but the API canvas is the source size).
  const result = seg.segment(photo);
  const cat = result.categoryMask;
  if (!cat) throw new Error('hair segmenter returned no category mask');

  const w0 = cat.width;
  const h0 = cat.height;
  const buf = cat.getAsUint8Array();
  const tmp = document.createElement('canvas');
  tmp.width = w0;
  tmp.height = h0;
  const tctx = tmp.getContext('2d')!;
  const td = tctx.createImageData(w0, h0);
  // Binary hair mask: 255 where class == HAIR, 0 elsewhere. RGB replicated
  // so shader can sample either channel; alpha 255 so canvas drawImage
  // upscale doesn't introduce alpha bleed.
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i] === HAIR_CLASS ? 255 : 0;
    td.data[i * 4] = v;
    td.data[i * 4 + 1] = v;
    td.data[i * 4 + 2] = v;
    td.data[i * 4 + 3] = 255;
  }
  tctx.putImageData(td, 0, 0);
  cat.close();

  // Upscale to photo native res so the shader can sample mask in photo-uv
  // without coordinate juggling. Bilinear smoothing softens the binary
  // category edge into a 1-2 px alpha gradient — exactly what we want for
  // the print to fade naturally into hair locks.
  const out = document.createElement('canvas');
  out.width = photo.naturalWidth;
  out.height = photo.naturalHeight;
  const octx = out.getContext('2d')!;
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(tmp, 0, 0, out.width, out.height);
  return out;
}

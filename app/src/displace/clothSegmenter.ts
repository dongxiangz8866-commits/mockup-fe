import { getSegmenter } from './hairSegmenter';

// Garment mask from the SAME MediaPipe Selfie Multiclass model hairSegmenter
// already loads. Output classes:
//   0=background 1=hair 2=body-skin 3=face-skin 4=clothes 5=accessories
// We consume class 4. Reusing the shared singleton means cloth + hair cost
// one model download total; only the segment() call is duplicated (cheap,
// model already resident on GPU) and the result is cached three-tier by
// useClothMask just like hair / depth.
//
// Failure-archive A note: a soft-threshold clothes mask used to destination-in
// CUT the print and dropped chunks on white-shirt-white-background. Route B
// DOES now clip the print to this mask (so it can't float off the garment),
// which is archive A's exact risk — mitigated by the morphological close
// below (seals interior speckle holes) plus a SOFT smoothstep clip in the
// shader (feathers, not steps) and a white mask-absent fallback (no clip,
// never worse than pre-clip). Still eyeball it via the 布料 debug view.

const CLOTHES_CLASS = 4;
// Morphological close radius (native 256²-ish mask space). Big enough to seal
// the speckle holes the selfie model punches into a white shirt, small enough
// not to swallow the neckline / sleeve gaps.
const CLOSE_R = 3;

// Topological hole-fill: anything unreached by a 4-connected flood from the
// image border in the BINARY 0-field is an interior speckle/shadow hole the
// segmenter punched into the cloth (chin-shadow misclassified as skin, small
// speckle, etc.). Morph-close caps at its kernel radius (CLOSE_R=3 ~12 px on
// a 1024 px photo) and misses wider holes — flood-fill is topology-based, no
// size limit, and CANNOT grow the outer silhouette (true background remains
// reachable from the border). Real interior cutouts that SHOULD stay 0 —
// neck triangle, armhole gaps, hair-strands-on-chest connected to head hair —
// are all border-reachable through the head/sides and stay 0.
function fillInteriorHoles(bin: Uint8Array, w: number, h: number): Uint8Array {
  const reach = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (i: number) => { if (bin[i] === 0 && !reach[i]) { reach[i] = 1; stack.push(i); } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (i >= w) push(i - w);
    if (i + w < w * h) push(i + w);
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < bin.length; i++) out[i] = bin[i] === 255 || !reach[i] ? 255 : 0;
  return out;
}

// Separable box morphology on a 0/255 single-channel buffer. dilate = take the
// neighborhood max, erode = the min. A close (dilate then erode) fills the
// interior holes the selfie segmenter leaves on a white shirt WITHOUT growing
// the outer silhouette, so the print can be alpha-clipped to this mask
// (failure-archive A's exact risk) without dropping chunks.
function boxMorph(src: Uint8Array, w: number, h: number, r: number, dilate: boolean): Uint8Array {
  const pick = dilate ? Math.max : Math.min;
  const mid = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = src[y * w + x];
      for (let d = 1; d <= r; d++) {
        if (x - d >= 0) v = pick(v, src[y * w + x - d]);
        if (x + d < w) v = pick(v, src[y * w + x + d]);
      }
      mid[y * w + x] = v;
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = mid[y * w + x];
      for (let d = 1; d <= r; d++) {
        if (y - d >= 0) v = pick(v, mid[(y - d) * w + x]);
        if (y + d < h) v = pick(v, mid[(y + d) * w + x]);
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

// Returns an L8-style RGBA canvas at photo native resolution where R=255
// means CLOTHES and R=0 means non-clothes. Three-tier caching lives in
// useClothMask; this function only does the inference step. Mirror of
// segmentHair so both stay in lockstep if the segmenter API changes.
export async function segmentClothes(photo: HTMLImageElement): Promise<HTMLCanvasElement> {
  let seg;
  try {
    seg = await getSegmenter();
  } catch (e) {
    console.warn('[cloth] first init threw, retrying once in 500ms:', e);
    await new Promise((r) => setTimeout(r, 500));
    seg = await getSegmenter();
  }

  const result = seg.segment(photo);
  const cat = result.categoryMask;
  if (!cat) throw new Error('cloth segmenter returned no category mask');

  const w0 = cat.width;
  const h0 = cat.height;
  const buf = cat.getAsUint8Array();
  cat.close();

  // Binary cloth field, then morphological close (smooths small noise at the
  // boundary) followed by topological hole-fill (seals ANY-size interior
  // shadow/speckle the close kernel can't bridge). Order matters: close first
  // softens the edge so the flood-fill doesn't grab boundary pinholes that
  // close would have sealed via dilation.
  const bin = new Uint8Array(w0 * h0);
  for (let i = 0; i < bin.length; i++) bin[i] = buf[i] === CLOTHES_CLASS ? 255 : 0;
  const closed = fillInteriorHoles(
    boxMorph(boxMorph(bin, w0, h0, CLOSE_R, true), w0, h0, CLOSE_R, false),
    w0, h0,
  );

  const tmp = document.createElement('canvas');
  tmp.width = w0;
  tmp.height = h0;
  const tctx = tmp.getContext('2d')!;
  const td = tctx.createImageData(w0, h0);
  for (let i = 0; i < closed.length; i++) {
    const v = closed[i];
    td.data[i * 4] = v;
    td.data[i * 4 + 1] = v;
    td.data[i * 4 + 2] = v;
    td.data[i * 4 + 3] = 255;
  }
  tctx.putImageData(td, 0, 0);

  // Upscale to photo native res; bilinear smoothing turns the binary
  // category edge into a 1-2 px gradient — exactly the soft gate we want so
  // the warp eases out at the garment boundary instead of stepping.
  const out = document.createElement('canvas');
  out.width = photo.naturalWidth;
  out.height = photo.naturalHeight;
  const octx = out.getContext('2d')!;
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(tmp, 0, 0, out.width, out.height);
  return out;
}

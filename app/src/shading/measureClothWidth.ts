// Measure garment (= cloth-mask) horizontal span at a chest-band Y.
// Used by /displace and /canvaskit to size the print to the SHIRT instead
// of to the shoulder landmarks, which underestimate oversized / loose tees.
//
// Mask convention (see useClothMask.ts): R channel = 255 means cloth,
// 0 = not cloth. Bilinear-upscaled to photo native resolution, so the
// sample coordinates are in photo pixels.

export function measureClothWidthAtRow(
  cloth: HTMLCanvasElement,
  yPx: number,
  bandHeightPx: number = 12,
): number {
  const ctx = cloth.getContext('2d', { willReadFrequently: true });
  if (!ctx) return 0;
  const w = cloth.width;
  const h = cloth.height;
  const startY = Math.max(0, Math.floor(yPx - bandHeightPx / 2));
  const endY = Math.min(h, Math.ceil(yPx + bandHeightPx / 2));
  if (endY <= startY) return 0;

  const data = ctx.getImageData(0, startY, w, endY - startY).data;
  let minX = w;
  let maxX = -1;
  const rows = endY - startY;
  // Single pass: leftmost + rightmost cloth=255 pixels across the band.
  // Sleeves are wider than torso when arms are spread, but at chest-band Y
  // (just below shoulders) hands are usually at the hips and arms hang
  // close to the torso — band reads as the torso silhouette.
  for (let y = 0; y < rows; y++) {
    const rowOffset = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (data[rowOffset + x * 4] > 128) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
  }
  if (maxX < 0 || maxX <= minX) return 0;
  return maxX - minX;
}

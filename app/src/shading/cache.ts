// Persist shading + highlight maps so a page reload doesn't pay the per-pixel
// ImageData cost again (~100-200 ms × 2 maps × N photos). Both maps are
// already heavy-blurred (5% radius + post-blur), so saving at HALF resolution
// loses no useful detail and quarters the localStorage bytes. Quality 0.6
// JPEG of half-res grayscale is typically 30-80 KB per map.
export function loadCachedMap(prefix: string, key: string): HTMLImageElement | null {
  try {
    const data = localStorage.getItem(prefix + key);
    if (!data) return null;
    const img = new Image();
    img.src = data;
    return img;
  } catch {
    return null;
  }
}

export function saveCachedMap(prefix: string, key: string, canvas: HTMLCanvasElement): void {
  try {
    const halfW = Math.max(1, Math.round(canvas.width / 2));
    const halfH = Math.max(1, Math.round(canvas.height / 2));
    const tmp = document.createElement('canvas');
    tmp.width = halfW;
    tmp.height = halfH;
    const tctx = tmp.getContext('2d')!;
    tctx.imageSmoothingEnabled = true;
    tctx.imageSmoothingQuality = 'high';
    tctx.drawImage(canvas, 0, 0, halfW, halfH);
    const data = tmp.toDataURL('image/jpeg', 0.6);
    localStorage.setItem(prefix + key, data);
  } catch {
    // quota — ignore (next reload will rebuild)
  }
}

// Decode a localStorage map image (saved at half-res) onto a fresh canvas at
// full photo resolution. drawImage's bilinear upscale is fine — the maps are
// already smooth so no detail to lose.
export async function decodeCachedMap(
  cached: HTMLImageElement,
  w: number,
  h: number
): Promise<HTMLCanvasElement> {
  await new Promise<void>((res) => {
    if (cached.complete) res();
    else cached.onload = () => res();
  });
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d')!.drawImage(cached, 0, 0, w, h);
  return c;
}

// Fabric texture map: high-frequency luminance content of the photo, encoded
// around byte 128 (overlay/hard-light identity). Built from a small-radius
// blur (~0.2% of min dim, capturing weave/grain frequencies) so the result
// is the "shirt's microstructure" — fabric weave, sensor grain, lighting
// micro-patterns. Applied as an overlay-blend pass within pattern alpha at
// low alpha (preset.fabricMul × foldStrength), it transfers the shirt's
// surface character onto the pattern. Without this, the pattern reads as
// "smooth printed surface" against the shirt's textured surface — a key
// sticker-cue.
export function buildFabricTexture(photo: HTMLImageElement): HTMLCanvasElement {
  const w = photo.naturalWidth;
  const h = photo.naturalHeight;
  const blurRadius = Math.max(2, Math.round(Math.min(w, h) * 0.002));
  const blurC = document.createElement('canvas');
  blurC.width = w;
  blurC.height = h;
  const blurCtx = blurC.getContext('2d')!;
  blurCtx.filter = `blur(${blurRadius}px)`;
  blurCtx.drawImage(photo, 0, 0);
  const origC = document.createElement('canvas');
  origC.width = w;
  origC.height = h;
  const origCtx = origC.getContext('2d')!;
  origCtx.drawImage(photo, 0, 0);
  const O = origCtx.getImageData(0, 0, w, h);
  const B = blurCtx.getImageData(0, 0, w, h);
  const out = origCtx.createImageData(w, h);
  const Od = O.data;
  const Bd = B.data;
  const Dd = out.data;
  for (let i = 0; i < Od.length; i += 4) {
    const lO = Od[i] * 0.299 + Od[i + 1] * 0.587 + Od[i + 2] * 0.114;
    const lB = Bd[i] * 0.299 + Bd[i + 1] * 0.587 + Bd[i + 2] * 0.114;
    // Amplify slightly (×1.5) so the high-freq content survives the low-alpha
    // overlay blend and ×0.5 dampening from JPEG cache compression.
    const v = Math.max(0, Math.min(255, 128 + (lO - lB) * 1.5));
    Dd[i] = v;
    Dd[i + 1] = v;
    Dd[i + 2] = v;
    Dd[i + 3] = 255;
  }
  origCtx.putImageData(out, 0, 0);
  return origC;
}

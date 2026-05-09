import { lerpPt, type GarmentSample, type Quad, type ShirtClass } from './types';

// Sample shirt fabric color from two narrow strips at the top and bottom of
// the print quad. Centered prints virtually never reach those V extents, so
// the strips are reliably "shirt only" without depending on the pattern's
// runtime alpha. Returns mean RGB + lumP5/lumP95 for downstream blend.
export function sampleGarment(photo: HTMLImageElement, quad: Quad): GarmentSample {
  const w = photo.naturalWidth;
  const h = photo.naturalHeight;
  const off = document.createElement('canvas');
  off.width = w;
  off.height = h;
  off.getContext('2d')!.drawImage(photo, 0, 0);
  const mask = document.createElement('canvas');
  mask.width = w;
  mask.height = h;
  const mctx = mask.getContext('2d')!;
  mctx.fillStyle = '#fff';
  for (const [vs, ve] of [
    [0.0, 0.12],
    [0.88, 1.0],
  ]) {
    const a = lerpPt(quad.tl, quad.bl, vs);
    const b = lerpPt(quad.tr, quad.br, vs);
    const c = lerpPt(quad.tr, quad.br, ve);
    const d = lerpPt(quad.tl, quad.bl, ve);
    mctx.beginPath();
    mctx.moveTo(a.x, a.y);
    mctx.lineTo(b.x, b.y);
    mctx.lineTo(c.x, c.y);
    mctx.lineTo(d.x, d.y);
    mctx.closePath();
    mctx.fill();
  }
  const pData = off.getContext('2d')!.getImageData(0, 0, w, h).data;
  const mData = mctx.getImageData(0, 0, w, h).data;
  const lums: number[] = [];
  let sR = 0;
  let sG = 0;
  let sB = 0;
  let n = 0;
  for (let i = 0; i < mData.length; i += 4) {
    if (mData[i + 3] === 0) continue;
    const r = pData[i];
    const g = pData[i + 1];
    const b = pData[i + 2];
    sR += r;
    sG += g;
    sB += b;
    n++;
    lums.push(r * 0.299 + g * 0.587 + b * 0.114);
  }
  if (n === 0) return { rgb: [200, 200, 200], lumP5: 60, lumP95: 230 };
  lums.sort((a, b) => a - b);
  return {
    rgb: [sR / n, sG / n, sB / n],
    lumP5: lums[Math.floor(lums.length * 0.05)],
    lumP95: lums[Math.floor(lums.length * 0.95)],
  };
}

// Route a sampled GarmentSample to one of three shirt classes:
//   • white : bright + low saturation
//   • black : dark (lumP95 < 90), regardless of hue (covers true black, deep
//             green, navy, deep red, deep purple, etc. — all need the same
//             lift / mild-fold treatment to keep dark pattern interior visible)
//   • color : everything else (mid-tone colored shirts)
//
// The earlier `lumP95<70 && sat<0.25` rule misclassified pure black (sat≈0.36
// from byte quantisation noise) AND deep colored shirts (sat>0.25 by design),
// pushing both to 'color' → pattern dark interior crushed and visible as a
// smudge. The current thresholds are observed inflection points across the
// project's photo set.
export function classifyShirt(g: GarmentSample): ShirtClass {
  const [r, gr, b] = g.rgb;
  const max = Math.max(r, gr, b);
  const min = Math.min(r, gr, b);
  const sat = max > 0 ? (max - min) / max : 0;
  let key: ShirtClass;
  if (g.lumP95 > 200 && sat < 0.10) key = 'white';
  else if (g.lumP95 < 90) key = 'black';
  else key = 'color';
  if (import.meta.env.DEV) {
    console.log(`[classify] rgb=(${r.toFixed(0)},${gr.toFixed(0)},${b.toFixed(0)}) lumP5=${g.lumP5.toFixed(0)} lumP95=${g.lumP95.toFixed(0)} sat=${sat.toFixed(2)} → ${key}`);
  }
  return key;
}

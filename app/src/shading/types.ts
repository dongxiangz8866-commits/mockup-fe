export type Pt = { x: number; y: number };
export type Quad = { tl: Pt; tr: Pt; br: Pt; bl: Pt };

export function lerpPt(a: Pt, b: Pt, t: number): Pt {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export type ShirtClass = 'white' | 'black' | 'color';

export type GarmentSample = {
  rgb: [number, number, number];
  lumP5: number;
  lumP95: number;
};

export type ShadingInput = HTMLImageElement | HTMLCanvasElement;

export function shadingInputDims(s: ShadingInput): { w: number; h: number } {
  return s instanceof HTMLImageElement
    ? { w: s.naturalWidth, h: s.naturalHeight }
    : { w: s.width, h: s.height };
}

import type { Quad } from '../shading';

// DENSE DEPTH-MESH warp (CanvasKit). Forward port of displaceShader.vert in
// FULL — same operators as /displace, evaluated on the CPU per vertex so
// CanvasKit's drawVertices can rasterize the warped pattern:
//
//   • macro radial depth-drop (torso-cylinder wrap)
//   • smooth-field-into-z (default ON — the project-confirmed fold source;
//     DAv2 fine depth was the dead-signal first cut, do not reintroduce)
//   • SHADING_DROP local fold compression (cloth-chroma gated, p10/p90 norm)
//   • FOLD_GRAD ∇shading fold-direction push
//
// Light/tint/lift/occlusion are per-pixel and live in the SkSL pass-2
// composite (matches the frag, which samples uLight per fragment). This
// builder only outputs warped geometry; no per-vertex colors.
//
// Sealed rules honored: depth-driven; warp never modulated by a non-smooth
// signal (cloth-chroma only GATES the shading term's amplitude exactly as
// the proven shader does; cloth MASK clips alpha later, never a vertex).

const SHADING_DROP_AMP_PX = 10.0;
const SHADING_DROP_NOISE = 0.05;
const SHADING_DROP_FLOOR = 0.2;
const FOLD_GRAD_TAP = 15.0;
const FOLD_GRAD_AMP_PX = 25.0;

export type Channel = { data: Uint8ClampedArray; w: number; h: number };

export type MeshArgs = {
  quad: Quad;
  photoW: number;
  photoH: number;
  macro: Channel;
  smooth: Channel;
  shading: Channel;
  photo: Channel;
  patternW: number;
  patternH: number;
  patternAspect: number;
  printCenterUV: [number, number];
  zCenter: number;
  smoothCenter: number;
  garmentRGB: [number, number, number];
  shadingP10: number;
  shadingP90: number;
  segments: number;
  depthWrap: number;
  strength: number;
  dispSign: number;
  smoothWarp: number;
  wrinkleStrength: number;
};

export type Mesh = {
  positions: Float32Array; // photo px, 2/vertex
  texcoords: Float32Array; // pattern image px, 2/vertex
  indices: number[];
};

type V2 = { x: number; y: number };

// Bilinear sample of one byte channel (offset 0=R … 2=B) → 0..1, clamped.
function samp(c: Channel, px: number, py: number, o = 0): number {
  const x = Math.max(0, Math.min(c.w - 1.001, px));
  const y = Math.max(0, Math.min(c.h - 1.001, py));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const at = (gx: number, gy: number) => c.data[(gy * c.w + gx) * 4 + o];
  const t = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * fx;
  const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * fx;
  return (t + (b - t) * fy) / 255;
}

function mix(a: V2, b: V2, t: number): V2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function quadPoint(q: Quad, u: number, v: number): V2 {
  return mix(mix(q.tl, q.tr, u), mix(q.bl, q.br, u), v);
}

function affineInvUV(p: V2, tl: V2, tr: V2, bl: V2): V2 {
  const exx = tr.x - tl.x;
  const exy = tr.y - tl.y;
  const eyx = bl.x - tl.x;
  const eyy = bl.y - tl.y;
  const dx = p.x - tl.x;
  const dy = p.y - tl.y;
  const det = exx * eyy - exy * eyx;
  return { x: (dx * eyy - dy * eyx) / det, y: (-dx * exy + dy * exx) / det };
}

function containRemap(qx: number, qy: number, qa: number, pa: number): [number, number] {
  const bw = pa >= qa ? qa : pa;
  const bh = pa >= qa ? qa / pa : 1;
  return [(qx * qa - (qa - bw) / 2) / bw, (qy - (1 - bh) / 2) / bh];
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / Math.max(e1 - e0, 1e-6)));
  return t * t * (3 - 2 * t);
}

// SHADING_DROP + FOLD_GRAD, verbatim from displaceShader.vert 133-176.
// Returns the px-space (dx,dy) added to the warped UV by the fold terms.
function foldPush(a: MeshArgs, P: V2, fcx: number, fcy: number): [number, number] {
  const inv = 1 / Math.max(a.shadingP90 - a.shadingP10, 0.01);
  const sN = (px: number, py: number) =>
    Math.max(0, Math.min(1, (samp(a.shading, px, py) - a.shadingP10) * inv));
  const fpr = samp(a.photo, P.x, P.y, 0);
  const fpg = samp(a.photo, P.x, P.y, 1);
  const fpb = samp(a.photo, P.x, P.y, 2);
  const fpMax = Math.max(fpr, fpg, fpb, 1 / 255);
  const gMax = Math.max(a.garmentRGB[0], a.garmentRGB[1], a.garmentRGB[2], 1 / 255);
  const dcr = fpr / fpMax - a.garmentRGB[0] / gMax;
  const dcg = fpg / fpMax - a.garmentRGB[1] / gMax;
  const dcb = fpb / fpMax - a.garmentRGB[2] / gMax;
  const clothFold = 1 - smoothstep(0.2, 0.55, Math.hypot(dcr, dcg, dcb));
  const drop = (1 - sN(P.x, P.y)) * clothFold;
  const fStr = smoothstep(SHADING_DROP_NOISE, SHADING_DROP_FLOOR, drop);
  const fcLen = Math.hypot(fcx, fcy);
  const k = a.wrinkleStrength * a.strength * a.dispSign;
  let dx = (fcLen > 1e-4 ? fcx / fcLen : 0) * fStr * SHADING_DROP_AMP_PX * k;
  let dy = (fcLen > 1e-4 ? fcy / fcLen : 0) * fStr * SHADING_DROP_AMP_PX * k;
  const gx = (sN(P.x + FOLD_GRAD_TAP, P.y) - sN(P.x - FOLD_GRAD_TAP, P.y)) * clothFold;
  const gy = (sN(P.x, P.y + FOLD_GRAD_TAP) - sN(P.x, P.y - FOLD_GRAD_TAP)) * clothFold;
  dx += gx * FOLD_GRAD_AMP_PX * k;
  dy += gy * FOLD_GRAD_AMP_PX * k;
  return [dx, dy];
}

export function buildMesh(a: MeshArgs): Mesh {
  const N = a.segments;
  const vCount = (N + 1) * (N + 1);
  const positions = new Float32Array(vCount * 2);
  const texcoords = new Float32Array(vCount * 2);
  const indices: number[] = [];

  const tlUV: V2 = { x: a.quad.tl.x / a.photoW, y: a.quad.tl.y / a.photoH };
  const trUV: V2 = { x: a.quad.tr.x / a.photoW, y: a.quad.tr.y / a.photoH };
  const blUV: V2 = { x: a.quad.bl.x / a.photoW, y: a.quad.bl.y / a.photoH };
  const qW = Math.hypot(a.quad.tr.x - a.quad.tl.x, a.quad.tr.y - a.quad.tl.y);
  const qH = Math.hypot(a.quad.bl.x - a.quad.tl.x, a.quad.bl.y - a.quad.tl.y);
  const quadAspect = qW / Math.max(qH, 1e-4);
  const [pcx, pcy] = a.printCenterUV;
  const zCenterEff = a.zCenter + a.smoothWarp * a.smoothCenter;
  const wsActive = a.wrinkleStrength > 0;

  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      const k = j * (N + 1) + i;
      const P = quadPoint(a.quad, i / N, j / N);
      const pux = P.x / a.photoW;
      const puy = P.y / a.photoH;

      const zHere =
        samp(a.macro, P.x, P.y) + a.smoothWarp * samp(a.smooth, P.x, P.y);
      const drop = Math.max(
        0,
        Math.min(1, (zCenterEff - zHere) / Math.max(zCenterEff, 0.01))
      );
      const grow = 1 + drop * a.depthWrap * a.strength * a.dispSign;
      const fcx = pux - pcx;
      const fcy = puy - pcy;
      let wx = pcx + fcx * grow;
      let wy = pcy + fcy * grow;

      if (wsActive) {
        const [dx, dy] = foldPush(a, P, fcx, fcy);
        wx += dx / a.photoW;
        wy += dy / a.photoH;
      }

      const q = affineInvUV({ x: wx, y: wy }, tlUV, trUV, blUV);
      const [pu, pv] = containRemap(q.x, q.y, quadAspect, a.patternAspect);
      positions[k * 2] = P.x;
      positions[k * 2 + 1] = P.y;
      texcoords[k * 2] = pu * a.patternW;
      texcoords[k * 2 + 1] = pv * a.patternH;
    }
  }

  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a0 = j * (N + 1) + i;
      const b0 = a0 + 1;
      const c0 = a0 + (N + 1);
      indices.push(a0, b0, c0, b0, c0 + 1, c0);
    }
  }

  return { positions, texcoords, indices };
}

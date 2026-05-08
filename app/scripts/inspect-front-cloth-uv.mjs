// Standalone GLB UV inspector. No deps — parses GLB binary by hand.
// Run: node app/scripts/inspect-front-cloth-uv.mjs
import fs from 'node:fs';
import path from 'node:path';

const GLB = path.resolve(
  process.cwd(),
  'app/public/mock-models/glb-no-model/霞湖世家男T-001.glb'
);

const buf = fs.readFileSync(GLB);
if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB');
const totalLen = buf.readUInt32LE(8);

let off = 12;
let json = null;
let bin = null;
while (off < totalLen) {
  const len = buf.readUInt32LE(off);
  const type = buf.subarray(off + 4, off + 8).toString('ascii');
  const data = buf.subarray(off + 8, off + 8 + len);
  if (type === 'JSON') json = JSON.parse(data.toString('utf8'));
  else if (type.startsWith('BIN')) bin = data;
  off += 8 + len;
}
if (!json || !bin) throw new Error('missing JSON/BIN chunks');

function readAccessorVec(acc, dim) {
  const bv = json.bufferViews[acc.bufferView];
  const stride = bv.byteStride ?? dim * 4;
  const start = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const out = new Array(acc.count);
  for (let i = 0; i < acc.count; i++) {
    const o = start + i * stride;
    const v = new Array(dim);
    for (let d = 0; d < dim; d++) v[d] = bin.readFloatLE(o + d * 4);
    out[i] = v;
  }
  return out;
}

const meshIdx = json.meshes.findIndex(
  (m) => m.name === 'ClothPiece_Fabric_0_ClothPiece_3_1'
);
const mesh = json.meshes[meshIdx];
const prim = mesh.primitives[0];
const POS = readAccessorVec(json.accessors[prim.attributes.POSITION], 3);
const UV = readAccessorVec(json.accessors[prim.attributes.TEXCOORD_0], 2);

console.log(`front cloth: ${POS.length} verts`);
const accUV = json.accessors[prim.attributes.TEXCOORD_0];
const accP = json.accessors[prim.attributes.POSITION];
console.log(`  UV  range U=${accUV.min[0].toFixed(3)}..${accUV.max[0].toFixed(3)}  V=${accUV.min[1].toFixed(3)}..${accUV.max[1].toFixed(3)}`);
console.log(`  POS range X=${accP.min[0].toFixed(1)}..${accP.max[0].toFixed(1)}  Y=${accP.min[1].toFixed(1)}..${accP.max[1].toFixed(1)}  Z=${accP.min[2].toFixed(1)}..${accP.max[2].toFixed(1)}`);

// 1) Find vertices at the U-center, sorted by V — to see how the cloth's
//    centerline (front midseam) maps from UV-V to world-Y. Reveals where
//    cloth-top-V actually sits on the body (shoulder seam vs neckband tip).
const uCenter = (accUV.min[0] + accUV.max[0]) / 2;
const centerLane = [];
for (let i = 0; i < UV.length; i++) {
  const [u, v] = UV[i];
  if (Math.abs(u - uCenter) < 0.15) centerLane.push({ i, u, v, p: POS[i] });
}
centerLane.sort((a, b) => b.v - a.v); // descending V (cloth top first since GLB V flipped)
console.log(`\n中线带 (|U - ${uCenter.toFixed(2)}| < 0.15)，按 V 从大到小（即从布顶到布底）抽样:`);
const STEPS = 12;
for (let s = 0; s <= STEPS; s++) {
  const k = Math.min(centerLane.length - 1, Math.round((s / STEPS) * (centerLane.length - 1)));
  const r = centerLane[k];
  const fracV = (accUV.max[1] - r.v) / (accUV.max[1] - accUV.min[1]); // 0=top, 1=bottom
  const Yfrac = (accP.max[1] - r.p[1]) / (accP.max[1] - accP.min[1]);
  console.log(
    `  V=${r.v.toFixed(3)}  → frac(V from top)=${(fracV * 100).toFixed(1)}%   ` +
      `world(X,Y,Z)=(${r.p[0].toFixed(1)}, ${r.p[1].toFixed(1)}, ${r.p[2].toFixed(1)})  ` +
      `Y from top=${(Yfrac * 100).toFixed(1)}%`
  );
}

// 2) Per-triangle UV vs cm-area ratio, to detect non-uniform UV stretching.
//    Random sample of triangles; report mean ± stdev of (cm² per UV²).
const indicesAcc = json.accessors[prim.indices];
const ibv = json.bufferViews[indicesAcc.bufferView];
const istart = (ibv.byteOffset ?? 0) + (indicesAcc.byteOffset ?? 0);
const ctype = indicesAcc.componentType; // 5123 ushort, 5125 uint
const itemSize = ctype === 5125 ? 4 : 2;
const triCount = indicesAcc.count / 3;
const tris = [];
for (let t = 0; t < triCount; t++) {
  const o = istart + t * 3 * itemSize;
  const a = ctype === 5125 ? bin.readUInt32LE(o) : bin.readUInt16LE(o);
  const b = ctype === 5125 ? bin.readUInt32LE(o + itemSize) : bin.readUInt16LE(o + itemSize);
  const c = ctype === 5125 ? bin.readUInt32LE(o + 2 * itemSize) : bin.readUInt16LE(o + 2 * itemSize);
  tris.push([a, b, c]);
}
function cross3(u, v) {
  return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
}
function len3(v) {
  return Math.hypot(v[0], v[1], v[2]);
}
const ratios = [];
for (const [a, b, c] of tris) {
  const pa = POS[a], pb = POS[b], pc = POS[c];
  const ab = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
  const ac = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
  const area3d = 0.5 * len3(cross3(ab, ac)); // mm²
  const ua = UV[a], ub = UV[b], uc = UV[c];
  const dub = [ub[0] - ua[0], ub[1] - ua[1]];
  const duc = [uc[0] - ua[0], uc[1] - ua[1]];
  const areaUV = 0.5 * Math.abs(dub[0] * duc[1] - dub[1] * duc[0]);
  if (areaUV < 1e-8 || area3d < 1e-4) continue;
  ratios.push(area3d / areaUV); // mm² per UV²
}
ratios.sort((x, y) => x - y);
const mean = ratios.reduce((s, x) => s + x, 0) / ratios.length;
const median = ratios[Math.floor(ratios.length / 2)];
const p10 = ratios[Math.floor(ratios.length * 0.1)];
const p90 = ratios[Math.floor(ratios.length * 0.9)];
console.log(`\n每三角形面积比 (mm² per UV²): n=${ratios.length}`);
console.log(`  median=${median.toFixed(1)}  mean=${mean.toFixed(1)}  p10=${p10.toFixed(1)}  p90=${p90.toFixed(1)}  p90/p10=${(p90 / p10).toFixed(2)}`);
console.log(`  → if p90/p10 ≈ 1，UV 是均匀展开；远大于 1 表示 UV 在不同区域被不同程度拉伸`);

// 3) Check anisotropy: per-triangle (du, dv) → 3D edge lengths.
//    For each triangle, compute |edge|/|UV-edge| separately for U-direction
//    and V-direction edges, to detect U/V axis stretch differences.
const ratiosU = [];
const ratiosV = [];
for (const [a, b, c] of tris) {
  const pairs = [[a, b], [b, c], [c, a]];
  for (const [i, j] of pairs) {
    const dp = [POS[j][0] - POS[i][0], POS[j][1] - POS[i][1], POS[j][2] - POS[i][2]];
    const du = UV[j][0] - UV[i][0];
    const dv = UV[j][1] - UV[i][1];
    const lp = len3(dp); // mm
    if (lp < 1e-3) continue;
    if (Math.abs(du) > 4 * Math.abs(dv) && Math.abs(du) > 1e-4) {
      ratiosU.push(lp / Math.abs(du));
    } else if (Math.abs(dv) > 4 * Math.abs(du) && Math.abs(dv) > 1e-4) {
      ratiosV.push(lp / Math.abs(dv));
    }
  }
}
const med = (a) => { a.sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
console.log(`\n各向异性 (mm per UV unit):`);
console.log(`  U 方向边 (n=${ratiosU.length}): median=${med(ratiosU).toFixed(1)}`);
console.log(`  V 方向边 (n=${ratiosV.length}): median=${med(ratiosV).toFixed(1)}`);
console.log(`  → 二者比值 ≈ ${(med(ratiosU) / med(ratiosV)).toFixed(3)}`);
console.log(`  → 若 ≈ 1，UV 各向同性；远离 1 = UV 把一个方向"压扁"了，纹理在那个方向会被拉/压`);

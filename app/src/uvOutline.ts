import { GLTFLoader } from 'three-stdlib';
import * as THREE from 'three';

export type UvBounds = {
  minU: number;
  maxU: number;
  minV: number;
  maxV: number;
};

export type UvIsland = {
  pathD: string;
  uvBounds: UvBounds;
  vertexCount: number;
};

export type UvOutline = {
  pathD: string;
  uvBounds: UvBounds;
  islands: UvIsland[];
};

type EdgeData = {
  count: number;
  u1: number;
  v1: number;
  u2: number;
  v2: number;
  root: number;
};

const cache = new Map<string, Promise<UvOutline>>();

const fmt = (n: number) => n.toFixed(6);
const segOf = (e: EdgeData) =>
  `M${e.u1.toFixed(5)} ${e.v1.toFixed(5)}L${e.u2.toFixed(5)} ${e.v2.toFixed(5)}`;

function filterToLargestEdgeComponent(edges: EdgeData[]): EdgeData[] {
  if (edges.length <= 1) return edges;
  const vertToEdges = new Map<string, number[]>();
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    const k1 = `${fmt(e.u1)},${fmt(e.v1)}`;
    const k2 = `${fmt(e.u2)},${fmt(e.v2)}`;
    let l1 = vertToEdges.get(k1);
    if (!l1) {
      l1 = [];
      vertToEdges.set(k1, l1);
    }
    l1.push(i);
    let l2 = vertToEdges.get(k2);
    if (!l2) {
      l2 = [];
      vertToEdges.set(k2, l2);
    }
    l2.push(i);
  }
  const parent = new Int32Array(edges.length);
  for (let i = 0; i < edges.length; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (const idxs of vertToEdges.values()) {
    for (let i = 1; i < idxs.length; i++) union(idxs[0], idxs[i]);
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < edges.length; i++) {
    const r = find(i);
    let g = groups.get(r);
    if (!g) {
      g = [];
      groups.set(r, g);
    }
    g.push(i);
  }
  let largest: number[] | null = null;
  for (const g of groups.values()) {
    if (!largest || g.length > largest.length) largest = g;
  }
  return largest ? largest.map((i) => edges[i]) : edges;
}

export function loadUvOutline(url: string): Promise<UvOutline> {
  const cached = cache.get(url);
  if (cached) return cached;

  const promise = (async () => {
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(url);
    let mesh: THREE.Mesh | null = null;
    gltf.scene.traverse((o: THREE.Object3D) => {
      if (!mesh && (o as THREE.Mesh).isMesh) mesh = o as THREE.Mesh;
    });
    if (!mesh) throw new Error('UV outline: no mesh');
    const geom = (mesh as THREE.Mesh).geometry;
    const uv = geom.attributes.uv;
    const index = geom.index;
    if (!uv || !index) throw new Error('UV outline: missing uv or index');

    const posToId = new Map<string, number>();
    const getPosId = (u: number, v: number) => {
      const k = `${fmt(u)},${fmt(v)}`;
      let id = posToId.get(k);
      if (id === undefined) {
        id = posToId.size;
        posToId.set(k, id);
      }
      return id;
    };

    const vertCount = uv.count;
    const vertPosId = new Int32Array(vertCount);
    for (let i = 0; i < vertCount; i++) {
      vertPosId[i] = getPosId(uv.getX(i), uv.getY(i));
    }

    const N = posToId.size;
    const parent = new Int32Array(N);
    for (let i = 0; i < N; i++) parent[i] = i;
    const find = (x: number): number => {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]];
        x = parent[x];
      }
      return x;
    };
    const union = (a: number, b: number) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    };

    for (let f = 0; f < index.count; f += 3) {
      const a = vertPosId[index.getX(f)];
      const b = vertPosId[index.getX(f + 1)];
      const c = vertPosId[index.getX(f + 2)];
      union(a, b);
      union(b, c);
    }

    const edges = new Map<string, EdgeData>();
    const addEdge = (i: number, j: number) => {
      const u1 = uv.getX(i);
      const v1 = uv.getY(i);
      const u2 = uv.getX(j);
      const v2 = uv.getY(j);
      const swap = u1 > u2 || (u1 === u2 && v1 > v2);
      const ka0 = swap ? u2 : u1;
      const ka1 = swap ? v2 : v1;
      const kb0 = swap ? u1 : u2;
      const kb1 = swap ? v1 : v2;
      const key = `${fmt(ka0)},${fmt(ka1)}|${fmt(kb0)},${fmt(kb1)}`;
      const existing = edges.get(key);
      if (existing) {
        existing.count++;
      } else {
        edges.set(key, {
          count: 1,
          u1: ka0,
          v1: ka1,
          u2: kb0,
          v2: kb1,
          root: find(vertPosId[i]),
        });
      }
    };

    for (let f = 0; f < index.count; f += 3) {
      const a = index.getX(f);
      const b = index.getX(f + 1);
      const c = index.getX(f + 2);
      addEdge(a, b);
      addEdge(b, c);
      addEdge(c, a);
    }

    const islandEdges = new Map<number, EdgeData[]>();
    for (const e of edges.values()) {
      if (e.count !== 1) continue;
      let arr = islandEdges.get(e.root);
      if (!arr) {
        arr = [];
        islandEdges.set(e.root, arr);
      }
      arr.push(e);
    }

    const vertexCountByRoot = new Map<number, number>();
    for (let i = 0; i < vertCount; i++) {
      const r = find(vertPosId[i]);
      vertexCountByRoot.set(r, (vertexCountByRoot.get(r) || 0) + 1);
    }

    const islands: UvIsland[] = [];
    let allMinU = Infinity;
    let allMaxU = -Infinity;
    let allMinV = Infinity;
    let allMaxV = -Infinity;
    const allParts: string[] = [];

    for (const [root, rawEdges] of islandEdges.entries()) {
      const filtered = filterToLargestEdgeComponent(rawEdges);
      let minU = Infinity;
      let maxU = -Infinity;
      let minV = Infinity;
      let maxV = -Infinity;
      const parts: string[] = [];
      for (const e of filtered) {
        parts.push(segOf(e));
        if (e.u1 < minU) minU = e.u1;
        if (e.u1 > maxU) maxU = e.u1;
        if (e.u2 < minU) minU = e.u2;
        if (e.u2 > maxU) maxU = e.u2;
        if (e.v1 < minV) minV = e.v1;
        if (e.v1 > maxV) maxV = e.v1;
        if (e.v2 < minV) minV = e.v2;
        if (e.v2 > maxV) maxV = e.v2;
      }
      if (minU < allMinU) allMinU = minU;
      if (maxU > allMaxU) allMaxU = maxU;
      if (minV < allMinV) allMinV = minV;
      if (maxV > allMaxV) allMaxV = maxV;
      allParts.push(...parts);
      islands.push({
        pathD: parts.join(''),
        uvBounds: { minU, maxU, minV, maxV },
        vertexCount: vertexCountByRoot.get(root) || 0,
      });
    }
    islands.sort((a, b) => b.vertexCount - a.vertexCount);

    return {
      pathD: allParts.join(''),
      uvBounds: {
        minU: allMinU,
        maxU: allMaxU,
        minV: allMinV,
        maxV: allMaxV,
      },
      islands,
    };
  })();

  cache.set(url, promise);
  return promise;
}

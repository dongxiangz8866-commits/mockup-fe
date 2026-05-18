// Module-level perf event store. Same pub-sub idiom as textureStore: stages
// live in many places (DisplacePage load effect, useDepthMap, useHairMask,
// the in-Canvas render probe) so a single shared sink + rAF-coalesced
// notification beats threading a collector prop through every hook.

export type StageName = 'load' | 'pose' | 'maps' | 'depth' | 'hair' | 'cloth';
export type CacheSource = 'compute' | 'mem' | 'localStorage';

export type StageRec = { ms: number; source: CacheSource };

export type PerfSnapshot = {
  parseStart: number | null;
  stages: Partial<Record<StageName, StageRec>>;
  printMs: number | null;
  render: { textures: number; geometries: number; programs: number } | null;
};

const STAGE_ORDER: StageName[] = ['load', 'pose', 'maps', 'depth', 'hair', 'cloth'];

let snapshot: PerfSnapshot = {
  parseStart: null,
  stages: {},
  printMs: null,
  render: null,
};

const subscribers = new Set<() => void>();
let notifyScheduled = false;

function notify(): void {
  if (notifyScheduled) return;
  notifyScheduled = true;
  requestAnimationFrame(() => {
    notifyScheduled = false;
    subscribers.forEach((cb) => cb());
  });
}

export function resetParse(startTs: number): void {
  snapshot = { parseStart: startTs, stages: {}, printMs: null, render: snapshot.render };
  notify();
}

export function recordStage(name: StageName, ms: number, source: CacheSource): void {
  snapshot = { ...snapshot, stages: { ...snapshot.stages, [name]: { ms, source } } };
  notify();
}

export function recordPrint(ms: number): void {
  snapshot = { ...snapshot, printMs: ms };
  notify();
}

export function recordRender(info: { textures: number; geometries: number; programs: number }): void {
  snapshot = { ...snapshot, render: info };
  notify();
}

export function getSnapshot(): PerfSnapshot {
  return snapshot;
}

// Wall-clock parse total: parseStart → the latest finishing stage. Stages
// run partly in parallel (depth/hair are independent hooks), so the sum of
// rows ≠ wall time; this returns the real perceived "解析模特图" duration.
export function parseTotalMs(snap: PerfSnapshot): number | null {
  if (snap.parseStart == null) return null;
  const done = STAGE_ORDER.filter((s) => snap.stages[s]);
  if (done.length === 0) return null;
  // Each stage records its own duration; the pipeline is sequential for
  // load→pose→maps and parallel for depth/hair. Upper bound that matches
  // what the user feels: max(sequential chain, slowest parallel branch).
  const seq =
    (snap.stages.load?.ms ?? 0) + (snap.stages.pose?.ms ?? 0) + (snap.stages.maps?.ms ?? 0);
  const par = Math.max(snap.stages.depth?.ms ?? 0, snap.stages.hair?.ms ?? 0);
  return Math.max(seq, par);
}

export function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

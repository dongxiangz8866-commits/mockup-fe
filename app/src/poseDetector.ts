import { PoseLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

const WASM_BASE =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

export type PoseLandmark = { x: number; y: number; z: number; visibility?: number };

let landmarkerPromise: Promise<PoseLandmarker> | null = null;

// Lazy singleton with rejection reset. The naive `if (p) return p` form
// CACHES failures: one CDN hiccup → p becomes a permanently-rejected
// promise → every subsequent caller awaits the same rejection until full
// page reload. Clearing the slot in .catch lets the next call retry from
// scratch.
function getLandmarker(): Promise<PoseLandmarker> {
  if (landmarkerPromise) return landmarkerPromise;
  const p = (async () => {
    const vision = await FilesetResolver.forVisionTasks(WASM_BASE);
    return PoseLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
      runningMode: 'IMAGE',
      numPoses: 4,
    });
  })();
  p.catch(() => {
    if (landmarkerPromise === p) landmarkerPromise = null;
  });
  landmarkerPromise = p;
  return p;
}

export async function detectPose(
  img: HTMLImageElement
): Promise<PoseLandmark[] | null> {
  const lm = await getLandmarker();
  const result = lm.detect(img);
  if (!result.landmarks || result.landmarks.length === 0) return null;
  return selectPrimaryPose(result.landmarks as PoseLandmark[][], img);
}

const POSE_CACHE_PREFIX = 'pose-cache:v2:';

export function readCachedPose(key: string): PoseLandmark[] | null {
  try {
    const raw = localStorage.getItem(POSE_CACHE_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed as PoseLandmark[];
  } catch {
    return null;
  }
}

export function writeCachedPose(key: string, lm: PoseLandmark[]): void {
  try {
    localStorage.setItem(POSE_CACHE_PREFIX + key, JSON.stringify(lm));
  } catch {
    // quota exceeded — ignore
  }
}

export async function detectPoseCached(
  img: HTMLImageElement,
  key: string
): Promise<PoseLandmark[] | null> {
  const cached = readCachedPose(key);
  if (cached) return cached;
  // One automatic retry: the FIRST detectPose call after a fresh page-load
  // is the one most likely to hit a flaky CDN load. With getLandmarker's
  // rejection-reset, the second attempt re-inits cleanly. Only retry on
  // throw — null returns (no person in photo) are deterministic, no point
  // retrying those.
  let lm: PoseLandmark[] | null = null;
  try {
    lm = await detectPose(img);
  } catch (e) {
    console.warn('[pose] first attempt threw, retrying once in 500ms:', e);
    await new Promise((r) => setTimeout(r, 500));
    lm = await detectPose(img);
  }
  if (lm) writeCachedPose(key, lm);
  return lm;
}

export const POSE_INDEX = {
  nose: 0,
  leftShoulder: 11,
  rightShoulder: 12,
  leftHip: 23,
  rightHip: 24,
} as const;

function visibility(lm: PoseLandmark | undefined): number {
  return lm?.visibility ?? 1;
}

function mid(a: PoseLandmark, b: PoseLandmark) {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  };
}

function poseScore(lm: PoseLandmark[], img: HTMLImageElement): number {
  const ls = lm[POSE_INDEX.leftShoulder];
  const rs = lm[POSE_INDEX.rightShoulder];
  if (!ls || !rs) return -Infinity;
  const shoulderVis = Math.min(visibility(ls), visibility(rs));
  if (shoulderVis < 0.35) return -Infinity;

  const shoulderLen = Math.hypot((ls.x - rs.x) * img.naturalWidth, (ls.y - rs.y) * img.naturalHeight);
  const shoulderMid = mid(ls, rs);
  const lh = lm[POSE_INDEX.leftHip];
  const rh = lm[POSE_INDEX.rightHip];
  const hipVis = Math.min(visibility(lh), visibility(rh));
  const hipMid = lh && rh && hipVis > 0.25 ? mid(lh, rh) : null;
  const torsoLen = hipMid
    ? Math.hypot((hipMid.x - shoulderMid.x) * img.naturalWidth, (hipMid.y - shoulderMid.y) * img.naturalHeight)
    : shoulderLen;

  // Foreground fashion subjects tend to have larger shoulder spans and sit
  // lower in the frame. This prevents a back/right person from winning just
  // because the detector returned them first.
  const scaleScore = shoulderLen * (torsoLen + shoulderLen * 0.5);
  const foregroundBoost = 0.75 + shoulderMid.y * 0.75;
  return scaleScore * foregroundBoost * shoulderVis;
}

function selectPrimaryPose(poses: PoseLandmark[][], img: HTMLImageElement): PoseLandmark[] {
  return poses.reduce((best, pose) => (
    poseScore(pose, img) > poseScore(best, img) ? pose : best
  ), poses[0]);
}

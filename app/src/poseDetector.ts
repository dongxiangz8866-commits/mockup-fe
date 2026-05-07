import { PoseLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

const WASM_BASE =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

export type PoseLandmark = { x: number; y: number; z: number; visibility?: number };

let landmarkerPromise: Promise<PoseLandmarker> | null = null;

function getLandmarker(): Promise<PoseLandmarker> {
  if (landmarkerPromise) return landmarkerPromise;
  landmarkerPromise = (async () => {
    const vision = await FilesetResolver.forVisionTasks(WASM_BASE);
    return PoseLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
      runningMode: 'IMAGE',
      numPoses: 1,
    });
  })();
  return landmarkerPromise;
}

export async function detectPose(
  img: HTMLImageElement
): Promise<PoseLandmark[] | null> {
  const lm = await getLandmarker();
  const result = lm.detect(img);
  if (!result.landmarks || result.landmarks.length === 0) return null;
  return result.landmarks[0] as PoseLandmark[];
}

const POSE_CACHE_PREFIX = 'pose-cache:v1:';

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
  const lm = await detectPose(img);
  if (lm) writeCachedPose(key, lm);
  return lm;
}

export const POSE_INDEX = {
  leftShoulder: 11,
  rightShoulder: 12,
  leftHip: 23,
  rightHip: 24,
} as const;

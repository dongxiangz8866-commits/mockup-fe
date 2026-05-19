import CanvasKitInit, { type CanvasKit } from 'canvaskit-wasm';
// Vite emits the wasm as a hashed asset and gives back its URL — works in
// `pnpm dev` and `vite build`. Deploy caveat: scripts/trim-dist.mjs strips
// non-image files from the surge copy, so a static deploy would 404 this;
// this route is a `pnpm dev` research experiment, not a deploy target.
import wasmUrl from 'canvaskit-wasm/bin/canvaskit.wasm?url';

// Single module-level init promise. CanvasKitInit downloads + compiles the
// ~7 MB wasm; doing it once and sharing the promise means a photo/pattern
// re-pick or a route re-mount never re-pays that cost (same rationale as the
// pose / depth singletons in the displace path).
let ckPromise: Promise<CanvasKit> | null = null;

export function getCanvasKit(): Promise<CanvasKit> {
  if (ckPromise) return ckPromise;
  ckPromise = CanvasKitInit({ locateFile: () => wasmUrl }).catch((e) => {
    // Clear on failure so a transient fetch flake doesn't poison the
    // singleton forever (mirrors poseDetector/getDepthPipe .catch reset).
    ckPromise = null;
    throw e;
  });
  return ckPromise;
}

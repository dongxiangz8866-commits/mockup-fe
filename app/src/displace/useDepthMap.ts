import { useEffect, useState } from 'react';
import { decodeCachedMap, loadCachedMap, saveCachedMap } from '../shading';
import { estimateDepth } from './depthPipeline';
import { recordStage } from './perfBus';

const DEPTH_MACRO_PREFIX = 'depth-cache:v4:';
const DEPTH_FINE_PREFIX = 'depth-fine-cache:v5:';

// Drop any leftover entries from prior unblurred / single-output / wrong-fine
// revisions so they don't silently consume localStorage quota forever. Runs
// once on module load.
//   v1-v3: single-canvas revisions
//   v4 (fine):  first macro+fine split, w0/64 blur. Replaced by v5 once the
//               shader was switched to a wider central-diff tap — that combo
//               needed a tighter native blur (w0/96) for the gradient to
//               actually have anything to read.
try {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (
      k &&
      (k.startsWith('depth-cache:v1:') ||
        k.startsWith('depth-cache:v2:') ||
        k.startsWith('depth-cache:v3:') ||
        k.startsWith('depth-fine-cache:v4:'))
    ) {
      localStorage.removeItem(k);
    }
  }
} catch {
  // private mode etc. — quota errors are non-fatal
}

// Live HTMLCanvasElement keyed by src — keeps the depth maps ready instantly
// on photo re-select within the same session. Stored as a pair because the
// fine map is loaded/disposed in lockstep with the macro map.
type CachedDepth = { depth: HTMLCanvasElement; depthFine: HTMLCanvasElement };
const depthMemCache = new Map<string, CachedDepth>();

export type DepthState = 'idle' | 'loading' | 'inferring' | 'ready' | 'fail';

export type DepthResult = {
  depth: HTMLCanvasElement | null;
  depthFine: HTMLCanvasElement | null;
  state: DepthState;
};

// Pose-style three-tier cache (in-mem → localStorage half-res JPEG → run
// inference). Inference path is the slow one (1-2 s on WebGPU, 10-20 s on
// WASM); the two cache tiers below it are what makes photo-switching feel
// instant after the first run on each src. Macro + fine are cached
// independently so a partial cache (e.g. fine missing after a prefix bump)
// only forces re-inference of the missing tier — though in practice they
// move together since they share inference output.
export function useDepthMap(photo: HTMLImageElement | null, src: string | null): DepthResult {
  const [depth, setDepth] = useState<HTMLCanvasElement | null>(null);
  const [depthFine, setDepthFine] = useState<HTMLCanvasElement | null>(null);
  const [state, setState] = useState<DepthState>('idle');

  useEffect(() => {
    console.log('[depth] effect fired, photo=', !!photo, 'src=', src);
    if (!photo || !src) {
      setDepth(null);
      setDepthFine(null);
      setState('idle');
      return;
    }
    const tStart = performance.now();
    const memHit = depthMemCache.get(src);
    if (memHit) {
      console.log('[depth] mem cache hit (macro+fine)');
      setDepth(memHit.depth);
      setDepthFine(memHit.depthFine);
      setState('ready');
      recordStage('depth', performance.now() - tStart, 'mem');
      return;
    }
    let cancelled = false;
    (async () => {
      const cachedMacroImg = loadCachedMap(DEPTH_MACRO_PREFIX, src);
      const cachedFineImg = loadCachedMap(DEPTH_FINE_PREFIX, src);
      if (cachedMacroImg && cachedFineImg) {
        console.log('[depth] localStorage cache hit (macro+fine), decoding…');
        try {
          const [macroCanvas, fineCanvas] = await Promise.all([
            decodeCachedMap(cachedMacroImg, photo.naturalWidth, photo.naturalHeight),
            decodeCachedMap(cachedFineImg, photo.naturalWidth, photo.naturalHeight),
          ]);
          if (cancelled) return;
          depthMemCache.set(src, { depth: macroCanvas, depthFine: fineCanvas });
          setDepth(macroCanvas);
          setDepthFine(fineCanvas);
          setState('ready');
          recordStage('depth', performance.now() - tStart, 'localStorage');
          return;
        } catch (e) {
          console.warn('[depth] cached decode failed, re-inferring:', e);
        }
      }
      try {
        console.log('[depth] starting inference (this will load DAv2 model on first call)…');
        setState('loading');
        const t0 = performance.now();
        const maps = await estimateDepth(photo);
        console.log('[depth] inference done in', Math.round(performance.now() - t0), 'ms');
        if (cancelled) return;
        depthMemCache.set(src, { depth: maps.depth, depthFine: maps.depthFine });
        saveCachedMap(DEPTH_MACRO_PREFIX, src, maps.depth);
        saveCachedMap(DEPTH_FINE_PREFIX, src, maps.depthFine);
        setDepth(maps.depth);
        setDepthFine(maps.depthFine);
        setState('ready');
        recordStage('depth', performance.now() - tStart, 'compute');
      } catch (e) {
        if (cancelled) return;
        console.error('[depth] INFERENCE FAILED:', e);
        setState('fail');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [photo, src]);

  return { depth, depthFine, state };
}

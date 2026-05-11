import { useEffect, useState } from 'react';
import { decodeCachedMap, loadCachedMap, saveCachedMap } from '../shading';
import { estimateDepth } from './depthPipeline';

const DEPTH_CACHE_PREFIX = 'depth-cache:v1:';

// Live HTMLCanvasElement keyed by src — keeps the depth map ready instantly
// on photo re-select within the same session.
const depthMemCache = new Map<string, HTMLCanvasElement>();

export type DepthState = 'idle' | 'loading' | 'inferring' | 'ready' | 'fail';

export type DepthResult = {
  depth: HTMLCanvasElement | null;
  state: DepthState;
};

// Pose-style three-tier cache (in-mem → localStorage half-res JPEG → run
// inference). Inference path is the slow one (1-2 s on WebGPU, 10-20 s on
// WASM); the two cache tiers below it are what makes photo-switching feel
// instant after the first run on each src.
export function useDepthMap(photo: HTMLImageElement | null, src: string | null): DepthResult {
  const [depth, setDepth] = useState<HTMLCanvasElement | null>(null);
  const [state, setState] = useState<DepthState>('idle');

  useEffect(() => {
    console.log('[depth] effect fired, photo=', !!photo, 'src=', src);
    if (!photo || !src) {
      setDepth(null);
      setState('idle');
      return;
    }
    const memHit = depthMemCache.get(src);
    if (memHit) {
      console.log('[depth] mem cache hit');
      setDepth(memHit);
      setState('ready');
      return;
    }
    let cancelled = false;
    (async () => {
      const cached = loadCachedMap(DEPTH_CACHE_PREFIX, src);
      if (cached) {
        console.log('[depth] localStorage cache hit, decoding…');
        try {
          const c = await decodeCachedMap(cached, photo.naturalWidth, photo.naturalHeight);
          if (cancelled) return;
          depthMemCache.set(src, c);
          setDepth(c);
          setState('ready');
          return;
        } catch (e) {
          console.warn('[depth] cached decode failed, re-inferring:', e);
        }
      }
      try {
        console.log('[depth] starting inference (this will load DAv2 model on first call)…');
        setState('loading');
        const t0 = performance.now();
        const c = await estimateDepth(photo);
        console.log('[depth] inference done in', Math.round(performance.now() - t0), 'ms');
        if (cancelled) return;
        depthMemCache.set(src, c);
        saveCachedMap(DEPTH_CACHE_PREFIX, src, c);
        setDepth(c);
        setState('ready');
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

  return { depth, state };
}

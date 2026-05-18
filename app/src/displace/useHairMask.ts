import { useEffect, useState } from 'react';
import { decodeCachedMap, loadCachedMap, saveCachedMap } from '../shading';
import { segmentHair } from './hairSegmenter';
import { recordStage } from './perfBus';

const HAIR_CACHE_PREFIX = 'hair-cache:v1:';

// Same three-tier pattern as useDepthMap: in-mem keyed by photo src, then
// localStorage half-res JPEG, then ML inference. Hair mask is binary at the
// category level but bilinear upscale + JPEG round-trip gives a soft-edge
// alpha that reads as natural hair occlusion in the displace shader.
const hairMemCache = new Map<string, HTMLCanvasElement>();

export type HairState = 'idle' | 'loading' | 'inferring' | 'ready' | 'fail';

export type HairResult = {
  hair: HTMLCanvasElement | null;
  state: HairState;
};

export function useHairMask(photo: HTMLImageElement | null, src: string | null): HairResult {
  const [hair, setHair] = useState<HTMLCanvasElement | null>(null);
  const [state, setState] = useState<HairState>('idle');

  useEffect(() => {
    if (!photo || !src) {
      setHair(null);
      setState('idle');
      return;
    }
    const tStart = performance.now();
    const memHit = hairMemCache.get(src);
    if (memHit) {
      setHair(memHit);
      setState('ready');
      recordStage('hair', performance.now() - tStart, 'mem');
      return;
    }
    let cancelled = false;
    (async () => {
      const cached = loadCachedMap(HAIR_CACHE_PREFIX, src);
      if (cached) {
        try {
          const c = await decodeCachedMap(cached, photo.naturalWidth, photo.naturalHeight);
          if (cancelled) return;
          hairMemCache.set(src, c);
          setHair(c);
          setState('ready');
          recordStage('hair', performance.now() - tStart, 'localStorage');
          return;
        } catch (e) {
          console.warn('[hair] cached decode failed, re-inferring:', e);
        }
      }
      try {
        setState('loading');
        const t0 = performance.now();
        const c = await segmentHair(photo);
        console.log('[hair] inference done in', Math.round(performance.now() - t0), 'ms');
        if (cancelled) return;
        hairMemCache.set(src, c);
        saveCachedMap(HAIR_CACHE_PREFIX, src, c);
        setHair(c);
        setState('ready');
        recordStage('hair', performance.now() - tStart, 'compute');
      } catch (e) {
        if (cancelled) return;
        console.error('[hair] segmentation failed:', e);
        setState('fail');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [photo, src]);

  return { hair, state };
}

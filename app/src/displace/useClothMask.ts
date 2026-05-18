import { useEffect, useState } from 'react';
import { decodeCachedMap, loadCachedMap, saveCachedMap } from '../shading';
import { segmentClothes } from './clothSegmenter';
import { recordStage } from './perfBus';

// v2: mask is now morphologically closed (boxMorph in clothSegmenter) before
// caching — output bytes changed, so the prefix bump forces stale v1 entries
// to be re-inferred instead of silently serving un-closed masks.
const CLOTH_CACHE_PREFIX = 'cloth-cache:v2:';

// Same three-tier pattern as useHairMask / useDepthMap: in-mem keyed by photo
// src, then localStorage half-res JPEG, then ML inference. Mask is binary at
// the category level but bilinear upscale + JPEG round-trip gives a soft edge
// that reads as a natural warp/relight gate at the garment boundary.
const clothMemCache = new Map<string, HTMLCanvasElement>();

export type ClothState = 'idle' | 'loading' | 'inferring' | 'ready' | 'fail';

export type ClothResult = {
  cloth: HTMLCanvasElement | null;
  state: ClothState;
};

export function useClothMask(photo: HTMLImageElement | null, src: string | null): ClothResult {
  const [cloth, setCloth] = useState<HTMLCanvasElement | null>(null);
  const [state, setState] = useState<ClothState>('idle');

  useEffect(() => {
    if (!photo || !src) {
      setCloth(null);
      setState('idle');
      return;
    }
    const tStart = performance.now();
    const memHit = clothMemCache.get(src);
    if (memHit) {
      setCloth(memHit);
      setState('ready');
      recordStage('cloth', performance.now() - tStart, 'mem');
      return;
    }
    let cancelled = false;
    (async () => {
      const cached = loadCachedMap(CLOTH_CACHE_PREFIX, src);
      if (cached) {
        try {
          const c = await decodeCachedMap(cached, photo.naturalWidth, photo.naturalHeight);
          if (cancelled) return;
          clothMemCache.set(src, c);
          setCloth(c);
          setState('ready');
          recordStage('cloth', performance.now() - tStart, 'localStorage');
          return;
        } catch (e) {
          console.warn('[cloth] cached decode failed, re-inferring:', e);
        }
      }
      try {
        setState('loading');
        const t0 = performance.now();
        const c = await segmentClothes(photo);
        console.log('[cloth] inference done in', Math.round(performance.now() - t0), 'ms');
        if (cancelled) return;
        clothMemCache.set(src, c);
        saveCachedMap(CLOTH_CACHE_PREFIX, src, c);
        setCloth(c);
        setState('ready');
        recordStage('cloth', performance.now() - tStart, 'compute');
      } catch (e) {
        if (cancelled) return;
        console.error('[cloth] segmentation failed:', e);
        setState('fail');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [photo, src]);

  return { cloth, state };
}

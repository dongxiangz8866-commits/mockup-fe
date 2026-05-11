import { useEffect, useRef, useState } from 'react';
import { detectPoseCached, readCachedPose, type PoseLandmark } from './poseDetector';
import {
  buildFabricTexture,
  buildHighlightMap,
  buildShadingMap,
  decodeCachedMap,
  loadCachedMap,
  preprocessForShading,
  quadFromLandmarks,
  saveCachedMap,
  type Quad,
  type ShadingInput,
} from './shading';

// In-mem caches keyed by src — keep live HTMLImageElement / HTMLCanvasElement
// so a re-mount (modal open) skips localStorage decode + the loading badge.
const photoMemCache = new Map<string, HTMLImageElement>();
const shadingMemCache = new Map<string, HTMLCanvasElement>();
const wideShadingMemCache = new Map<string, HTMLCanvasElement>();
const highlightMemCache = new Map<string, HTMLCanvasElement>();
const fabricMemCache = new Map<string, HTMLCanvasElement>();

export const SHADING_CACHE_PREFIX = 'sh-cache:v12:';
export const WIDE_SHADING_CACHE_PREFIX = 'wsh-cache:v5:';
export const HIGHLIGHT_CACHE_PREFIX = 'hl-cache:v6:';
export const FABRIC_CACHE_PREFIX = 'fb-cache:v1:';

export type ModelAssetStatus = 'loading' | 'pose' | 'ready' | 'fail';

export type ModelAssets = {
  photoRef: React.MutableRefObject<HTMLImageElement | null>;
  shadingRef: React.MutableRefObject<HTMLCanvasElement | null>;
  wideShadingRef: React.MutableRefObject<HTMLCanvasElement | null>;
  highlightRef: React.MutableRefObject<HTMLCanvasElement | null>;
  fabricRef: React.MutableRefObject<HTMLCanvasElement | null>;
  photoSize: { w: number; h: number } | null;
  quad: Quad | null;
  setQuad: React.Dispatch<React.SetStateAction<Quad | null>>;
  status: ModelAssetStatus;
};

function readMemCache(src: string) {
  const photo = photoMemCache.get(src) ?? null;
  return {
    photo,
    shading: shadingMemCache.get(src) ?? null,
    wideShading: wideShadingMemCache.get(src) ?? null,
    highlight: highlightMemCache.get(src) ?? null,
    fabric: fabricMemCache.get(src) ?? null,
    pose: photo ? readCachedPose(src) : null,
  };
}

// Three-tier map hydration: in-mem → localStorage half-res JPEG → build.
async function hydrateMap(
  src: string,
  prefix: string,
  mem: Map<string, HTMLCanvasElement>,
  build: () => HTMLCanvasElement,
  w: number,
  h: number
): Promise<HTMLCanvasElement> {
  const cached = mem.get(src);
  if (cached) return cached;
  const stored = loadCachedMap(prefix, src);
  let map: HTMLCanvasElement;
  if (stored) {
    map = await decodeCachedMap(stored, w, h);
  } else {
    map = build();
    saveCachedMap(prefix, src, map);
  }
  mem.set(src, map);
  return map;
}

export function useModelAssets(src: string): ModelAssets {
  const initial = readMemCache(src);
  const photoRef = useRef<HTMLImageElement | null>(initial.photo);
  const shadingRef = useRef<HTMLCanvasElement | null>(initial.shading);
  const wideShadingRef = useRef<HTMLCanvasElement | null>(initial.wideShading);
  const highlightRef = useRef<HTMLCanvasElement | null>(initial.highlight);
  const fabricRef = useRef<HTMLCanvasElement | null>(initial.fabric);

  const [photoSize, setPhotoSize] = useState<{ w: number; h: number } | null>(() =>
    initial.photo ? { w: initial.photo.naturalWidth, h: initial.photo.naturalHeight } : null
  );
  const [quad, setQuad] = useState<Quad | null>(() =>
    initial.photo && initial.pose
      ? quadFromLandmarks(initial.pose, initial.photo.naturalWidth, initial.photo.naturalHeight)
      : null
  );
  const [status, setStatus] = useState<ModelAssetStatus>(() =>
    initial.photo &&
    initial.shading &&
    initial.wideShading &&
    initial.highlight &&
    initial.fabric &&
    initial.pose
      ? 'ready'
      : 'loading'
  );

  useEffect(() => {
    let cancelled = false;
    if (
      photoRef.current &&
      shadingRef.current &&
      wideShadingRef.current &&
      highlightRef.current &&
      fabricRef.current &&
      quad
    )
      return;

    setStatus('loading');
    const img = photoRef.current ?? new Image();
    if (!photoRef.current) img.crossOrigin = 'anonymous';

    const onReady = async (image: HTMLImageElement) => {
      if (cancelled) return;
      photoRef.current = image;
      photoMemCache.set(src, image);
      setPhotoSize({ w: image.naturalWidth, h: image.naturalHeight });

      // Pose before A1 stretch: the print quad is the shirt-sampling region
      // for preprocessForShading. ~1-2 s cold, <5 ms cached.
      setStatus('pose');
      let lm: PoseLandmark[] | null = null;
      try {
        lm = await detectPoseCached(image, src);
      } catch (e) {
        if (cancelled) return;
        console.warn('pose fail', e);
      }
      if (cancelled) return;
      const detectedQuad = lm
        ? quadFromLandmarks(lm, image.naturalWidth, image.naturalHeight)
        : null;

      // Lazy A1 stretch: shared by narrow + wide shading; skipped entirely
      // when both caches hit. White photos exit preprocessForShading as
      // identity → byte-equal invariant.
      let _shadingInput: ShadingInput | null = null;
      const getShadingInput = () =>
        (_shadingInput ?? (_shadingInput = preprocessForShading(image, detectedQuad)));

      const w = image.naturalWidth;
      const h = image.naturalHeight;
      shadingRef.current = await hydrateMap(
        src, SHADING_CACHE_PREFIX, shadingMemCache,
        () => buildShadingMap(getShadingInput()), w, h
      );
      if (cancelled) return;
      wideShadingRef.current = await hydrateMap(
        src, WIDE_SHADING_CACHE_PREFIX, wideShadingMemCache,
        () => buildShadingMap(getShadingInput(), 0.1), w, h
      );
      if (cancelled) return;
      highlightRef.current = await hydrateMap(
        src, HIGHLIGHT_CACHE_PREFIX, highlightMemCache,
        () => buildHighlightMap(image), w, h
      );
      if (cancelled) return;
      fabricRef.current = await hydrateMap(
        src, FABRIC_CACHE_PREFIX, fabricMemCache,
        () => buildFabricTexture(image), w, h
      );
      if (cancelled) return;

      if (detectedQuad) {
        setQuad(detectedQuad);
        setStatus('ready');
      } else {
        setStatus('fail');
      }
    };

    if (photoRef.current) {
      onReady(photoRef.current);
    } else {
      img.onload = () => onReady(img);
      img.src = src;
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  return { photoRef, shadingRef, wideShadingRef, highlightRef, fabricRef, photoSize, quad, setQuad, status };
}

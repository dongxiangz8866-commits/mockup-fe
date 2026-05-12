import { useEffect, useMemo, useState } from 'react';
import { detectPoseCached, type PoseLandmark } from '../poseDetector';
import {
  quadFromLandmarks,
  sampleGarment,
  sampleScene,
  type GarmentSample,
  type Quad,
  type SceneSample,
} from '../shading';

// Photo-keyed garment cache. sampleGarment is heavy (full-frame getImageData
// on a 2K photo = ~100 ms). Without this, dragging the print recomputed it on
// every quad change → 60 calls/s freeze the UI. Cached per src because the
// garment color is bound to the SHIRT (= photo), not to where the print sits
// on it; sampling-strip drift from quad re-pose is negligible vs the speed win.
const garmentMemCache = new Map<string, GarmentSample>();
// Same rationale as garmentMemCache: env color is a SCENE property and does
// not change as the user drags the print around. Keyed by photoSrc only.
const sceneMemCache = new Map<string, SceneSample>();
import DisplaceCanvas, { type DebugMode } from './DisplaceCanvas';
import { deriveMaps, type DerivedMaps } from './MapPipeline';
import PhotoPicker from './PhotoPicker';
import { dataCanvasToTexture, loadImage } from './textures';
import { useDepthMap } from './useDepthMap';
import { useDisplaceTextures } from './useDisplaceTextures';
import { useHairMask } from './useHairMask';
import { useQuadDrag } from './useQuadDrag';
import s from './DisplacePage.module.css';
import * as THREE from 'three';

type DispSource = 'dog' | 'depth';

type LoadState = 'idle' | 'loading' | 'pose' | 'maps' | 'ready' | 'fail';

export default function DisplacePage() {
  const [photoSrc, setPhotoSrc] = useState<string | null>(null);
  const [patternSrc, setPatternSrc] = useState<string | null>(null);

  const [photo, setPhoto] = useState<HTMLImageElement | null>(null);
  const [patternImg, setPatternImg] = useState<HTMLImageElement | null>(null);
  const [quad, setQuad] = useState<Quad | null>(null);
  const [maps, setMaps] = useState<DerivedMaps | null>(null);
  const [status, setStatus] = useState<LoadState>('idle');

  const [strength, setStrength] = useState(1.0);
  const [light, setLightStrength] = useState(1.0);
  const [sceneBrightness, setSceneBrightness] = useState(1.0);
  // lift kept at 0 by request — sceneBrightness alone is enough for
  // black-shirt patterns once shadow modulation is reasonable. Slider
  // removed from UI; uniform still wired in case we re-introduce later.
  const lift = 0.0;
  const tint = 0.5;
  const [depthWrapStrength, setDepthWrapStrength] = useState(5.0);
  const [reverseDisp, setReverseDisp] = useState(false);
  const [dispSource, setDispSource] = useState<DispSource>('depth');
  const [debug, setDebugMode] = useState<DebugMode>('composite');

  // Photo + pose + maps pipeline.
  useEffect(() => {
    if (!photoSrc) return;
    let cancelled = false;

    (async () => {
      // Reset photo / quad / maps BEFORE awaiting the new image. Otherwise
      // the garment / sceneSample useMemos run during the load with
      // photoSrc=NEW + photo=OLD, compute the OLD shirt's sample, and
      // POISON the in-memory cache under the NEW src key. After the load
      // finishes, every read of the new src returns the poisoned old sample.
      // Symptom: switching shirts didn't change lightStrength.
      setStatus('loading');
      setPhoto(null);
      setQuad(null);
      setMaps(null);
      try {
        const img = await loadImage(photoSrc);
        if (cancelled) return;
        setPhoto(img);

        setStatus('pose');
        let lm: PoseLandmark[] | null = null;
        try {
          lm = await detectPoseCached(img, photoSrc);
        } catch (e) {
          console.warn('pose fail', e);
        }
        if (cancelled) return;
        const detectedQuad = lm ? quadFromLandmarks(lm, img.naturalWidth, img.naturalHeight) : null;
        setQuad(detectedQuad);

        setStatus('maps');
        const derived = await deriveMaps(img, detectedQuad, photoSrc);
        if (cancelled) return;
        setMaps(derived);
        setStatus(detectedQuad ? 'ready' : 'fail');
      } catch (e) {
        console.warn(e);
        if (!cancelled) setStatus('fail');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [photoSrc]);

  // Pattern image load.
  useEffect(() => {
    if (!patternSrc) {
      setPatternImg(null);
      return;
    }
    let cancelled = false;
    loadImage(patternSrc).then((img) => {
      if (!cancelled) setPatternImg(img);
    }).catch((e) => console.warn('pattern load fail', e));
    return () => {
      cancelled = true;
    };
  }, [patternSrc]);

  const { photoTex, patternTex, displaceTex: dogDisplaceTex, lightTex, shadingTex } =
    useDisplaceTextures(photo, patternImg, maps);

  // Memoize photoSize so its REFERENCE is stable across renders (was a fresh
  // object literal each render, breaking every downstream useMemo/useEffect
  // that depends on it — incl. useQuadDrag, printCenterUV, etc.).
  const photoSize = useMemo(
    () => (photo ? { w: photo.naturalWidth, h: photo.naturalHeight } : null),
    [photo]
  );
  const aspect = photoSize ? photoSize.w / photoSize.h : 0.667;

  // Depth path — bypasses Sobel entirely (Sobel of depth at chest center is
  // ~0, same problem as photo-DoG). The shader instead receives the RAW DEPTH
  // texture and the print-center UV; it computes a radial outward warp where
  // displacement = drop_from_center × distance_from_center. This produces
  // visible cylinder wrap even at the chest's flat front, where the gradient
  // approach gives nothing.
  const depthResult = useDepthMap(photo, photoSrc);
  const depthTex = useMemo(
    () => (depthResult.depth ? dataCanvasToTexture(depthResult.depth) : null),
    [depthResult.depth]
  );
  useEffect(
    () => () => { depthTex?.dispose(); },
    [depthTex]
  );

  // Hair segmentation → per-pixel mask for foreground occlusion. Until the
  // ML model returns, fall back to a 1×1 black canvas (= no hair anywhere)
  // so the shader still has a valid texture bound and the chroma-distance
  // mask carries occlusion alone. Once ready, hair texture takes priority
  // via the AND combination in the shader.
  const hairResult = useHairMask(photo, photoSrc);
  const blankHairCanvas = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = 1;
    c.height = 1;
    c.getContext('2d')!.fillStyle = '#000';
    c.getContext('2d')!.fillRect(0, 0, 1, 1);
    return c;
  }, []);
  const hairTex = useMemo(
    () => dataCanvasToTexture(hairResult.hair ?? blankHairCanvas),
    [hairResult.hair, blankHairCanvas]
  );
  useEffect(
    () => () => { hairTex?.dispose(); },
    [hairTex]
  );

  const displaceTex: THREE.Texture | null =
    dispSource === 'depth' && depthTex ? depthTex : dogDisplaceTex;
  const depthWrap = dispSource === 'depth' && depthTex ? depthWrapStrength : 0.0;
  const printCenterUV: [number, number] = useMemo(() => {
    if (!quad || !photoSize) return [0.5, 0.5];
    const cx = (quad.tl.x + quad.tr.x + quad.bl.x + quad.br.x) / 4 / photoSize.w;
    const cy = (quad.tl.y + quad.tr.y + quad.bl.y + quad.br.y) / 4 / photoSize.h;
    return [cx, cy];
  }, [quad, photoSize]);

  // CPU-side zCenter: sample the depth canvas at the print center ONCE per
  // (depth, printCenterUV) change instead of letting every fragment re-sample
  // the same texel. The depth path's per-fragment cost drops by one
  // texture2D() — small per-frame win but cleaner for high-DPR canvases.
  const zCenter = useMemo(() => {
    if (!depthResult.depth) return 0.5;
    const c = depthResult.depth;
    const x = Math.max(0, Math.min(c.width - 1, Math.round(printCenterUV[0] * c.width)));
    const y = Math.max(0, Math.min(c.height - 1, Math.round(printCenterUV[1] * c.height)));
    return c.getContext('2d')!.getImageData(x, y, 1, 1).data[0] / 255;
  }, [depthResult.depth, printCenterUV]);

  // Sample garment color ONCE per src — see garmentMemCache comment above
  // for why we don't re-sample on quad change (drag).
  const garment: GarmentSample | null = useMemo(() => {
    if (!photo || !quad || !photoSrc) return null;
    const cached = garmentMemCache.get(photoSrc);
    if (cached) return cached;
    const fresh = sampleGarment(photo, quad);
    garmentMemCache.set(photoSrc, fresh);
    return fresh;
  }, [photo, quad, photoSrc]);

  // Photo-keyed env color sample. Independent of the print quad position
  // (sceneMemCache like garmentMemCache), so dragging the print doesn't
  // re-sample. quad is forwarded so the shirt region can be masked out of
  // the env-color average.
  const sceneSample: SceneSample | null = useMemo(() => {
    if (!photo || !photoSrc) return null;
    const cached = sceneMemCache.get(photoSrc);
    if (cached) return cached;
    const fresh = sampleScene(photo, quad);
    sceneMemCache.set(photoSrc, fresh);
    return fresh;
  }, [photo, photoSrc, quad]);

  const envRGB: [number, number, number] = useMemo(
    () => (sceneSample
      ? [sceneSample.rgb[0] / 255, sceneSample.rgb[1] / 255, sceneSample.rgb[2] / 255]
      : [0.5, 0.5, 0.5]),
    [sceneSample]
  );

  const garmentRGB: [number, number, number] = useMemo(
    () => (garment
      ? [garment.rgb[0] / 255, garment.rgb[1] / 255, garment.rgb[2] / 255]
      : [0.5, 0.5, 0.5]),
    [garment]
  );

  // Auto-tune lightStrength AND sceneBrightness from the OVERLAP — the shirt
  // color sampled inside the print quad. The earlier pattern-image-brightness
  // detour was the wrong layer: what matters for shadow modulation is what
  // SUBSTRATE the pattern is being printed on, not the artwork itself.
  //   • black shirt under print → lightStrength 0.5, sceneBrightness 0.8
  //   • white shirt under print → lightStrength 1.5, sceneBrightness 1.0
  //   • mixed shirt (e.g. half black / half white) → garment strip-sample
  //     averages it, auto value lands in between — exactly where a viewer
  //     would expect a print straddling both halves to sit.
  useEffect(() => {
    if (!garment) return;
    const meanLum = garment.rgb[0] * 0.299 + garment.rgb[1] * 0.587 + garment.rgb[2] * 0.114;
    const t = Math.max(0, Math.min(1, (meanLum - 50) / 170));
    const ls = 0.5 + t * 1.0;
    const sb = 0.8 + t * 0.2;
    console.log(`[overlap] garmentMeanLum=${meanLum.toFixed(0)} t=${t.toFixed(2)} → lightStrength=${ls.toFixed(2)} sceneBrightness=${sb.toFixed(2)}`);
    setLightStrength(ls);
    setSceneBrightness(sb);
  }, [garment]);

  // Debug: log env signal so we can tell whether 色彩融合 is gated off
  // (envSat too low) vs just visually subtle. Logs both highlight-based color
  // and full-frame brightness independently.
  useEffect(() => {
    if (!sceneSample) return;
    const [r, g, b] = sceneSample.rgb;
    const mx = Math.max(r, g, b, 0.001);
    const mn = Math.min(r, g, b);
    const envSat = (mx - mn) / mx;
    console.log(
      `[env] highlight rgb=(${r.toFixed(0)},${g.toFixed(0)},${b.toFixed(0)}) ` +
      `hlLum=${sceneSample.highlightLum.toFixed(0)} ` +
      `fullLum=${sceneSample.fullLum.toFixed(0)} ` +
      `sat=${envSat.toFixed(3)} ` +
      `→ adaptW @uTint=${tint.toFixed(2)}: ${(
        tint * Math.max(0, Math.min(1, (envSat - 0.03) / (0.12 - 0.03)))
      ).toFixed(3)}`
    );
  }, [sceneSample, tint]);
  const drag = useQuadDrag(quad, setQuad, photoSize);
  const ready =
    status === 'ready' && photoTex && patternTex && displaceTex && lightTex && shadingTex && quad && photoSize;

  // Wrap setPhotoSrc so photo/quad/maps are cleared SYNCHRONOUSLY in the
  // same React 18 event batch. Without this, the render right after
  // setPhotoSrc(new) has photoSrc=new but photo/quad=OLD, and the garment /
  // sceneSample useMemos run with that mismatched state, poison the cache
  // under the new src key, and every subsequent read returns the wrong
  // (old) sample. Symptom user saw: light strength didn't update on switch
  // until the page was refreshed (which cleared the in-memory cache).
  const pickPhoto = (src: string) => {
    setPhoto(null);
    setQuad(null);
    setMaps(null);
    setPhotoSrc(src);
  };

  return (
    <main className={s.page} data-displace-status={status} data-depth-state={depthResult.state} data-hair-state={hairResult.state} data-photo-src={photoSrc ?? ''}>
      <div className={s.toolbar}>
        <PhotoPicker current={photoSrc} onPick={pickPhoto} />
        <label className={s.uploadBtn}>
          <input
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) setPatternSrc(URL.createObjectURL(f));
            }}
          />
          <span>选择图案</span>
        </label>
        <div className={s.controls}>
          <label className={s.range}>
            强度 <input type="range" min={0} max={1} step={0.05} value={strength}
              onChange={(e) => setStrength(Number(e.target.value))} />
            <span>{strength.toFixed(2)}</span>
          </label>
          <label className={s.range}>
            <input type="checkbox" checked={reverseDisp}
              onChange={(e) => setReverseDisp(e.target.checked)} />
            反向位移
          </label>
          <div className={s.debugRadios}>
            位移源:
            <label>
              <input
                type="radio"
                name="disp-source"
                checked={dispSource === 'depth'}
                onChange={() => setDispSource('depth')}
              />
              深度{depthResult.state === 'loading' && ' (跡中…)'}
              {depthResult.state === 'fail' && ' (失败)'}
            </label>
            <label>
              <input
                type="radio"
                name="disp-source"
                checked={dispSource === 'dog'}
                onChange={() => setDispSource('dog')}
              />
              DoG (旧)
            </label>
          </div>
          <label className={s.range}>
            光照 <input type="range" min={0} max={2} step={0.05} value={light}
              onChange={(e) => setLightStrength(Number(e.target.value))} />
            <span>{light.toFixed(2)}</span>
          </label>
          <label className={s.range}>
            整体亮度 <input type="range" min={0.3} max={1.2} step={0.05} value={sceneBrightness}
              onChange={(e) => setSceneBrightness(Number(e.target.value))} />
            <span>{sceneBrightness.toFixed(2)}</span>
          </label>
          <label className={s.range}>
            贴合强度 <input type="range" min={0} max={30} step={0.5} value={depthWrapStrength}
              onChange={(e) => setDepthWrapStrength(Number(e.target.value))}
              disabled={dispSource !== 'depth'} />
            <span>{depthWrapStrength.toFixed(1)}</span>
          </label>
          <div className={s.debugRadios}>
            {(['composite', 'displace', 'light', 'shading'] as DebugMode[]).map((m) => (
              <label key={m}>
                <input type="radio" name="debug-mode" checked={debug === m} onChange={() => setDebugMode(m)} />
                {m === 'composite' ? '合成' : m === 'displace' ? '位移' : m === 'light' ? '光照' : 'Shading'}
              </label>
            ))}
          </div>
        </div>
      </div>
      <div className={s.stage}>
        {!photoSrc && <div className={s.empty}>选个模特图开始</div>}
        {photoSrc && !ready && (
          <div className={s.empty}>
            {status === 'loading' && '加载中…'}
            {status === 'pose' && '识别姿态…'}
            {status === 'maps' && '派生 displace + light…'}
            {status === 'fail' && '识别失败'}
            {status === 'ready' && !patternTex && '请选择一张图案'}
          </div>
        )}
        {ready && (
          <div
            className={s.canvasFrame}
            style={{ aspectRatio: `${aspect}`, cursor: drag.dragging ? 'grabbing' : 'grab' }}
            onPointerDown={drag.onPointerDown}
            onPointerMove={drag.onPointerMove}
            onPointerUp={drag.onPointerUp}
            onPointerCancel={drag.onPointerUp}
          >
            <DisplaceCanvas
              photoTex={photoTex}
              patternTex={patternTex}
              displaceTex={displaceTex}
              lightTex={lightTex}
              shadingTex={shadingTex}
              photoSize={photoSize}
              quad={quad}
              strength={strength}
              dispSign={reverseDisp ? -1 : 1}
              depthWrap={depthWrap}
              zCenter={zCenter}
              printCenterUV={printCenterUV}
              envRGB={envRGB}
              garmentRGB={garmentRGB}
              hairTex={hairTex}
              tint={tint}
              sceneBrightness={sceneBrightness}
              lift={lift}
              lightStrength={light}
              debugMode={debug}
            />
          </div>
        )}
      </div>
    </main>
  );
}

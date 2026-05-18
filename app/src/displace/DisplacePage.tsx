import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { detectPoseCached, readCachedPose, type PoseLandmark } from '../poseDetector';
import {
  classifyShirt,
  quadFromLandmarks,
  sampleGarment,
  sampleScene,
  type GarmentSample,
  type Quad,
  type SceneSample,
} from '../shading';
import ControlRail from './ControlRail';
import DisplaceCanvas, { type DebugMode } from './DisplaceCanvas';
import { deriveMaps, type DerivedMaps } from './MapPipeline';
import PatternPicker from './PatternPicker';
import PerfPanel from './PerfPanel';
import PhotoPicker from './PhotoPicker';
import QuadHandles from './QuadHandles';
import SourcePreview from './SourcePreview';
import { sampleDepthStats } from './depthStats';
import { recordStage, resetParse } from './perfBus';
import { sampleShadingStats } from './shadingStats';
import { dataCanvasToTexture, loadImage } from './textures';
import { useDepthMap } from './useDepthMap';
import { useDisplaceTextures } from './useDisplaceTextures';
import { useHairMask } from './useHairMask';
import { usePerfMetrics } from './usePerfMetrics';
import { useQuadDrag } from './useQuadDrag';
import s from './DisplacePage.module.css';

type LoadState = 'idle' | 'loading' | 'pose' | 'maps' | 'ready' | 'fail';

// Photo-keyed garment cache. sampleGarment is heavy (full-frame getImageData
// on a 2K photo = ~100 ms). Without this, dragging the print recomputed it on
// every quad change → 60 calls/s freeze the UI. Cached per src because the
// garment color is bound to the SHIRT (= photo), not to where the print sits
// on it; sampling-strip drift from quad re-pose is negligible vs the speed win.
const garmentMemCache = new Map<string, GarmentSample>();
// Same rationale as garmentMemCache: env color is a SCENE property and does
// not change as the user drags the print around. Keyed by photoSrc only.
const sceneMemCache = new Map<string, SceneSample>();

function autoLightStrength(garment: GarmentSample): number {
  const [r, g, b] = garment.rgb;
  const maxRGB = Math.max(r, g, b);
  const minRGB = Math.min(r, g, b);
  const sat = maxRGB > 0 ? (maxRGB - minRGB) / maxRGB : 0;
  const key = classifyShirt(garment);
  if (key === 'white') return 1.35;
  if (key === 'black') return 0.45;

  // Saturated shirts have low luminance in BT.601 even when visually bright
  // (red is the obvious case). Keep their multiply-light contribution weak
  // so shadows shape the print without crushing the artwork.
  const vivid = Math.max(0, Math.min(1, (sat - 0.20) / 0.45));
  const brightColor = Math.max(0, Math.min(1, (maxRGB - 100) / 120));
  return 0.45 + (0.18 - 0.45) * vivid * brightColor;
}

export default function DisplacePage() {
  const [photoSrc, setPhotoSrc] = useState<string | null>(null);
  const [patternSrc, setPatternSrc] = useState<string | null>(null);
  // Edit handles reveal on hover/drag only — keeps the composite clean to
  // judge the result, while still being one mouse-move away from editing.
  const [hoverStage, setHoverStage] = useState(false);

  const [photo, setPhoto] = useState<HTMLImageElement | null>(null);
  const [patternImg, setPatternImg] = useState<HTMLImageElement | null>(null);
  const [quad, setQuad] = useState<Quad | null>(null);
  const [maps, setMaps] = useState<DerivedMaps | null>(null);
  const [status, setStatus] = useState<LoadState>('idle');

  const [scale, setScale] = useState(1.0);
  const [light, setLightStrength] = useState(1.0);
  const [sceneBrightness, setSceneBrightness] = useState(1.0);
  // lift kept at 0 by request — sceneBrightness alone is enough for
  // black-shirt patterns once shadow modulation is reasonable. Slider
  // removed from UI; uniform still wired in case we re-introduce later.
  const lift = 0.0;
  const tint = 0.5;
  const strength = 1.0;
  const [depthWrapStrength, setDepthWrapStrength] = useState(2.0);
  const [debug, setDebugMode] = useState<DebugMode>('composite');
  // Default 1.0 — restored after the mesh-warp refactor (2026-05-13) moved
  // the fold push from per-fragment to per-vertex sampling. The artefacts
  // that forced default=0 on the per-fragment version (wave fragmentation,
  // horizontal slashes on tie-dye) can't occur structurally with mesh
  // interpolation: vertex spacing IS the low-pass, and GPU bilinear
  // guarantees a smooth UV field between vertices.
  const [wrinkleDepthStrength, setWrinkleDepthStrength] = useState(0.5);

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
      resetParse(performance.now());
      try {
        const tLoad = performance.now();
        const img = await loadImage(photoSrc);
        if (cancelled) return;
        recordStage('load', performance.now() - tLoad, 'compute');
        setPhoto(img);

        setStatus('pose');
        // readCachedPose reports the source label *before* detect runs —
        // detectPoseCached reads the same localStorage entry internally, then
        // falls back to ML inference only on a miss.
        const poseCached = !!readCachedPose(photoSrc);
        const tPose = performance.now();
        let lm: PoseLandmark[] | null = null;
        try {
          lm = await detectPoseCached(img, photoSrc);
        } catch (e) {
          console.warn('pose fail', e);
        }
        if (cancelled) return;
        recordStage('pose', performance.now() - tPose, poseCached ? 'localStorage' : 'compute');
        const detectedQuad = lm ? quadFromLandmarks(lm, img.naturalWidth, img.naturalHeight) : null;
        setQuad(detectedQuad);

        setStatus('maps');
        // MapPipeline has its own internal 3-tier cache; surfacing which tier
        // it hit would mean threading state out of deriveMaps. The measured
        // wall time already reflects cache-vs-compute, so the label stays
        // generic here while the number tells the real story.
        const tMaps = performance.now();
        const derived = await deriveMaps(img, detectedQuad, photoSrc);
        if (cancelled) return;
        recordStage('maps', performance.now() - tMaps, 'compute');
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

  // Depth path — bypasses photo-DoG Sobel entirely. The shader instead
  // receives:
  //   • MACRO depth (heavily blurred) on uDisplace — drives the radial
  //     cylinder wrap: displacement = drop_from_center × distance_from_center.
  //     Visible body-cylinder wrap even at the chest's flat front, where a
  //     pure ∇z approach gives nothing.
  //   • FINE depth (lightly blurred) on uWrinkleDisplace — drives the
  //     in-shader Sobel-of-depth term that bends pattern across local
  //     clothing folds (drape, cowl, vertical creases through the print).
  //     This is the "depth-driven 才算贴合" piece: macro alone reads as a
  //     smooth ball, fine adds the actual fabric topology.
  const depthResult = useDepthMap(photo, photoSrc);
  const depthTex = useMemo(
    () => (depthResult.depth ? dataCanvasToTexture(depthResult.depth) : null),
    [depthResult.depth]
  );
  const depthFineTex = useMemo(
    () => (depthResult.depthFine ? dataCanvasToTexture(depthResult.depthFine) : null),
    [depthResult.depthFine]
  );
  useEffect(
    () => () => { depthTex?.dispose(); },
    [depthTex]
  );
  useEffect(
    () => () => { depthFineTex?.dispose(); },
    [depthFineTex]
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

  // Depth handles broad torso curvature on the macro tex; FINE depth feeds
  // the per-fragment ∇z fold term in the shader. When ML depth is unavailable
  // we fall back to the photo-DoG Sobel map on the macro slot (legacy path,
  // uDepthWrap=0 there) — fine slot stays null and the shader gracefully
  // skips the gradient term because uWrinkleStrength gates it.
  const displaceTex: THREE.Texture | null = depthTex ?? dogDisplaceTex;
  const wrinkleDisplaceTex: THREE.Texture | null = depthFineTex ?? dogDisplaceTex;
  const depthWrap = depthTex ? depthWrapStrength : 0.0;

  // User-controlled pattern size: scale the pose-detected quad around its
  // own center. Drag still operates on the unscaled `quad` (translation
  // commutes with scale-around-current-center), so cursor tracking stays
  // 1:1 regardless of scale.
  const scaledQuad = useMemo<Quad | null>(() => {
    if (!quad) return null;
    const cx = (quad.tl.x + quad.tr.x + quad.bl.x + quad.br.x) / 4;
    const cy = (quad.tl.y + quad.tr.y + quad.bl.y + quad.br.y) / 4;
    const s = scale;
    const f = (p: { x: number; y: number }) => ({
      x: cx + (p.x - cx) * s,
      y: cy + (p.y - cy) * s,
    });
    return { tl: f(quad.tl), tr: f(quad.tr), bl: f(quad.bl), br: f(quad.br) };
  }, [quad, scale]);

  const printCenterUV: [number, number] = useMemo(() => {
    if (!scaledQuad || !photoSize) return [0.5, 0.5];
    const cx = (scaledQuad.tl.x + scaledQuad.tr.x + scaledQuad.bl.x + scaledQuad.br.x) / 4 / photoSize.w;
    const cy = (scaledQuad.tl.y + scaledQuad.tr.y + scaledQuad.bl.y + scaledQuad.br.y) / 4 / photoSize.h;
    return [cx, cy];
  }, [scaledQuad, photoSize]);

  // CPU-side depth stats: normalize weak DAv2 contrast inside the active
  // print quad once per move/scale, rather than making every fragment guess
  // from global depth bytes. This makes the wrap slider feel consistent
  // across white studio shots, dark shirts, and wide full-body photos.
  const depthStats = useMemo(
    () => (depthResult.depth ? sampleDepthStats(depthResult.depth, scaledQuad) : { center: 0.5, range: 0.08 }),
    [depthResult.depth, scaledQuad]
  );

  // Per-image shading percentiles inside the pose quad. Drives slider
  // normalization — the wrinkle slider previously meant "DoG contrast
  // multiplier", which varies wildly across photos. After this remap it
  // means "fold strength fraction", consistent per-image. Keyed by `quad`
  // (shirt ROI) not `scaledQuad` — shading distribution is a property of
  // the SHIRT, independent of where the print sits inside it.
  const shadingStats = useMemo(
    () => (maps?.shading ? sampleShadingStats(maps.shading, quad) : { p10: 0.35, p90: 0.50, autoScale: 1.0 }),
    [maps, quad]
  );

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

  // Wrinkle-amplitude multiplier by garment darkness. Black tees read flatter
  // (lower DoG contrast even after A1 stretch and p10/p90 norm) so the same
  // SHADING_DROP_AMP_PX visually under-conforms on dark while over-warping on
  // light. Switched the metric from luminance to max(R,G,B): perceived
  // darkness, not BT.601 luminance. A royal-blue tee has meanLum≈85 (treated
  // as "dark" with 0.114 blue weight) but max(R,G,B)≈200 — the cloth shows
  // folds just fine and doesn't need a boost. max isolates *true* dark
  // (black / charcoal / navy: max < 80) from saturated mid-tones.
  const wrinkleDarkBoost = useMemo(() => {
    if (!garment) return 1.0;
    const maxRGB = Math.max(garment.rgb[0], garment.rgb[1], garment.rgb[2]);
    // Tighter breakpoint: anything with max ≥ 180 lands at the floor.
    // Royal-blue (max≈200) was still bending bottom bar at 0.64×; need
    // to crush it down to 0.4× to keep FOLD_GRAD under the V-bend
    // threshold. Navy / charcoal (max 60–90) still get a meaningful
    // boost via the steeper slope.
    const t = Math.max(0, Math.min(1, (maxRGB - 40) / 140));
    return 1.7 + t * (0.4 - 1.7); // 1.7 on true black → 0.4 on light/saturated
  }, [garment]);

  // Auto-tune lightStrength from the OVERLAP. White garments can take strong
  // multiply shadows; saturated red/blue/green garments need much weaker
  // default light because luminance underestimates their perceived brightness
  // and otherwise crushes the artwork.
  useEffect(() => {
    if (!garment) return;
    const meanLum = garment.rgb[0] * 0.299 + garment.rgb[1] * 0.587 + garment.rgb[2] * 0.114;
    const ls = autoLightStrength(garment);
    const maxRGB = Math.max(garment.rgb[0], garment.rgb[1], garment.rgb[2]);
    console.log(`[overlap] garmentMeanLum=${meanLum.toFixed(0)} maxRGB=${maxRGB.toFixed(0)} → lightStrength=${ls.toFixed(2)}`);
    setLightStrength(ls);
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
  const perf = usePerfMetrics(drag.dragging);

  // Mouse-wheel / trackpad-pinch resize on the canvas. Bound via
  // addEventListener with passive:false so we can preventDefault — React's
  // synthetic onWheel is passive by default and silently ignores the call.
  const stageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const dir = e.deltaY < 0 ? 1 : -1;
      setScale((s) => Math.max(0.4, Math.min(2.0, s * (1 + dir * 0.05))));
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []);

  const ready =
    status === 'ready' && photoTex && patternTex && displaceTex && wrinkleDisplaceTex && lightTex && shadingTex && scaledQuad && photoSize;

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

  // Spinner lifecycle: spin only while there is actual async work — the
  // photo-parse pipeline, or applying a freshly-picked pattern. Once the
  // model is parsed and we're just idling until the user picks a pattern,
  // the spinner stops and we show a calm prompt instead.
  const failed = status === 'fail';
  const parsing = status === 'loading' || status === 'pose' || status === 'maps';
  const awaitingPattern = status === 'ready' && !patternSrc;
  const applyingPattern = status === 'ready' && !!patternSrc && !ready;
  const spinnerText = parsing
    ? status === 'loading'
      ? '加载图片…'
      : status === 'pose'
        ? '识别人体姿态…'
        : '派生光影 + 位移图…'
    : '应用图案…';
  const stepIndex = status === 'loading' ? 0 : status === 'pose' ? 1 : 2;

  return (
    <main className={s.page} data-displace-status={status} data-depth-state={depthResult.state} data-hair-state={hairResult.state} data-photo-src={photoSrc ?? ''}>
      <header className={s.topbar}>
        <div className={s.pickerCol}>
          <PhotoPicker current={photoSrc} onPick={pickPhoto} />
        </div>
        <div className={s.pickerCol}>
          <PatternPicker current={patternSrc} onPick={setPatternSrc} />
        </div>
      </header>

      <div className={s.workspace}>
        <aside className={s.leftRail}>
          <SourcePreview photoSrc={photoSrc} patternSrc={patternSrc} />
        </aside>

        <div className={s.stage}>
          {!photoSrc && <div className={s.empty}>选个模特图开始</div>}
          {photoSrc && !ready && failed && (
            <div className={`${s.loadingText} ${s.loadingFail}`}>未识别到人体</div>
          )}
          {photoSrc && !ready && !failed && awaitingPattern && (
            <div className={s.empty}>模特图已就绪 · 选一张图案</div>
          )}
          {photoSrc && !ready && !failed && (parsing || applyingPattern) && (
            <div className={s.loading}>
              <div className={s.spinner} aria-hidden />
              <div className={s.loadingText}>{spinnerText}</div>
              {parsing && (
                <div className={s.steps}>
                  {['加载', '姿态', '光影'].map((label, i) => (
                    <span
                      key={label}
                      className={`${s.step} ${i < stepIndex ? s.stepDone : ''} ${
                        i === stepIndex ? s.stepActive : ''
                      }`}
                    >
                      {label}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
          {ready && (
            <div
              ref={stageRef}
              className={s.canvasFrame}
              style={{ aspectRatio: `${aspect}`, cursor: drag.dragging ? 'grabbing' : 'grab' }}
              onPointerDown={drag.onPointerDown}
              onPointerMove={drag.onPointerMove}
              onPointerUp={drag.onPointerUp}
              onPointerCancel={drag.onPointerUp}
              onPointerEnter={() => setHoverStage(true)}
              onPointerLeave={() => setHoverStage(false)}
            >
              <DisplaceCanvas
                photoTex={photoTex}
                patternTex={patternTex}
                displaceTex={displaceTex}
                wrinkleDisplaceTex={wrinkleDisplaceTex}
                lightTex={lightTex}
                shadingTex={shadingTex}
                photoSize={photoSize}
                quad={scaledQuad}
                strength={strength}
                dispSign={1}
                depthWrap={depthWrap}
                wrinkleStrength={shadingTex ? wrinkleDepthStrength * shadingStats.autoScale * wrinkleDarkBoost : 0}
                shadingP10={shadingStats.p10}
                shadingP90={shadingStats.p90}
                zCenter={depthStats.center}
                zRange={depthStats.range}
                printCenterUV={printCenterUV}
                envRGB={envRGB}
                garmentRGB={garmentRGB}
                hairTex={hairTex}
                tint={tint}
                sceneBrightness={sceneBrightness}
                lift={lift}
                lightStrength={light}
                debugMode={debug}
                renderKey={`${photoSrc ?? ''}|${patternSrc ?? ''}`}
              />
              {quad && (
                <div
                  className={`${s.handles} ${
                    hoverStage || drag.dragging ? s.handlesShown : ''
                  }`}
                >
                  <QuadHandles
                    quad={quad}
                    scaledQuad={scaledQuad}
                    photoSize={photoSize}
                    scale={scale}
                    setScale={setScale}
                  />
                </div>
              )}
              {quad && !hoverStage && !drag.dragging && (
                <div className={s.editHint}>悬停可编辑印图</div>
              )}
            </div>
          )}
        </div>

        <aside className={s.rail}>
          <ControlRail
            scale={scale}
            setScale={setScale}
            light={light}
            setLight={setLightStrength}
            sceneBrightness={sceneBrightness}
            setSceneBrightness={setSceneBrightness}
            depthWrap={depthWrapStrength}
            setDepthWrap={setDepthWrapStrength}
            depthEnabled={!!depthTex}
            wrinkle={wrinkleDepthStrength}
            setWrinkle={setWrinkleDepthStrength}
            wrinkleEnabled={!!shadingTex}
            debug={debug}
            setDebug={setDebugMode}
          />
          <PerfPanel metrics={perf} />
        </aside>
      </div>
    </main>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { POSE_INDEX, detectPoseCached, readCachedPose, type PoseLandmark } from '../poseDetector';
import { measureClothWidthAtRow } from '../shading/measureClothWidth';
import {
  quadFromLandmarks, sampleGarment, sampleScene,
  type GarmentSample, type Quad, type SceneSample,
} from '../shading';
import ControlRail from '../displace/ControlRail';
import type { DebugMode } from '../displace/DisplaceCanvas';
import { deriveMaps, type DerivedMaps } from '../displace/MapPipeline';
import PatternPicker from '../displace/PatternPicker';
import PerfPanel from '../displace/PerfPanel';
import PhotoPicker from '../displace/PhotoPicker';
import QuadHandles from '../displace/QuadHandles';
import ResultActions from '../displace/ResultActions';
import SourcePreview from '../displace/SourcePreview';
import { sampleDepthStats } from '../displace/depthStats';
import { recordStage, resetParse } from '../displace/perfBus';
import { sampleShadingStats } from '../displace/shadingStats';
import { loadImage } from '../displace/textures';
import { useClothMask } from '../displace/useClothMask';
import { useDepthMap } from '../displace/useDepthMap';
import { useHairMask } from '../displace/useHairMask';
import { usePerfMetrics } from '../displace/usePerfMetrics';
import { useQuadDrag } from '../displace/useQuadDrag';
import CanvasKitStage from './CanvasKitStage';
import { sampleLightStats, softenLightMap } from './lightStats';
import { buildPhotoLowPass } from './photoLowPass';
import s from '../displace/DisplacePage.module.css';

type LoadState = 'idle' | 'loading' | 'pose' | 'maps' | 'ready' | 'fail';

const garmentMemCache = new Map<string, GarmentSample>();
const sceneMemCache = new Map<string, SceneSample>();

// Fold-lighting target (2026-05-19 redesign — replaces the un-exhaustible
// per-garment-COLOR autoLightStrength). Tune a TARGET, not a strength:
//   foldKBase = TARGET_K_BASE × slider × SNR-confidence; the closed-loop
//   residual is then solved + applied in CanvasKitStage (one shot/photo).
// Garment/pattern color is absorbed by the shader's headroom rolloff, photo
// lighting intensity by lightStats.spread, signal trust by .confidence —
// see lightStats.ts. /displace keeps its own tuning (memory: only /canvaskit).
// 2026-05-20 LATE: restored to 0.55/0.18 (original closed-loop values).
// The earlier 0.55→0.38 / 0.18→0.12 lowering was driven by a "lighting
// carries over between patterns" report, but the real cause turned out to
// be the renderKey-on-patternSrc bug (fixed separately by keying on
// patternImg.src). Lowering these knobs was a band-aid that flattened the
// auto-shadow effect — user wants that effect back; the renderKey fix is
// what actually solves the carryover.
const TARGET_K_BASE = 0.55; // deepest trusted fold darkens a bright pixel ≤55%
const BLACK_MARGIN = 0.2; // pattern pixels below this (max channel) can't darken
// Closed-loop target: CanvasKitStage measures the printed region and pulls
// its perceptual contrast toward this fixed value. This is what makes "not
// too strong / not too weak" hold on the un-exhaustible garment×pattern×
// light space — it's measured on the real output, not guessed from color.
const TARGET_CONTRAST = 0.18; // desired printed-region perceptual P90−P10

export default function CanvasKitPage() {
  const [photoSrc, setPhotoSrc] = useState<string | null>(null);
  const [patternSrc, setPatternSrc] = useState<string | null>(null);
  const [hoverStage, setHoverStage] = useState(false);
  const [photo, setPhoto] = useState<HTMLImageElement | null>(null);
  const [patternImg, setPatternImg] = useState<HTMLImageElement | null>(null);
  const [quad, setQuad] = useState<Quad | null>(null);
  const [maps, setMaps] = useState<DerivedMaps | null>(null);
  const [status, setStatus] = useState<LoadState>('idle');
  // Pose landmarks lifted to state so cloth-mask-ready can trigger a quad
  // re-derive (with garment-width sizing) without rerunning pose detection
  // or the maps pipeline.
  const [poseLm, setPoseLm] = useState<PoseLandmark[] | null>(null);

  const [scale, setScale] = useState(1.0);
  const [light, setLight] = useState(1.0);
  const [sceneBrightness, setSceneBrightness] = useState(1.0);
  const [depthWrap, setDepthWrap] = useState(1.0);
  const [wrinkle, setWrinkle] = useState(0);
  const [smoothWarp, setSmoothWarp] = useState(0.4);
  const [debug, setDebug] = useState<DebugMode>('composite');
  // Freq-sep mode bypasses the fold-light pipeline entirely; see
  // photoLowPass.ts. Default off so the legacy path is the baseline; user
  // flips it to compare against the Doraemon-style reference.
  const [freqSep, setFreqSep] = useState(false);
  const lift = 0.0;
  const tint = 0.5;

  useEffect(() => {
    if (!photoSrc) return;
    let cancelled = false;
    (async () => {
      setStatus('loading');
      setPhoto(null);
      setQuad(null);
      setMaps(null);
      setPoseLm(null);
      resetParse(performance.now());
      try {
        const tLoad = performance.now();
        const img = await loadImage(photoSrc);
        if (cancelled) return;
        recordStage('load', performance.now() - tLoad, 'compute');
        setPhoto(img);
        setStatus('pose');
        const poseCached = !!readCachedPose(photoSrc);
        const tPose = performance.now();
        let lm: PoseLandmark[] | null = null;
        try {
          lm = await detectPoseCached(img, photoSrc);
        } catch (e) {
          console.warn('[canvaskit] pose fail', e);
        }
        if (cancelled) return;
        recordStage('pose', performance.now() - tPose, poseCached ? 'localStorage' : 'compute');
        const q = lm ? quadFromLandmarks(lm, img.naturalWidth, img.naturalHeight) : null;
        setPoseLm(lm);
        setQuad(q);
        setStatus('maps');
        const tMaps = performance.now();
        const derived = await deriveMaps(img, q, photoSrc);
        if (cancelled) return;
        recordStage('maps', performance.now() - tMaps, 'compute');
        setMaps(derived);
        setStatus(q ? 'ready' : 'fail');
      } catch (e) {
        console.warn('[canvaskit]', e);
        if (!cancelled) setStatus('fail');
      }
    })();
    return () => { cancelled = true; };
  }, [photoSrc]);

  useEffect(() => {
    if (!patternSrc) { setPatternImg(null); return; }
    let cancelled = false;
    loadImage(patternSrc)
      .then((img) => !cancelled && setPatternImg(img))
      .catch((e) => console.warn('[canvaskit] pattern load fail', e));
    return () => { cancelled = true; };
  }, [patternSrc]);

  const depthResult = useDepthMap(photo, photoSrc);
  const hairResult = useHairMask(photo, photoSrc);
  const clothResult = useClothMask(photo, photoSrc);

  // Cloth-mask sizing: re-derive quad using GARMENT width once the mask is
  // ready, so the print is a constant fraction of the visible shirt instead
  // of shoulder span (matters for oversized tees + photos at different
  // distances). One-shot rescale per photo.
  useEffect(() => {
    if (!poseLm || !photo || !clothResult.cloth) return;
    const ls = poseLm[POSE_INDEX.leftShoulder];
    const rs = poseLm[POSE_INDEX.rightShoulder];
    if (!ls || !rs) return;
    const photoW = photo.naturalWidth;
    const photoH = photo.naturalHeight;
    const midShoulderY = ((ls.y + rs.y) / 2) * photoH;
    const shoulderLenPx = Math.hypot((ls.x - rs.x) * photoW, (ls.y - rs.y) * photoH);
    const sampleY = midShoulderY + shoulderLenPx * 0.1;
    const clothW = measureClothWidthAtRow(clothResult.cloth, sampleY);
    if (clothW <= 0) return;
    setQuad(quadFromLandmarks(poseLm, photoW, photoH, undefined, clothW));
  }, [poseLm, photo, clothResult.cloth]);

  const photoSize = useMemo(
    () => (photo ? { w: photo.naturalWidth, h: photo.naturalHeight } : null),
    [photo]
  );
  const aspect = photoSize ? photoSize.w / photoSize.h : 0.667;
  const patternAspect = useMemo(
    () => (patternImg ? patternImg.naturalWidth / patternImg.naturalHeight : 1.0),
    [patternImg]
  );

  const scaledQuad = useMemo<Quad | null>(() => {
    if (!quad) return null;
    const cx = (quad.tl.x + quad.tr.x + quad.bl.x + quad.br.x) / 4;
    const cy = (quad.tl.y + quad.tr.y + quad.bl.y + quad.br.y) / 4;
    const f = (pt: { x: number; y: number }) => ({ x: cx + (pt.x - cx) * scale, y: cy + (pt.y - cy) * scale });
    return { tl: f(quad.tl), tr: f(quad.tr), bl: f(quad.bl), br: f(quad.br) };
  }, [quad, scale]);

  const printCenterUV = useMemo<[number, number]>(() => {
    if (!scaledQuad || !photoSize) return [0.5, 0.5];
    const cx = (scaledQuad.tl.x + scaledQuad.tr.x + scaledQuad.bl.x + scaledQuad.br.x) / 4 / photoSize.w;
    const cy = (scaledQuad.tl.y + scaledQuad.tr.y + scaledQuad.bl.y + scaledQuad.br.y) / 4 / photoSize.h;
    return [cx, cy];
  }, [scaledQuad, photoSize]);

  const depthStats = useMemo(
    () => (depthResult.depth ? sampleDepthStats(depthResult.depth, scaledQuad) : { center: 0.5, range: 0.08 }),
    [depthResult.depth, scaledQuad]
  );
  const smoothCenter = useMemo(
    () => (maps?.smooth ? sampleDepthStats(maps.smooth, scaledQuad).center : 0.0),
    [maps, scaledQuad]
  );
  const shadingStats = useMemo(
    () => (maps?.shading ? sampleShadingStats(maps.shading, quad) : { p10: 0.35, p90: 0.5, autoScale: 1.0 }),
    [maps, quad]
  );

  const garment: GarmentSample | null = useMemo(() => {
    if (!photo || !quad || !photoSrc) return null;
    const c = garmentMemCache.get(photoSrc);
    if (c) return c;
    const fresh = sampleGarment(photo, quad);
    garmentMemCache.set(photoSrc, fresh);
    return fresh;
  }, [photo, quad, photoSrc]);

  const sceneSample: SceneSample | null = useMemo(() => {
    if (!photo || !photoSrc) return null;
    const c = sceneMemCache.get(photoSrc);
    if (c) return c;
    const fresh = sampleScene(photo, quad);
    sceneMemCache.set(photoSrc, fresh);
    return fresh;
  }, [photo, photoSrc, quad]);

  const envRGB = useMemo<[number, number, number]>(
    () => (sceneSample ? [sceneSample.rgb[0] / 255, sceneSample.rgb[1] / 255, sceneSample.rgb[2] / 255] : [0.5, 0.5, 0.5]),
    [sceneSample]
  );
  const garmentRGB = useMemo<[number, number, number]>(
    () => (garment ? [garment.rgb[0] / 255, garment.rgb[1] / 255, garment.rgb[2] / 255] : [0.5, 0.5, 0.5]),
    [garment]
  );
  const wrinkleDarkBoost = useMemo(() => {
    if (!garment) return 1.0;
    const maxRGB = Math.max(garment.rgb[0], garment.rgb[1], garment.rgb[2]);
    return 1.7 + Math.max(0, Math.min(1, (maxRGB - 40) / 140)) * (0.4 - 1.7);
  }, [garment]);

  // /canvaskit-only softened light map (see softenLightMap): hard bimodal
  // body-shadow → gentle gradient so white prints read natural, not dirty.
  // Built once per photo. /displace keeps maps.light raw (untouched).
  const softLight = useMemo(
    () => (maps?.light ? softenLightMap(maps.light) : null),
    [maps]
  );
  // Photo low-pass for frequency-separation compositing. 0.5% min-dim ≈ 5 px
  // — just above fabric-grain scale so HIGH contains ONLY grain; everything
  // bigger (folds, shading, body curvature) lives in LOW and gets cleanly
  // replaced by the pattern. See photoLowPass.ts header for the rationale
  // (the radius is INTUITIVELY backwards from what "low-pass radius for
  // freq-sep" sounds like — small R = clean print). Built once per photo,
  // cost is one canvas blur ~5 ms on a 1200-px photo.
  const photoLow = useMemo(
    () => (photo ? buildPhotoLowPass(photo, 0.005) : null),
    [photo]
  );
  // Normalizers 1 + 3 — measured on the SOFTENED light map the shader reads
  // (consistency), cloth-gated. Recomputes on quad like shadingStats.
  const lightStats = useMemo(
    () => (softLight ? sampleLightStats(softLight, clothResult.cloth, quad)
                     : { spread: 0.12, confidence: 1 }),
    [softLight, clothResult.cloth, quad]
  );
  // `light` slider is a scene-independent perceptual fold-contrast TARGET
  // multiplier (default 1.0), not a raw strength. Garment/pattern color is
  // absorbed per-pixel in-shader (headroom rolloff); .confidence zeroes out
  // noise-only dark cloth. CanvasKitStage closes the loop on the MEASURED
  // output, pulling foldKBase toward targetContrast (once per photo/pattern).
  const foldKBase = TARGET_K_BASE * light * lightStats.confidence;

  const drag = useQuadDrag(quad, setQuad, photoSize);
  const perf = usePerfMetrics(drag.dragging);

  const stageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const dir = e.deltaY < 0 ? 1 : -1;
      setScale((v) => Math.max(0.4, Math.min(3, v * (1 + dir * 0.05))));
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []);
  const getCanvas = useCallback(() => stageRef.current?.querySelector('canvas') ?? null, []);

  const ready =
    status === 'ready' && !!photo && !!patternImg && !!photoSize && !!scaledQuad &&
    !!maps && depthResult.state === 'ready' && !!depthResult.depth && !!depthResult.depthFine &&
    !!photoLow;

  const failed = status === 'fail';
  const parsing = status === 'loading' || status === 'pose' || status === 'maps';
  const awaitingPattern = status === 'ready' && !patternSrc;
  const applyingPattern = status === 'ready' && !!patternSrc && !ready;
  const spinnerText = parsing
    ? status === 'loading' ? '加载图片…' : status === 'pose' ? '识别人体姿态…' : '派生光影 + 位移图…'
    : '应用图案…';
  const stepIndex = status === 'loading' ? 0 : status === 'pose' ? 1 : 2;

  const pickPhoto = (src: string) => {
    setPhoto(null);
    setQuad(null);
    setMaps(null);
    setPhotoSrc(src);
  };

  return (
    <main
      className={s.page}
      data-ck-status={status}
      data-depth-state={depthResult.state}
      data-hair-state={hairResult.state}
      data-cloth-state={clothResult.state}
      data-photo-src={photoSrc ?? ''}
    >
      <header className={s.topbar}>
        <div className={s.pickerCol}><PhotoPicker current={photoSrc} onPick={pickPhoto} /></div>
        <div className={s.pickerCol}><PatternPicker current={patternSrc} onPick={setPatternSrc} /></div>
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
                      className={`${s.step} ${i < stepIndex ? s.stepDone : ''} ${i === stepIndex ? s.stepActive : ''}`}
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
              <CanvasKitStage
                photo={photo!}
                patternImg={patternImg!}
                quad={scaledQuad!}
                photoSize={photoSize!}
                macroCanvas={depthResult.depth!}
                smoothCanvas={maps!.smooth}
                shadingCanvas={maps!.shading}
                lightCanvas={softLight ?? maps!.light}
                fineCanvas={depthResult.depthFine!}
                hairCanvas={hairResult.hair}
                clothCanvas={clothResult.cloth}
                photoLowCanvas={photoLow!}
                freqSep={freqSep}
                patternAspect={patternAspect}
                strength={1.0}
                dispSign={1}
                depthWrap={depthResult.depth ? depthWrap : 0}
                wrinkleStrength={maps ? wrinkle * shadingStats.autoScale * wrinkleDarkBoost : 0}
                smoothWarp={maps?.smooth ? smoothWarp : 0}
                smoothCenter={smoothCenter}
                zCenter={depthStats.center}
                shadingP10={shadingStats.p10}
                shadingP90={shadingStats.p90}
                printCenterUV={printCenterUV}
                envRGB={envRGB}
                garmentRGB={garmentRGB}
                tint={tint}
                sceneBrightness={sceneBrightness}
                lift={lift}
                foldKBase={foldKBase}
                targetContrast={TARGET_CONTRAST}
                foldSpread={lightStats.spread}
                blackMargin={BLACK_MARGIN}
                debugMode={debug}
                renderKey={`${photoSrc ?? ''}|${patternImg?.src ?? ''}`}
              />
              {quad && (
                <div className={`${s.handles} ${hoverStage || drag.dragging ? s.handlesShown : ''}`}>
                  <QuadHandles
                    quad={quad}
                    scaledQuad={scaledQuad!}
                    photoSize={photoSize!}
                    scale={scale}
                    setScale={setScale}
                  />
                </div>
              )}
              {quad && !hoverStage && !drag.dragging && (
                <div className={s.editHint}>悬停可编辑印图</div>
              )}
              <ResultActions getCanvas={getCanvas} />
            </div>
          )}
        </div>

        <aside className={s.rail}>
          <ControlRail
            scale={scale}
            setScale={setScale}
            light={light}
            setLight={setLight}
            sceneBrightness={sceneBrightness}
            setSceneBrightness={setSceneBrightness}
            depthWrap={depthWrap}
            setDepthWrap={setDepthWrap}
            depthEnabled={!!depthResult.depth}
            wrinkle={wrinkle}
            setWrinkle={setWrinkle}
            wrinkleEnabled={!!maps}
            smooth={smoothWarp}
            setSmooth={setSmoothWarp}
            freqSep={freqSep}
            setFreqSep={setFreqSep}
            smoothEnabled={!!maps?.smooth}
            debug={debug}
            setDebug={setDebug}
          />
          <PerfPanel metrics={perf} />
        </aside>
      </div>
    </main>
  );
}

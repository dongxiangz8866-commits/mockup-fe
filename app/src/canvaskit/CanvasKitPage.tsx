import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { POSE_INDEX, detectPoseCached, readCachedPose, type PoseLandmark } from '../poseDetector';
import { measureClothWidthAtRow } from '../shading/measureClothWidth';
import {
  quadFromLandmarks, sampleGarment, sampleScene,
  type GarmentSample, type Quad, type SceneSample,
} from '../shading';
import ControlRail from '../displace/ControlRail';
import type { DebugMode } from '../displace/DisplaceCanvas';
import { buildLumaLight } from '../displace/lumaDisplace';
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
import s from '../displace/DisplacePage.module.css';

// dispSource = 'depth' → 默认 /canvaskit:全套 canvaskit(depth radial wrap +
//                         maps.smooth fold-into-z + softenLightMap(maps.light)
//                         作 light)。
//            = 'luma'  → /canvaskit-gradient:贴合(mesh warp/macro/smooth)、
//                         shading、fineCanvas 全部保留 canvaskit 原样,
//                         唯一替换 light 源为 ImageMagick 端口 buildLumaLight
//                         —— 这是 /gradient 表达"褶皱"的来源(乘性暗化产生
//                         印图上的 fold 暗带)。
//
// 历史教训:
// • 第一版把 macro 换成 buildLumaDisplace → zCenter 在 luma form 上跟身体真
//   曲面无关 → 贴合飞 + 闭环 residual 推到 2.5 → 局部褶皱过深。
// • 第二版把 smooth 换成 buildLumaFold → DoG band 高对比 / 高频,32 mesh
//   顶点采样邻近顶点 push 差异大 → 印图矩形被撕成锯齿边(memory:FOLD_W=0
//   那条坑的同型号)。
// • 当前(第三版):仅替换 light 通道源 — mesh warp 完全不动 → 贴合 = canvaskit。
type DispSource = 'depth' | 'luma';

// buildLumaLight 在 trusted-dark 像素(高 SNR 但灰度很低)经过 sigmoid+2× clamp
// 会出硬黑斑(memory: 局部 L≈0 → printed=rgb·0 → 印图变暗斑)。
// 解法:更激进的 blur (3% min(w,h)) 把硬黑斑磨成 gentle gradient — 比
// canvaskit 默认的 softenLightMap (1.2%) 更重,把 lumaLight 的 sigmoid 高对比
// 推到不再产生黑斑的水平,但保留 fold-scale 的明暗趋势。
function softenLumaLight(raw: HTMLCanvasElement): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = raw.width;
  out.height = raw.height;
  const r = Math.max(4, Math.round(Math.min(raw.width, raw.height) * 0.03));
  const ctx = out.getContext('2d')!;
  ctx.filter = `blur(${r}px)`;
  ctx.drawImage(raw, 0, 0);
  return out;
}

// Module-level cache:buildLumaLight + softenLumaLight 是 full-frame
// getImageData + 多次 canvas blur,拖拽会重渲染。每张 photo+cloth-presence
// 缓存一次。
const lumaLightMemCache = new Map<string, HTMLCanvasElement>();

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
const TARGET_K_BASE = 0.55; // deepest trusted fold darkens a bright pixel ≤55%
const BLACK_MARGIN = 0.2; // pattern pixels below this (max channel) can't darken
// Closed-loop target: CanvasKitStage measures the printed region and pulls
// its perceptual contrast toward this fixed value. This is what makes "not
// too strong / not too weak" hold on the un-exhaustible garment×pattern×
// light space — it's measured on the real output, not guessed from color.
const TARGET_CONTRAST = 0.18; // desired printed-region perceptual P90−P10

export default function CanvasKitPage({ dispSource = 'depth' }: { dispSource?: DispSource } = {}) {
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

  // luma 模式专用:ImageMagick LIGHT port(FORM 圆柱阴影 + FOLD CLAHE 折叠
  // 阴影,sigmoid+2× only-darken)→ softenLumaLight(3% blur)化掉硬黑斑。
  const lumaSoftLight = useMemo<HTMLCanvasElement | null>(() => {
    if (dispSource !== 'luma' || !photo || !photoSrc) return null;
    const key = `${photoSrc}|${clothResult.cloth ? 'm' : 'n'}`;
    const cached = lumaLightMemCache.get(key);
    if (cached) return cached;
    const built = softenLumaLight(buildLumaLight(photo, clothResult.cloth ?? null));
    lumaLightMemCache.set(key, built);
    return built;
  }, [dispSource, photo, photoSrc, clothResult.cloth]);

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
  // /canvaskit-gradient 的核心替换:depth 模式用 softLight (canvaskit 原),
  // luma 模式用 lumaSoftLight (ImageMagick LIGHT port + 重 blur) —— 这就是
  // "复制 canvaskit 内容,褶皱用 imagemagick"的落点:fold 阴影来源从 DoG of
  // photo (maps.light) 换成 ImageMagick CLAHE 派生的 fold-light,印图视觉上
  // 的"褶皱暗带"换风格。下游 sampleLightStats/lightCanvas 都看 effLight,
  // 闭环 residual 测的也是这个 light 作用后的实际印图对比,自动校准。
  const effLight = dispSource === 'luma' ? lumaSoftLight : softLight;
  // Normalizers 1 + 3 — measured on the SAME light map the shader reads
  // (consistency), cloth-gated. Recomputes on quad like shadingStats.
  const lightStats = useMemo(
    () => (effLight ? sampleLightStats(effLight, clothResult.cloth, quad)
                    : { spread: 0.12, confidence: 1 }),
    [effLight, clothResult.cloth, quad]
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

  // 两种模式都依赖 DAv2 depth(macro);luma 模式额外要 lumaSoftLight 就绪。
  const sourceReady =
    depthResult.state === 'ready' && !!depthResult.depth && !!depthResult.depthFine &&
    (dispSource !== 'luma' || !!lumaSoftLight);
  const ready =
    status === 'ready' && !!photo && !!patternImg && !!photoSize && !!scaledQuad &&
    !!maps && sourceReady;

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
                lightCanvas={effLight ?? maps!.light}
                fineCanvas={depthResult.depthFine!}
                hairCanvas={hairResult.hair}
                clothCanvas={clothResult.cloth}
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
                renderKey={`${photoSrc ?? ''}|${patternSrc ?? ''}`}
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

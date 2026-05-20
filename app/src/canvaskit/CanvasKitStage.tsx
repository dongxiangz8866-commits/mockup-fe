import type { CanvasKit, Image } from 'canvaskit-wasm';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { DebugMode } from '../displace/DisplaceCanvas';
import { recordPrint } from '../displace/perfBus';
import { rasterizePattern } from '../displace/textures';
import type { Quad } from '../shading';
import { buildMesh } from './buildMesh';
import { getCanvasKit } from './canvasKitLoader';
import {
  blackFallback, clothAlphaCanvas, imageChannel, toChannel, whiteFallback,
} from './ckSources';
import { measurePrintedContrast, renderCanvasKit } from './renderCanvasKit';

const MAX_DIM = 1800; // backing-store cap (DAv2 maps are ~518 upsampled)
const K_RES_MIN = 0.2; // closed-loop residual clamp (foldK pull-down floor)
const K_RES_MAX = 2.5; // … and boost ceiling for genuinely-flat cloth
// Hard ceiling on the EFFECTIVE foldK reaching the shader. Restored to 0.85
// (2026-05-20 LATE) after the brief 0.55 lowering proved to flatten shadows.
// The cap exists for the white-shirt + white-pattern degenerate case where
// lightStats.spread saturates at MIN_SPREAD and a tiny chin-shadow can hit
// depth=1; 0.85 still bounds that worst case (mult ≈ 0.15, visible shadow
// not blackout) while letting deep folds darken legitimately on photos
// where the auto-calibration legitimately wants strong fold-light.
const FOLDK_MAX = 0.85;
const DBG: Record<DebugMode, number> = {
  composite: 0, displace: 1, light: 2, shading: 3,
  fine: 4, foldGrad: 5, cloth: 6, smoothField: 7,
};

type Props = {
  photo: HTMLImageElement;
  patternImg: HTMLImageElement;
  quad: Quad;
  photoSize: { w: number; h: number };
  macroCanvas: HTMLCanvasElement; // depth macro (also the debug-1 source)
  smoothCanvas: HTMLCanvasElement;
  shadingCanvas: HTMLCanvasElement;
  lightCanvas: HTMLCanvasElement;
  fineCanvas: HTMLCanvasElement; // depth fine — debug-4 only
  hairCanvas: HTMLCanvasElement | null;
  clothCanvas: HTMLCanvasElement | null;
  photoLowCanvas: HTMLCanvasElement;
  freqSep: boolean;
  patternAspect: number;
  strength: number;
  dispSign: number;
  depthWrap: number;
  wrinkleStrength: number;
  smoothWarp: number;
  smoothCenter: number;
  zCenter: number;
  shadingP10: number;
  shadingP90: number;
  printCenterUV: [number, number];
  envRGB: [number, number, number];
  garmentRGB: [number, number, number];
  tint: number;
  sceneBrightness: number;
  lift: number;
  // foldK = foldKBase × closed-loop residual. Base = TARGET_K_BASE × slider ×
  // SNR-confidence (CanvasKitPage); the residual is solved HERE so the
  // correction is applied synchronously, not via a second React render.
  foldKBase: number;
  targetContrast: number;
  foldSpread: number;
  blackMargin: number;
  debugMode: DebugMode;
  renderKey: string;
};

export default function CanvasKitStage(p: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ck, setCk] = useState<CanvasKit | null>(null);
  const pendingSince = useRef<number | null>(null);
  const lastKey = useRef('');
  // Closed-loop residual cached per renderKey (photo|pattern). Drag/slider
  // keep the same key ⇒ reuse the residual, no re-measure, off the 60 fps path.
  const residualRef = useRef<{ key: string; r: number }>({ key: '', r: 1 });

  useEffect(() => {
    let on = true;
    getCanvasKit().then((k) => on && setCk(k)).catch((e) => console.error('[canvaskit] init', e));
    return () => { on = false; };
  }, []);

  if (p.renderKey !== lastKey.current) {
    lastKey.current = p.renderKey;
    pendingSince.current = performance.now();
  }

  const patternRaster = useMemo(() => rasterizePattern(p.patternImg), [p.patternImg]);
  const clothClip = useMemo(() => clothAlphaCanvas(p.clothCanvas), [p.clothCanvas]);
  const hairSrc = useMemo(() => p.hairCanvas ?? blackFallback(), [p.hairCanvas]);
  const clothSrc = useMemo(() => p.clothCanvas ?? whiteFallback(), [p.clothCanvas]);

  const imgs = useMemo(() => {
    if (!ck) return null;
    const m = (s: CanvasImageSource) => ck.MakeImageFromCanvasImageSource(s);
    return {
      pattern: m(patternRaster), photo: m(p.photo), light: m(p.lightCanvas),
      shading: m(p.shadingCanvas), smooth: m(p.smoothCanvas), displace: m(p.macroCanvas),
      fine: m(p.fineCanvas), hair: m(hairSrc), cloth: m(clothSrc), clothClip: m(clothClip),
      photoLow: m(p.photoLowCanvas),
    };
  }, [ck, patternRaster, p.photo, p.lightCanvas, p.shadingCanvas, p.smoothCanvas,
    p.macroCanvas, p.fineCanvas, hairSrc, clothSrc, clothClip, p.photoLowCanvas]);
  useEffect(() => {
    return () => {
      if (imgs) Object.values(imgs).forEach((i: Image) => i.delete());
    };
  }, [imgs]);

  const macroCh = useMemo(() => toChannel(p.macroCanvas), [p.macroCanvas]);
  const smoothCh = useMemo(() => toChannel(p.smoothCanvas), [p.smoothCanvas]);
  const shadingCh = useMemo(() => toChannel(p.shadingCanvas), [p.shadingCanvas]);
  const photoCh = useMemo(() => imageChannel(p.photo), [p.photo]);

  const scale = Math.min(1, MAX_DIM / Math.max(p.photoSize.w, p.photoSize.h));
  const cw = Math.round(p.photoSize.w * scale);
  const chh = Math.round(p.photoSize.h * scale);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !ck || !imgs) return;
    if (canvas.width !== cw || canvas.height !== chh) {
      canvas.width = cw;
      canvas.height = chh;
    }
    const mesh = buildMesh({
      quad: p.quad, photoW: p.photoSize.w, photoH: p.photoSize.h,
      macro: macroCh, smooth: smoothCh, shading: shadingCh, photo: photoCh,
      patternW: patternRaster.width, patternH: patternRaster.height,
      patternAspect: p.patternAspect, printCenterUV: p.printCenterUV,
      zCenter: p.zCenter, smoothCenter: p.smoothCenter, garmentRGB: p.garmentRGB,
      shadingP10: p.shadingP10, shadingP90: p.shadingP90, segments: 32,
      depthWrap: p.depthWrap, strength: p.strength, dispSign: p.dispSign,
      smoothWarp: p.smoothWarp, wrinkleStrength: p.wrinkleStrength,
    });
    const renderWith = (foldK: number, freqSep: boolean) =>
      renderCanvasKit({
        ck, canvas, mesh, photoW: p.photoSize.w, photoH: p.photoSize.h, surfaceScale: scale,
        patternImg: imgs.pattern, photoImg: imgs.photo, lightImg: imgs.light,
        shadingImg: imgs.shading, smoothImg: imgs.smooth, displaceImg: imgs.displace,
        fineImg: imgs.fine, hairImg: imgs.hair, clothClipImg: imgs.clothClip,
        clothImg: imgs.cloth, photoLowImg: imgs.photoLow,
        uniforms: {
          envRGB: p.envRGB, garmentRGB: p.garmentRGB, tint: p.tint,
          sceneBrightness: p.sceneBrightness, lift: p.lift, foldK,
          debugMode: DBG[p.debugMode], depthWrap: p.depthWrap,
          wrinkleStrength: p.wrinkleStrength, shadingP10: p.shadingP10, shadingP90: p.shadingP90,
          foldSpread: p.foldSpread, blackMargin: p.blackMargin,
          freqSep: freqSep ? 1 : 0,
        },
      });

    const cap = (k: number) => Math.min(FOLDK_MAX, k);
    const cached = residualRef.current.key === p.renderKey;

    if (cached) {
      // Drag / slider / freqSep-toggle path. Residual already calibrated
      // for this photo|pattern; render once with the user's freqSep choice.
      renderWith(cap(p.foldKBase * residualRef.current.r), p.freqSep);
    } else {
      // First time for this photo|pattern. PROBE with freqSep=OFF so the
      // closed-loop measurement isn't biased by grain noise — grain has
      // zero mean but raises P90−P10, which would otherwise make the loop
      // dial foldK DOWN whenever the user enables freq-sep (weakening the
      // auto-lighting). Probe + measure gives a freqSep-independent
      // residual; final render adds grain back on top of the right
      // fold-light intensity.
      renderWith(cap(p.foldKBase), false);
      const m = measurePrintedContrast(ck, canvas, p.quad, scale);
      const r =
        m >= 0
          ? Math.max(K_RES_MIN, Math.min(K_RES_MAX, p.targetContrast / Math.max(m, 1e-3)))
          : 1;
      residualRef.current = { key: p.renderKey, r };
      if (import.meta.env.DEV) {
        console.log(`[foldCalib] measured=${m.toFixed(3)} → residual=${r.toFixed(2)} → foldK=${cap(p.foldKBase * r).toFixed(2)}`);
      }
      // Re-render if residual changed OR if user wants freqSep (probe ran
      // with freqSep=false). Skip only when both are no-ops.
      if (Math.abs(r - 1) > 0.02 || p.freqSep) {
        renderWith(cap(p.foldKBase * r), p.freqSep);
      }
    }
    if (pendingSince.current != null) {
      recordPrint(performance.now() - pendingSince.current);
      pendingSince.current = null;
    }
  });

  return <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />;
}

import { useEffect, useMemo, useState } from 'react';
import { detectPoseCached, type PoseLandmark } from '../poseDetector';
import { quadFromLandmarks, sampleGarment, type GarmentSample, type Quad } from '../shading';

// Photo-keyed garment cache. sampleGarment is heavy (full-frame getImageData
// on a 2K photo = ~100 ms). Without this, dragging the print recomputed it on
// every quad change → 60 calls/s freeze the UI. Cached per src because the
// garment color is bound to the SHIRT (= photo), not to where the print sits
// on it; sampling-strip drift from quad re-pose is negligible vs the speed win.
const garmentMemCache = new Map<string, GarmentSample>();
import DisplaceCanvas, { type DebugMode } from './DisplaceCanvas';
import { deriveMaps, type DerivedMaps } from './MapPipeline';
import PhotoPicker from './PhotoPicker';
import { dataCanvasToTexture, loadImage } from './textures';
import { useDepthMap } from './useDepthMap';
import { useDisplaceTextures } from './useDisplaceTextures';
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
  const [ampPx, setAmpPx] = useState(10.0);
  const [light, setLightStrength] = useState(0.3);
  // bendDeg is TOTAL cylinder angular extent across the print, in degrees.
  // 0 = flat sticker (default — geometric wrap alone reads as "fish-eye
  // distortion" rather than "wrapped on body". The body-on-print integration
  // cues do the heavy lifting; the cylinder slider is here for experimentation
  // only). 30° is the strongest setting that still looks natural.
  const [bendDeg, setBendDeg] = useState(0);
  const [bodyShade, setBodyShade] = useState(0);
  const [tint, setTint] = useState(0.20);
  const [lift, setLift] = useState(0.05);
  const [depthWrapStrength, setDepthWrapStrength] = useState(5.0);
  const [reverseDisp, setReverseDisp] = useState(false);
  const [dispSource, setDispSource] = useState<DispSource>('depth');
  const [debug, setDebugMode] = useState<DebugMode>('composite');

  // Photo + pose + maps pipeline.
  useEffect(() => {
    if (!photoSrc) return;
    let cancelled = false;

    (async () => {
      setStatus('loading');
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

  // Stable garmentRGB tuple so the child's useEffect deps don't fire every
  // render with a new array reference.
  const garmentRGB: [number, number, number] = useMemo(
    () => (garment ? [garment.rgb[0] / 255, garment.rgb[1] / 255, garment.rgb[2] / 255] : [0.5, 0.5, 0.5]),
    [garment]
  );
  const drag = useQuadDrag(quad, setQuad, photoSize);
  const ready =
    status === 'ready' && photoTex && patternTex && displaceTex && lightTex && shadingTex && quad && photoSize;

  return (
    <main className={s.page}>
      <div className={s.toolbar}>
        <PhotoPicker current={photoSrc} onPick={setPhotoSrc} />
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
            幅度 <input type="range" min={0} max={20} step={0.5} value={ampPx}
              onChange={(e) => setAmpPx(Number(e.target.value))} />
            <span>{ampPx.toFixed(1)}px</span>
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
            光照 <input type="range" min={0} max={1} step={0.05} value={light}
              onChange={(e) => setLightStrength(Number(e.target.value))} />
            <span>{light.toFixed(2)}</span>
          </label>
          <label className={s.range}>
            色彩融合 <input type="range" min={0} max={0.5} step={0.02} value={tint}
              onChange={(e) => setTint(Number(e.target.value))} />
            <span>{tint.toFixed(2)}</span>
          </label>
          <label className={s.range}>
            黑度抬升 <input type="range" min={0} max={0.4} step={0.02} value={lift}
              onChange={(e) => setLift(Number(e.target.value))} />
            <span>{lift.toFixed(2)}</span>
          </label>
          <label className={s.range}>
            贴合强度 <input type="range" min={0} max={10} step={0.5} value={depthWrapStrength}
              onChange={(e) => setDepthWrapStrength(Number(e.target.value))}
              disabled={dispSource !== 'depth'} />
            <span>{depthWrapStrength.toFixed(1)}</span>
          </label>
          <label className={s.range}>
            圆柱角度 <input type="range" min={0} max={90} step={2} value={bendDeg}
              onChange={(e) => setBendDeg(Number(e.target.value))} />
            <span>{bendDeg}°</span>
          </label>
          <label className={s.range}>
            身体阴影 <input type="range" min={0} max={1} step={0.05} value={bodyShade}
              onChange={(e) => setBodyShade(Number(e.target.value))} />
            <span>{bodyShade.toFixed(2)}</span>
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
              ampPx={ampPx}
              dispSign={reverseDisp ? -1 : 1}
              depthWrap={depthWrap}
              zCenter={zCenter}
              printCenterUV={printCenterUV}
              halfAngle={(bendDeg / 2) * Math.PI / 180}
              bodyShade={bodyShade}
              garmentRGB={garmentRGB}
              tint={tint}
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

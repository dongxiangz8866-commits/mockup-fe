import { useEffect, useState } from 'react';
import { detectPoseCached, type PoseLandmark } from '../poseDetector';
import { quadFromLandmarks, type Quad } from '../shading';
import DisplaceCanvas, { type DebugMode } from './DisplaceCanvas';
import { deriveMaps, type DerivedMaps } from './MapPipeline';
import PhotoPicker from './PhotoPicker';
import { loadImage } from './textures';
import { useDisplaceTextures } from './useDisplaceTextures';
import { useQuadDrag } from './useQuadDrag';
import s from './DisplacePage.module.css';

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

  const { photoTex, patternTex, displaceTex, lightTex, shadingTex } =
    useDisplaceTextures(photo, patternImg, maps);

  const photoSize = photo ? { w: photo.naturalWidth, h: photo.naturalHeight } : null;
  const aspect = photoSize ? photoSize.w / photoSize.h : 0.667;
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
            光照 <input type="range" min={0} max={1} step={0.05} value={light}
              onChange={(e) => setLightStrength(Number(e.target.value))} />
            <span>{light.toFixed(2)}</span>
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
              lightStrength={light}
              debugMode={debug}
            />
          </div>
        )}
      </div>
    </main>
  );
}

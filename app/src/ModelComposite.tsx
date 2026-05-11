import { useEffect, useMemo, useRef } from 'react';
import { composeFrame, type FrameScratches } from './composeFrame';
import { getPattern, subscribePattern } from './textureStore';
import { useModelAssets } from './useModelAssets';

type Props = {
  src: string;
  foldStrength: number;
  onClick?: () => void;
  large?: boolean;
  zoom?: number;
};

// Standalone composite view for one model photo. Wires the asset hook (photo
// + pose + 4 maps) to the canvas-side compose pipeline (warp pattern + 4
// masked blends) and re-renders on pattern subscription ticks. The scratch
// canvas pool lives in refs so a pattern drag doesn't allocate full-res
// canvases each frame.
export default function ModelComposite({
  src,
  foldStrength,
  onClick,
  large = false,
  zoom = 1,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { photoRef, shadingRef, wideShadingRef, highlightRef, fabricRef, photoSize, quad, status } =
    useModelAssets(src);

  // Reused per-render scratch canvases — avoids 4 × full-res allocations per
  // pattern drag tick. Sized lazily inside composeFrame.
  const scratches = useRef<FrameScratches>({
    tmp: { current: null },
    shading: { current: null },
    wideShading: { current: null },
    highlight: { current: null },
    fabric: { current: null },
    bend: { current: null },
    edgeShadow: { current: null },
  }).current;

  const render = useMemo(() => {
    void foldStrength;
    return () => {
      const photo = photoRef.current;
      const cv = canvasRef.current;
      const pat = getPattern();
      if (!photo || !cv || !photoSize || !quad || !pat) {
        if (photo && cv && photoSize) {
          cv.width = photoSize.w;
          cv.height = photoSize.h;
          cv.getContext('2d')!.drawImage(photo, 0, 0);
        }
        return;
      }
      cv.width = photoSize.w;
      cv.height = photoSize.h;
      const ctx = cv.getContext('2d')!;
      composeFrame({
        ctx,
        cv,
        photo,
        pat,
        src,
        quad,
        foldStrength,
        maps: {
          shading: shadingRef.current,
          wideShading: wideShadingRef.current,
          highlight: highlightRef.current,
          fabric: fabricRef.current,
        },
        scratches,
      });
    };
  }, [src, quad, photoSize, foldStrength, photoRef, shadingRef, wideShadingRef, highlightRef, fabricRef, scratches]);

  useEffect(() => {
    render();
    return subscribePattern(render);
  }, [render]);

  const aspect = photoSize ? photoSize.w / photoSize.h : 0.667;
  const itemStyle: React.CSSProperties = large
    ? {
        aspectRatio: `${aspect}`,
        height: `${85 * (zoom ?? 1)}vh`,
        maxWidth: zoom && zoom > 1 ? undefined : '90vw',
      }
    : { flex: `${aspect} 1 0`, aspectRatio: `${aspect}` };

  return (
    <div
      className={`model-item ${large ? 'model-item-large' : ''}`}
      style={itemStyle}
      onClick={onClick}
      data-model-url={src}
      data-model-status={status}
    >
      <canvas ref={canvasRef} className="model-canvas" />
      {status !== 'ready' && (
        <span className={`model-tag tag-${status}`}>
          {status === 'loading' ? '加载中…' : status === 'pose' ? '识别姿态…' : '识别失败'}
        </span>
      )}
    </div>
  );
}

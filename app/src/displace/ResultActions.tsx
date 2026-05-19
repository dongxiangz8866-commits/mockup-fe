import { useCallback, useState } from 'react';
import r from './ResultActions.module.css';

type Props = {
  /** Returns the live WebGL canvas (preserveDrawingBuffer=true) or null. */
  getCanvas: () => HTMLCanvasElement | null;
};

type CopyState = 'idle' | 'ok' | 'fail';

function downloadCanvas(canvas: HTMLCanvasElement) {
  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png');
  a.download = `样机-${Date.now()}.png`;
  a.click();
}

// 放大 (lightbox at the canvas's native drawing-buffer resolution) + 复制
// (PNG to clipboard, download fallback). Capture works because DisplaceCanvas
// sets preserveDrawingBuffer:true, so the last rendered frame is still in the
// buffer when toDataURL/toBlob runs synchronously on click.
export default function ResultActions({ getCanvas }: Props) {
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [copy, setCopy] = useState<CopyState>('idle');

  const onZoom = useCallback(() => {
    const c = getCanvas();
    if (c) setLightbox(c.toDataURL('image/png'));
  }, [getCanvas]);

  const onCopy = useCallback(async () => {
    const c = getCanvas();
    if (!c) return;
    try {
      const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/png'));
      if (!blob) throw new Error('toBlob null');
      // ClipboardItem image write needs a secure context — localhost counts,
      // so dev/preview are fine; a non-HTTPS deploy falls to the download.
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      setCopy('ok');
    } catch {
      // No clipboard-image permission / insecure context → download instead
      // so the button is never a dead end.
      downloadCanvas(c);
      setCopy('fail');
    }
    setTimeout(() => setCopy('idle'), 1600);
  }, [getCanvas]);

  return (
    <div className={r.bar} onPointerDown={(e) => e.stopPropagation()}>
      <button type="button" className={r.btn} onClick={onZoom}>
        放大
      </button>
      <button type="button" className={r.btn} onClick={onCopy}>
        {copy === 'ok' ? '已复制' : copy === 'fail' ? '已下载' : '复制'}
      </button>
      {lightbox && (
        <div className={r.lightbox} onClick={() => setLightbox(null)} role="presentation">
          <img src={lightbox} alt="样机效果图" className={r.lightboxImg} />
        </div>
      )}
    </div>
  );
}

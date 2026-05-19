import { useCallback, useState } from 'react';
import r from './ResultActions.module.css';

type Props = {
  /** Returns the live WebGL canvas (preserveDrawingBuffer=true) or null. */
  getCanvas: () => HTMLCanvasElement | null;
};

type CopyState = 'idle' | 'ok' | 'fail';

const SVG = {
  width: 15,
  height: 15,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

// Maximize (arrows to opposite corners) — matches the action: open a
// full-resolution lightbox.
const ZoomIcon = () => (
  <svg {...SVG}>
    <polyline points="15 3 21 3 21 9" />
    <polyline points="9 21 3 21 3 15" />
    <line x1="21" y1="3" x2="14" y2="10" />
    <line x1="3" y1="21" x2="10" y2="14" />
  </svg>
);

const CopyIcon = () => (
  <svg {...SVG}>
    <rect x="9" y="9" width="13" height="13" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

// Copy succeeded.
const CheckIcon = () => (
  <svg {...SVG}>
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

// Clipboard unavailable → fell back to a PNG download.
const DownloadIcon = () => (
  <svg {...SVG}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
);

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
      <button type="button" className={r.btn} onClick={onZoom} title="放大" aria-label="放大">
        <ZoomIcon />
      </button>
      <button
        type="button"
        className={r.btn}
        onClick={onCopy}
        title={copy === 'ok' ? '已复制' : copy === 'fail' ? '已下载' : '复制'}
        aria-label={copy === 'ok' ? '已复制' : copy === 'fail' ? '已下载' : '复制'}
      >
        {copy === 'ok' ? <CheckIcon /> : copy === 'fail' ? <DownloadIcon /> : <CopyIcon />}
      </button>
      {lightbox && (
        <div className={r.lightbox} onClick={() => setLightbox(null)} role="presentation">
          <img src={lightbox} alt="样机效果图" className={r.lightboxImg} />
        </div>
      )}
    </div>
  );
}

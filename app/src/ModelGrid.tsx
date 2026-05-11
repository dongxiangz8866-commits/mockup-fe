import { useEffect, useState } from 'react';
import ModelComposite from './ModelComposite';
import { useModelUrls } from './shading';

const ZOOM_MIN = 0.4;
const ZOOM_MAX = 2.5;
const ZOOM_STEP = 0.2;

const clampZoom = (z: number) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, +z.toFixed(2)));

function ZoomControls({
  zoom,
  setZoom,
}: {
  zoom: number;
  setZoom: (updater: (z: number) => number) => void;
}) {
  return (
    <div className="model-modal-controls" onClick={(e) => e.stopPropagation()}>
      <button
        className="modal-zoom-btn"
        onClick={() => setZoom((z) => clampZoom(z - ZOOM_STEP))}
        aria-label="缩小"
        title="缩小"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <path d="M5 12h14" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
      </button>
      <span className="modal-zoom-value">{Math.round(zoom * 100)}%</span>
      <button
        className="modal-zoom-btn"
        onClick={() => setZoom((z) => clampZoom(z + ZOOM_STEP))}
        aria-label="放大"
        title="放大"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <path
            d="M5 12h14M12 5v14"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
        </svg>
      </button>
      <button className="modal-zoom-btn modal-zoom-reset" onClick={() => setZoom(() => 1)} title="重置">
        1×
      </button>
    </div>
  );
}

export default function ModelGrid() {
  const [foldStrength, setFoldStrength] = useState(2.0);
  const [selected, setSelected] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const photoUrls = useModelUrls();

  useEffect(() => {
    if (!selected) return;
    setZoom(1);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelected(null);
      else if (e.key === '+' || e.key === '=') setZoom((z) => clampZoom(z + ZOOM_STEP));
      else if (e.key === '-' || e.key === '_') setZoom((z) => clampZoom(z - ZOOM_STEP));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected]);

  return (
    <div className="model-grid-root">
      <div className="model-grid-toolbar">
        <span className="model-grid-title">真人模特</span>
        <div className="fold-control">
          <label htmlFor="grid-fold">褶皱强度</label>
          <input
            id="grid-fold"
            type="range"
            min={0}
            max={4}
            step={0.25}
            value={foldStrength}
            onChange={(e) => setFoldStrength(Number(e.target.value))}
          />
          <span className="fold-value">{foldStrength.toFixed(2)}</span>
        </div>
      </div>
      <div className="model-grid">
        {photoUrls.map((url) => (
          <ModelComposite
            key={url}
            src={url}
            foldStrength={foldStrength}
            onClick={() => setSelected(url)}
          />
        ))}
      </div>
      {selected && (
        <div
          className="model-modal"
          onClick={() => setSelected(null)}
          role="dialog"
          aria-modal="true"
        >
          <button
            className="model-modal-close"
            onClick={(e) => {
              e.stopPropagation();
              setSelected(null);
            }}
            aria-label="关闭"
          >
            ×
          </button>
          <div className="model-modal-scroll" onClick={(e) => e.stopPropagation()}>
            <div className="model-modal-content">
              <ModelComposite src={selected} foldStrength={foldStrength} large zoom={zoom} />
            </div>
          </div>
          <ZoomControls zoom={zoom} setZoom={setZoom} />
        </div>
      )}
    </div>
  );
}

import { useRef } from 'react';
import type { Quad } from '../shading';

// Bounding-frame overlay for the print quad: a polygon outline + four corner
// dots. Dragging a dot scales the print uniformly around the quad's center
// (same center the wheel-zoom uses, so both interactions stay consistent).
// The dragged corner travels along its own radial from center, with the
// radial projection of the cursor delta driving `setScale`.

const CORNERS = ['tl', 'tr', 'bl', 'br'] as const;
type Corner = (typeof CORNERS)[number];

type ResizeStart = {
  pointerId: number;
  startPx: number;
  startPy: number;
  startScale: number;
  baseDist: number;
  dirX: number;
  dirY: number;
};

type Props = {
  quad: Quad;
  scaledQuad: Quad;
  photoSize: { w: number; h: number };
  scale: number;
  setScale: (s: number) => void;
  min?: number;
  max?: number;
};

export default function QuadHandles({
  quad,
  scaledQuad,
  photoSize,
  scale,
  setScale,
  min = 0.4,
  max = 3,
}: Props) {
  const resizeRef = useRef<ResizeStart | null>(null);
  const handleR = photoSize.w / 60;

  const onDown = (e: React.PointerEvent<SVGCircleElement>, corner: Corner) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const cx = (quad.tl.x + quad.tr.x + quad.bl.x + quad.br.x) / 4;
    const cy = (quad.tl.y + quad.tr.y + quad.bl.y + quad.br.y) / 4;
    const c = quad[corner];
    const outX = c.x - cx;
    const outY = c.y - cy;
    const baseDist = Math.hypot(outX, outY) || 1;
    resizeRef.current = {
      pointerId: e.pointerId,
      startPx: e.clientX,
      startPy: e.clientY,
      startScale: scale,
      baseDist,
      dirX: outX / baseDist,
      dirY: outY / baseDist,
    };
  };

  const onMove = (e: React.PointerEvent<SVGCircleElement>) => {
    const r = resizeRef.current;
    if (!r) return;
    e.stopPropagation();
    const svg = e.currentTarget.ownerSVGElement;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0) return;
    const k = photoSize.w / rect.width;
    const dxPhoto = (e.clientX - r.startPx) * k;
    const dyPhoto = (e.clientY - r.startPy) * k;
    const along = dxPhoto * r.dirX + dyPhoto * r.dirY;
    const startDist = r.baseDist * r.startScale;
    const next = (startDist + along) / r.baseDist;
    setScale(Math.max(min, Math.min(max, next)));
  };

  const onUp = (e: React.PointerEvent<SVGCircleElement>) => {
    resizeRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const cursorFor: Record<Corner, string> = {
    tl: 'nwse-resize',
    br: 'nwse-resize',
    tr: 'nesw-resize',
    bl: 'nesw-resize',
  };

  return (
    <svg
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
      }}
      viewBox={`0 0 ${photoSize.w} ${photoSize.h}`}
      preserveAspectRatio="none"
    >
      <polygon
        points={`${scaledQuad.tl.x},${scaledQuad.tl.y} ${scaledQuad.tr.x},${scaledQuad.tr.y} ${scaledQuad.br.x},${scaledQuad.br.y} ${scaledQuad.bl.x},${scaledQuad.bl.y}`}
        fill="none"
        stroke="#4f46e5"
        strokeWidth={2}
        strokeDasharray="6 4"
        vectorEffect="non-scaling-stroke"
      />
      {CORNERS.map((c) => (
        <circle
          key={c}
          cx={scaledQuad[c].x}
          cy={scaledQuad[c].y}
          r={handleR}
          fill="#ffffff"
          stroke="#4f46e5"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
          style={{ cursor: cursorFor[c], pointerEvents: 'auto' }}
          onPointerDown={(e) => onDown(e, c)}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        />
      ))}
    </svg>
  );
}

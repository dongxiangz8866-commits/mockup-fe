import { useCallback, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { Quad } from '../shading';

// Whole-quad translation: pointer down captures the original quad + start
// pixel; pointer move computes a CSS-px → photo-px scaled delta and adds it
// to all four corners. The shader's quad uniforms re-bind on the next render
// so the print follows the cursor without rebuilding the displace/light
// maps (those are photo-aligned, independent of where the print sits).
//
// CSS-px → photo-px conversion uses the live element rect width so window
// resizes between drags don't desync. Same-frame drags are stable because
// the rect is read on every move event.

type DragStart = { px: number; py: number; quad: Quad };

export function useQuadDrag(
  quad: Quad | null,
  setQuad: (q: Quad) => void,
  photoSize: { w: number; h: number } | null
) {
  const startRef = useRef<DragStart | null>(null);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!quad) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      startRef.current = { px: e.clientX, py: e.clientY, quad };
    },
    [quad]
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const start = startRef.current;
      if (!start || !photoSize) return;
      // Self-heal: pointerup occasionally gets swallowed (Cmd+C, system
      // overlays). If no button is down, treat this move as end-of-drag.
      if (e.buttons === 0) {
        startRef.current = null;
        return;
      }
      const rect = e.currentTarget.getBoundingClientRect();
      if (rect.width <= 0) return;
      const k = photoSize.w / rect.width;
      const dx = (e.clientX - start.px) * k;
      const dy = (e.clientY - start.py) * k;
      setQuad({
        tl: { x: start.quad.tl.x + dx, y: start.quad.tl.y + dy },
        tr: { x: start.quad.tr.x + dx, y: start.quad.tr.y + dy },
        bl: { x: start.quad.bl.x + dx, y: start.quad.bl.y + dy },
        br: { x: start.quad.br.x + dx, y: start.quad.br.y + dy },
      });
    },
    [photoSize, setQuad]
  );

  const onPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      startRef.current = null;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    },
    []
  );

  const dragging = startRef.current !== null;

  return { onPointerDown, onPointerMove, onPointerUp, dragging };
}

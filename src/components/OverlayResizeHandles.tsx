// src/components/OverlayResizeHandles.tsx
// Phase UI: compact overlay resize handles. Renders 8 thin handles on the
// outer edges of the overlay window: 4 edges (n/s/e/w) + 4 corners (nw/ne/sw/se).
// Always visible (per user's UX choice). Mousedown → live resize via IPC →
// snap to screen edges on mouseup.
//
// The handles are children of the overlay shell (NativelyInterface.tsx), so
// they cover the OS-level window edges. The Electron BrowserWindow itself is
// already resizable=true (set in WindowHelper.ts) — these handles just give
// the user visible affordances + a smoother UX than relying on raw edge-drag.
//
// Render condition: only when the overlay is mounted. We don't gate by
// meeting-active state because the launcher + non-meeting panels also use
// the overlay window. The parent component decides when to mount this.

import React, { useCallback, useEffect, useRef, useState } from 'react';

type Direction = 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se';

interface HandleSpec {
  dir: Direction;
  cursor: string;
  // Hit-zone class (12px wide strip along the edge).
  className: string;
}

const HANDLES: HandleSpec[] = [
  // Corners
  { dir: 'nw', cursor: 'nwse-resize', className: 'top-0 left-0 w-3 h-3 cursor-nwse-resize' },
  { dir: 'ne', cursor: 'nesw-resize', className: 'top-0 right-0 w-3 h-3 cursor-nesw-resize' },
  { dir: 'sw', cursor: 'nesw-resize', className: 'bottom-0 left-0 w-3 h-3 cursor-nesw-resize' },
  { dir: 'se', cursor: 'nwse-resize', className: 'bottom-0 right-0 w-3 h-3 cursor-nwse-resize' },
  // Edges
  { dir: 'n',  cursor: 'ns-resize',  className: 'top-0 left-3 right-3 h-1.5 cursor-ns-resize' },
  { dir: 's',  cursor: 'ns-resize',  className: 'bottom-0 left-3 right-3 h-1.5 cursor-ns-resize' },
  { dir: 'e',  cursor: 'ew-resize',  className: 'top-3 bottom-3 right-0 w-1.5 cursor-ew-resize' },
  { dir: 'w',  cursor: 'ew-resize',  className: 'top-3 bottom-3 left-0 w-1.5 cursor-ew-resize' },
];

const SNAP_THRESHOLD_PX = 30;
const MIN_W = 320;
const MIN_H = 240;

export const OverlayResizeHandles: React.FC<{ className?: string }> = ({ className }) => {
  const [hovered, setHovered] = useState<Direction | null>(null);
  // Track the start bounds + start mouse position per drag.
  const dragRef = useRef<{
    dir: Direction;
    startX: number;
    startY: number;
    startBounds: { x: number; y: number; width: number; height: number };
  } | null>(null);

  const onHandleMouseDown = useCallback((dir: Direction, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startBounds = (window as any).electronAPI?.overlayGetBounds
      ? (window as any).electronAPI.overlayGetBounds()
      : null;
    // Resolve synchronously isn't possible (Promise). Capture start mouse and
    // fetch bounds asynchronously inside the move handler.
    dragRef.current = {
      dir,
      startX: e.clientX,
      startY: e.clientY,
      startBounds: { x: 0, y: 0, width: MIN_W, height: MIN_H }, // overwritten on first mousemove
    };

    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      // First move: replace startBounds with real ones.
      const live = (window as any).electronAPI?.overlayGetBounds
        ? (window as any).electronAPI.overlayGetBounds()
        : null;
      if (live && dragRef.current.startBounds.width === MIN_W) {
        dragRef.current.startBounds = live;
      }
      const dx = ev.clientX - dragRef.current.startX;
      const dy = ev.clientY - dragRef.current.startY;
      const next = computeNextBounds(dragRef.current.dir, dragRef.current.startBounds, dx, dy);
      // Live preview (no snap during drag — only on release).
      (window as any).electronAPI?.overlaySetBounds?.(next, { snap: false });
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      // Snap on release.
      (window as any).electronAPI?.overlayGetBounds?.().then((b: any) => {
        if (!b) return;
        (window as any).electronAPI?.overlaySetBounds?.(b, {
          snap: true,
          snapThreshold: SNAP_THRESHOLD_PX,
        });
      });
      dragRef.current = null;
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  return (
    <div
      className={`absolute inset-0 pointer-events-none ${className ?? ''}`}
      style={{ zIndex: 100 }}
    >
      {HANDLES.map((h) => (
        <div
          key={h.dir}
          data-resize-handle={h.dir}
          onMouseDown={(e) => onHandleMouseDown(h.dir, e)}
          onMouseEnter={() => setHovered(h.dir)}
          onMouseLeave={() => setHovered((cur) => (cur === h.dir ? null : cur))}
          className={`absolute ${h.className} pointer-events-auto transition-colors`}
          style={{
            backgroundColor: hovered === h.dir ? 'rgba(99, 102, 241, 0.45)' : 'transparent',
            zIndex: 101,
          }}
          title={`Resize ${h.dir.toUpperCase()}`}
        />
      ))}
    </div>
  );
};

function computeNextBounds(
  dir: Direction,
  start: { x: number; y: number; width: number; height: number },
  dx: number,
  dy: number,
): { x: number; y: number; width: number; height: number } {
  let { x, y, width, height } = start;
  if (dir.includes('e')) width = Math.max(MIN_W, start.width + dx);
  if (dir.includes('w')) {
    width = Math.max(MIN_W, start.width - dx);
    x = start.x + (start.width - width);
  }
  if (dir.includes('s')) height = Math.max(MIN_H, start.height + dy);
  if (dir.includes('n')) {
    height = Math.max(MIN_H, start.height - dy);
    y = start.y + (start.height - height);
  }
  return { x, y, width, height };
}

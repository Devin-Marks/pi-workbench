import { useEffect, useRef, type PointerEvent } from "react";

/**
 * Vertical drag-handle between two horizontally-stacked panes.
 *
 * Pattern: the parent owns a width state for the pane on a given side
 * of the divider; this component just emits delta movements via
 * `onResize`. Pointer events (not mouse events) so trackpad two-finger
 * drag and stylus work too. We capture the pointer on down so the user
 * can drag past the divider rectangle without the move events stopping.
 *
 * Decoupling drag from React state during the move loop keeps it
 * smooth: we read the latest width from a ref, compute the new width
 * synchronously, and only call `onResize` (which usually triggers a
 * setState upstream) once per frame's pointer move event.
 */
interface Props {
  /**
   * Width before the drag started. Stored in a ref by the parent so we
   * can compute `start + delta` without bouncing through React state
   * during the drag.
   */
  getStartWidth: () => number;
  onResize: (nextWidth: number) => void;
  /** Direction of growth as the user drags right. `+1` for "pane is to the right of divider", `-1` for left. */
  direction: 1 | -1;
  minWidth: number;
  maxWidth: number;
}

export function ResizableDivider({
  getStartWidth,
  onResize,
  direction,
  minWidth,
  maxWidth,
}: Props) {
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  // Always-on cancel listeners. ESC and window blur both
  // legitimately interrupt a drag (the user wanted out, or a system
  // notification stole focus); without these, `dragRef` could stay
  // populated and the next pointer move after re-focus would jump
  // the divider to a stale start point. The handlers are no-ops when
  // not dragging, so it's safe to register them once on mount.
  useEffect(() => {
    const cancel = (): void => {
      if (dragRef.current === null) return;
      dragRef.current = null;
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") cancel();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", cancel);
    return () => {
      cancel();
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", cancel);
    };
  }, []);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startWidth: getStartWidth() };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    if (dragRef.current === null) return;
    const dx = e.clientX - dragRef.current.startX;
    const next = dragRef.current.startWidth + dx * direction;
    onResize(Math.min(Math.max(next, minWidth), maxWidth));
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>): void => {
    if (dragRef.current === null) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    dragRef.current = null;
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
  };

  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className="group relative w-1 shrink-0 cursor-col-resize bg-neutral-800 hover:bg-neutral-600 active:bg-neutral-500"
      role="separator"
      aria-orientation="vertical"
    >
      {/* Slightly wider invisible hitbox so the drag handle is easier
          to grab without making the visible bar fat. */}
      <div className="absolute inset-y-0 -left-1 -right-1" />
    </div>
  );
}

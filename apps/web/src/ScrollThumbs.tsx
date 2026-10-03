import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const HIDE_AFTER_MS = 900;
const EDGE_PX = 14;
const MIN_THUMB_PX = 24;

type Axis = "y" | "x";

interface Thumb {
  el: HTMLElement;
  axis: Axis;
}

/**
 * Overlay scrollbars for the whole app. Native scrollbars are hidden in CSS; this draws one thin
 * thumb over whichever element is being scrolled, or whose edge the pointer is near, and fades it
 * out afterwards. Thumbs take no layout space and can be dragged.
 */
export function ScrollThumbs() {
  const [thumbs, setThumbs] = useState<Thumb[]>([]);
  const [, redraw] = useState(0);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const dragging = useRef(false);

  useEffect(() => {
    const show = (el: HTMLElement, axes: Axis[]) => {
      clearTimeout(hideTimer.current);
      setThumbs(axes.map((axis) => ({ el, axis })));
      redraw((n) => n + 1);
      hideTimer.current = setTimeout(() => !dragging.current && setThumbs([]), HIDE_AFTER_MS);
    };

    const onScroll = (e: Event) => {
      const el = e.target instanceof HTMLElement ? e.target : document.scrollingElement;
      if (el instanceof HTMLElement) {
        const axes = scrollAxes(el);
        if (axes.length) show(el, axes);
      }
    };

    // Near a scrollable edge: reveal that thumb so it can be grabbed. At most once per frame.
    let frame = 0;
    const onPointerMove = (e: PointerEvent) => {
      if (dragging.current || e.pointerType === "touch" || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        checkEdge(e);
      });
    };
    const checkEdge = (e: PointerEvent) => {
      for (let el = e.target as HTMLElement | null; el && el !== document.body; el = el.parentElement) {
        const axes = scrollAxes(el);
        if (!axes.length) continue;
        const r = el.getBoundingClientRect();
        const near: Axis[] = [];
        if (axes.includes("y") && r.right - e.clientX < EDGE_PX) near.push("y");
        if (axes.includes("x") && r.bottom - e.clientY < EDGE_PX) near.push("x");
        if (near.length) return show(el, near);
        return;
      }
    };

    const onResize = () => redraw((n) => n + 1);
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    document.addEventListener("pointermove", onPointerMove, { passive: true });
    addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("scroll", onScroll, { capture: true });
      document.removeEventListener("pointermove", onPointerMove);
      removeEventListener("resize", onResize);
      cancelAnimationFrame(frame);
      clearTimeout(hideTimer.current);
    };
  }, []);

  return (
    <>
      {thumbs.map(({ el, axis }) =>
        el.isConnected ? (
          // Modal dialogs render in the top layer, above anything outside them.
          createPortal(
            <ThumbView
              key={axis}
              el={el}
              axis={axis}
              onDrag={(active) => {
                dragging.current = active;
                if (!active) hideTimer.current = setTimeout(() => setThumbs([]), HIDE_AFTER_MS);
              }}
            />,
            el.closest("dialog[open]") ?? document.body,
          )
        ) : null,
      )}
    </>
  );
}

function ThumbView({ el, axis, onDrag }: { el: HTMLElement; axis: Axis; onDrag: (active: boolean) => void }) {
  const r = el.getBoundingClientRect();
  const vertical = axis === "y";
  const view = vertical ? el.clientHeight : el.clientWidth;
  const total = vertical ? el.scrollHeight : el.scrollWidth;
  const pos = vertical ? el.scrollTop : el.scrollLeft;
  const length = Math.max(MIN_THUMB_PX, (view * view) / total);
  const travel = view - length;
  const offset = total > view ? (pos / (total - view)) * travel : 0;
  const style: React.CSSProperties = vertical
    ? { top: r.top + offset, left: r.right - 8, height: length }
    : { left: r.left + offset, top: r.bottom - 8, width: length };

  return (
    <div
      className={`scroll-thumb ${axis}`}
      style={style}
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        onDrag(true);
        const start = vertical ? e.clientY : e.clientX;
        const startPos = pos;
        const perPx = (total - view) / Math.max(1, travel);
        const move = (m: PointerEvent) => {
          const delta = (vertical ? m.clientY : m.clientX) - start;
          if (vertical) el.scrollTop = startPos + delta * perPx;
          else el.scrollLeft = startPos + delta * perPx;
        };
        const up = () => {
          removeEventListener("pointermove", move);
          removeEventListener("pointerup", up);
          onDrag(false);
        };
        addEventListener("pointermove", move);
        addEventListener("pointerup", up);
      }}
    />
  );
}

function scrollAxes(el: HTMLElement): Axis[] {
  const style = getComputedStyle(el);
  const axes: Axis[] = [];
  const scrolls = (v: string) => v === "auto" || v === "scroll" || v === "overlay";
  if (scrolls(style.overflowY) && el.scrollHeight > el.clientHeight + 1) axes.push("y");
  if (scrolls(style.overflowX) && el.scrollWidth > el.clientWidth + 1) axes.push("x");
  return axes;
}

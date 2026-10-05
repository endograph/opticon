import type { CSSProperties } from "react";

/**
 * Bentham's panopticon plan, after the 1791 engraving: the cells' walls around the half ring,
 * the inspection galleries, and the lodge at the centre. Fills with the text color.
 */
export const MARK_PATH =
  "M31 8.5A15 15 0 0 1 1 8.5L2 8.5A14 14 0 0 0 30 8.5ZM26.25 11.25L29.96 12.46L29.62 13.5L25.91 12.3ZM24.25 15.18L27.14 17.79L26.41 18.61L23.51 16ZM20.81 17.96L22.4 21.52L21.4 21.97L19.81 18.41ZM16.55 19.1L16.55 23L15.45 23L15.45 19.1ZM12.19 18.41L10.6 21.97L9.6 21.52L11.19 17.96ZM8.49 16L5.59 18.61L4.86 17.79L7.75 15.18ZM6.09 12.3L2.38 13.5L2.04 12.46L5.75 11.25ZM26.5 8.5A10.5 10.5 0 0 1 5.5 8.5L6.1 8.5A9.9 9.9 0 0 0 25.9 8.5ZM24.05 8.5A8.05 8.05 0 0 1 7.95 8.5L8.45 8.5A7.55 7.55 0 0 0 23.55 8.5ZM22.85 8.5A6.85 6.85 0 0 1 9.15 8.5L9.65 8.5A6.35 6.35 0 0 0 22.35 8.5ZM20.6 8.5A4.6 4.6 0 0 1 11.4 8.5Z";

/** Each wall, ring and the lodge on its own, so they can be animated one at a time. */
const MARK_PARTS = MARK_PATH.split(/(?=M)/);

/** Per part, in path order (outer ring, the walls, the galleries outside in, the lodge): its
 * storey counting out from the lodge, which the ink floods out along. */
const STOREY = [5, 4, 4, 4, 4, 4, 4, 4, 3, 2, 1, 0];

/** Each part's outline length in mark units, so a pen can draw them all at one speed. */
const LENGTH = [93.1, 10, 10, 10, 10, 10, 10, 10, 65.3, 50, 42.5, 23.7];

/** A fixed scatter of start times, 0 to 1, so the strokes don't all begin in step. */
const JITTER = [0, 0.55, 0.2, 0.85, 0.4, 1, 0.3, 0.7, 0.15, 0.6, 0.35, 0.9];

/**
 * The half circle is twice as wide as it is tall; `size` is the width. `animate` drafts every
 * part in hairline outlines, then floods the ink out from the lodge.
 */
export function Mark({ className, size, animate }: { className?: string; size?: number; animate?: boolean }) {
  return (
    <svg
      className={className}
      viewBox="0 8 32 16"
      width={size}
      height={size && size / 2}
      fill="currentColor"
      aria-hidden="true"
      data-animate={animate || undefined}
    >
      {animate ? (
        MARK_PARTS.map((d, i) => (
          <path
            key={d}
            d={d}
            pathLength={1}
            style={{ "--storey": STOREY[i], "--len": LENGTH[i], "--jitter": JITTER[i] } as CSSProperties}
          />
        ))
      ) : (
        <path d={MARK_PATH} />
      )}
    </svg>
  );
}

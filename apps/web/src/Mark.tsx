/**
 * Bentham's panopticon plan, after the 1791 engraving: the cells' walls around the half ring,
 * the inspection galleries, and the lodge at the centre. Fills with the text color.
 */
export const MARK_PATH =
  "M31 8.5A15 15 0 0 1 1 8.5L2 8.5A14 14 0 0 0 30 8.5ZM26.25 11.25L29.96 12.46L29.62 13.5L25.91 12.3ZM24.25 15.18L27.14 17.79L26.41 18.61L23.51 16ZM20.81 17.96L22.4 21.52L21.4 21.97L19.81 18.41ZM16.55 19.1L16.55 23L15.45 23L15.45 19.1ZM12.19 18.41L10.6 21.97L9.6 21.52L11.19 17.96ZM8.49 16L5.59 18.61L4.86 17.79L7.75 15.18ZM6.09 12.3L2.38 13.5L2.04 12.46L5.75 11.25ZM26.5 8.5A10.5 10.5 0 0 1 5.5 8.5L6.1 8.5A9.9 9.9 0 0 0 25.9 8.5ZM24.05 8.5A8.05 8.05 0 0 1 7.95 8.5L8.45 8.5A7.55 7.55 0 0 0 23.55 8.5ZM22.85 8.5A6.85 6.85 0 0 1 9.15 8.5L9.65 8.5A6.35 6.35 0 0 0 22.35 8.5ZM20.6 8.5A4.6 4.6 0 0 1 11.4 8.5Z";

/** The half circle is twice as wide as it is tall; `size` is the width. */
export function Mark({ className, size }: { className?: string; size?: number }) {
  return (
    <svg
      className={className}
      viewBox="0 8 32 16"
      width={size}
      height={size && size / 2}
      fill="currentColor"
      aria-hidden="true"
    >
      <path d={MARK_PATH} />
    </svg>
  );
}

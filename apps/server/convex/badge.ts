/**
 * README badges in the shields.io "flat" style. Text widths are estimated for 11px Verdana and
 * pinned with `textLength`, so the badge looks the same whichever font the viewer has.
 */

const ACCENT = "#2f5bea";

export function sessionsBadge(count: number, capped: boolean): string {
  const value = count === 0 ? "no sessions yet" : `${count}${capped ? "+" : ""} ${count === 1 && !capped ? "session" : "sessions"}`;
  return badge("opticon", value, ACCENT);
}

function badge(label: string, value: string, color: string): string {
  const labelText = textWidth(label);
  const valueText = textWidth(value);
  const labelWidth = labelText + 10;
  const valueWidth = valueText + 10;
  const width = labelWidth + valueWidth;
  const title = escape(`${label}: ${value}`);
  const text = (content: string, center: number, length: number) =>
    `<text aria-hidden="true" x="${center * 10}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${length * 10}">${escape(content)}</text>` +
    `<text x="${center * 10}" y="140" transform="scale(.1)" fill="#fff" textLength="${length * 10}">${escape(content)}</text>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="${title}">` +
    `<title>${title}</title>` +
    `<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>` +
    `<clipPath id="r"><rect width="${width}" height="20" rx="3" fill="#fff"/></clipPath>` +
    `<g clip-path="url(#r)"><rect width="${labelWidth}" height="20" fill="#555"/><rect x="${labelWidth}" width="${valueWidth}" height="20" fill="${color}"/><rect width="${width}" height="20" fill="url(#s)"/></g>` +
    `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110">` +
    text(label, labelWidth / 2, labelText) +
    text(value, labelWidth + valueWidth / 2, valueText) +
    `</g></svg>`
  );
}

/** Approximate advance widths of 11px Verdana, rounded up to whole pixels. */
function textWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    if (/[0-9]/.test(ch)) width += 7;
    else if (ch === " ") width += 3.9;
    else if (/[ijlt.,:;'|!]/.test(ch)) width += 3.4;
    else if (/[frI]/.test(ch)) width += 4.6;
    else if (/[mwMW]/.test(ch)) width += 10.5;
    else if (/[A-Z]/.test(ch)) width += 7.5;
    else width += 6.7;
  }
  return Math.ceil(width);
}

function escape(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

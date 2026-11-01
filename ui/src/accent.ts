// A form's colour (the owner's accent) as the tokens a page paints with: the colour itself where
// it reads well, nudged until text on it keeps WCAG AA contrast in light and dark. Any colour an
// owner picks therefore stays readable on its buttons (the same promise as the platform's own
// accent setting, for a page that has no theme menu).

const DARK_SURFACE = "#161a21";
const DARK_TEXT = "#0b1020";

type RGB = [number, number, number];

/** `#rgb` or `#rrggbb` as `#rrggbb`, or null for anything else. */
export function hexOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v);
  return short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}` : null;
}

const rgb = (hex: string): RGB => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as RGB;
const toHex = (c: number[]) => `#${c.map((x) => Math.round(Math.min(255, Math.max(0, x))).toString(16).padStart(2, "0")).join("")}`;
const mix = (a: string, b: string, t: number) => toHex(rgb(a).map((x, i) => x + (rgb(b)[i] - x) * t));

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Moves a colour towards `target` in small steps until it passes `good`. */
function until(hex: string, target: string, good: (c: string) => boolean): string {
  for (let t = 0; t <= 1.0001; t += 0.04) {
    const c = mix(hex, target, t);
    if (good(c)) return c;
  }
  return target;
}

/** The page's tokens for an accent colour, or undefined to keep the platform's blue. */
export function accentVars(accent: unknown): Record<string, string> | undefined {
  const hex = hexOf(accent);
  if (!hex) return undefined;
  const light = until(hex, "#000000", (c) => contrast(c, "#ffffff") >= 4.5);
  const dark = until(hex, "#ffffff", (c) => contrast(c, DARK_TEXT) >= 4.5 && contrast(c, DARK_SURFACE) >= 3);
  const [lr, lg, lb] = rgb(light);
  const [dr, dg, db] = rgb(dark);
  return {
    "--primary": `light-dark(${light}, ${dark})`,
    "--primary-hover": `light-dark(${mix(light, "#000000", 0.15)}, ${mix(dark, "#ffffff", 0.15)})`,
    "--primary-soft": `light-dark(${mix(light, "#ffffff", 0.88)}, ${mix(dark, DARK_SURFACE, 0.78)})`,
    "--primary-text": `light-dark(#ffffff, ${DARK_TEXT})`,
    "--focus-ring": `0 0 0 3px light-dark(rgb(${lr} ${lg} ${lb} / 0.35), rgb(${dr} ${dg} ${db} / 0.45))`,
  };
}

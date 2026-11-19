// A form's own colour (the owner's accent, over the brand the form wears) as the tokens a page paints with, nudged by
// the kit's `accentTokens` (the kernel's brand algorithm, Ferrum crates/kernel/src/brand.rs) until it reads at 4.5:1 on
// the platform's surfaces in light and dark. Any colour an owner picks stays readable on its buttons and links.

import { accentTokens, contrastRatio } from "@ferrum/kit";

/** WCAG contrast ratio, 1 to 21. */
export const contrast = contrastRatio;

/** Text on the accent: white in light mode, the dark page colour in dark mode (the brand's, `TEXT_DARK`). */
const TEXT_DARK = "#111317";

/** `#rgb` or `#rrggbb` as `#rrggbb`, or null for anything else. */
export function hexOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v);
  return short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}` : null;
}

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(" ");

/** The page's tokens for the form's own colour, or undefined to keep the brand's (or the platform's). */
export function accentVars(accent: unknown): Record<string, string> | undefined {
  const hex = hexOf(accent);
  if (!hex) return undefined;
  const t = accentTokens(hex);
  return {
    "--primary": `light-dark(${t.light}, ${t.dark})`,
    "--primary-hover": `light-dark(${t.hoverLight}, ${t.hoverDark})`,
    "--primary-soft": `light-dark(${t.softLight}, ${t.softDark})`,
    "--primary-text": `light-dark(#ffffff, ${TEXT_DARK})`,
    "--focus-ring": `0 0 0 3px light-dark(rgb(${rgb(t.light)} / 0.75), rgb(${rgb(t.dark)} / 0.8))`,
  };
}

// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs"

import { defined } from "../core/defined.js"

/**
 * The colour tokens of every card, caption and overlay. Any CSS colour
 * works; a 3- or 6-digit hex colour (`#rgb`, `#rrggbb`) is the most
 * compact, since the translucent shadows and badges derive from it as
 * `rgba(...)` (any other colour is made translucent with `color-mix`; see
 * {@link rgba}).
 */
export interface BrandColors {
  /** The brand colour: gradient start, caption bar, badges, accents. */
  primary: string
  /** The second brand colour: gradient end, the email excerpt's rule. */
  accent: string
  /** Text on white surfaces; translucent overlays derive from it. */
  ink: string
  /** Secondary text on white surfaces (labels, column heads). */
  muted: string
  /** Body text inside white panels (email excerpt, notes). */
  body: string
  /** Hairlines between table rows. */
  line: string
  /** The email card's header band and its bottom border. */
  tint: string
  tintLine: string
  /** The email excerpt's background. */
  quote: string
  /** Drop shadows (used with transparency). */
  shadow: string
  /** Outcome colours. */
  pass: string
  fail: string
  /** A verdict that is neither (N/A, not run). */
  neutral: string
  /** The mark of a skipped or not-run step. */
  skip: string
  /** The mark of a development-only feature. */
  devOnly: string
}

/**
 * Logos as data: URIs (or any URL the renderer can load offline); null = no
 * logo, and the card is laid out without it.
 */
export interface Logos {
  /** Drawn on the brand gradient (usually a white logo). */
  onBrand: string | null
  /** Drawn on white surfaces (usually the full-colour logo). */
  onLight: string | null
}

/**
 * The brand a project's videos wear: its colours, the card background, the
 * logos and the product name. Every card, caption and overlay takes its
 * colours from here, so the same video code renders any project's brand.
 * The default ({@link NEUTRAL_BRAND}) is a plain slate theme with no logo.
 * Build one with {@link defineBrand}:
 *
 * ```ts
 * const brand = defineBrand({
 *   name: "Acme",
 *   colors: { primary: "#1d4ed8", accent: "#60a5fa" },
 *   logos: () => ({
 *     onBrand: svgDataUri("brand/logo-white.svg"),
 *     onLight: svgDataUri("brand/logo.svg"),
 *   }),
 * })
 * ```
 */
export interface Brand {
  /** The product name (the logos' alternative text). */
  name: string
  colors: BrandColors
  /** The CSS background of full-frame cards and of the recording's frame. */
  gradient: string
  /**
   * Loads the logos for one video. Called once per video, at render time,
   * so a logo changed on disk shows in the next video. Throwing means the
   * video is not produced (the reason is reported).
   */
  logos(): Logos
}

/**
 * What {@link defineBrand} builds a Brand from; everything is optional, and
 * a key given as `undefined` keeps its default.
 */
export interface BrandOptions {
  name?: string
  colors?: Partial<BrandColors>
  /** Default: a 135° linear gradient from primary to accent. */
  gradient?: string
  logos?: () => Logos
}

/** The neutral slate colours every Brand starts from. */
export const NEUTRAL_COLORS: BrandColors = {
  primary: "#334155",
  accent: "#64748b",
  ink: "#0f172a",
  muted: "#64748b",
  body: "#334155",
  line: "#e2e8f0",
  tint: "#f1f5f9",
  tintLine: "#e2e8f0",
  quote: "#f6f8fa",
  shadow: "#0f172a",
  pass: "#16a34a",
  fail: "#dc2626",
  neutral: "#64748b",
  skip: "#cbd5e1",
  devOnly: "#94a3b8",
}

/** No logo on either surface. */
export const NO_LOGOS: Logos = { onBrand: null, onLight: null }

/** `linear-gradient(135deg, <primary> 0%, <accent> 100%)` */
export const brandGradient = (
  colors: Pick<BrandColors, "primary" | "accent">,
) => `linear-gradient(135deg, ${colors.primary} 0%, ${colors.accent} 100%)`

/**
 * A complete Brand from a partial one (neutral defaults, no logo). A colour
 * or option given as `undefined` keeps its default.
 */
export function defineBrand(options: BrandOptions = {}): Brand {
  const colors = { ...NEUTRAL_COLORS, ...defined(options.colors) }
  return {
    name: options.name ?? "",
    colors,
    gradient: options.gradient ?? brandGradient(colors),
    logos: options.logos ?? (() => NO_LOGOS),
  }
}

/** The default brand: slate colours, no logo. */
export const NEUTRAL_BRAND: Brand = defineBrand()

/**
 * A colour made translucent: "#0f2030" + 0.75 -> "rgba(15,32,48,.75)" for a
 * 3- or 6-digit hex colour; any other CSS colour (`rgb(...)`, `hsl(...)`, a
 * named colour, `#rrggbbaa`) -> "color-mix(in srgb, <colour> 75%,
 * transparent)", so the transparency is never lost.
 */
export function rgba(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())
  if (!m) {
    const percent = Math.round(Math.min(Math.max(alpha, 0), 1) * 10_000) / 100
    return `color-mix(in srgb, ${color.trim()} ${percent}%, transparent)`
  }
  const digits =
    m[1].length === 3
      ? m[1]
          .split("")
          .map((d) => d + d)
          .join("")
      : m[1]
  const [r, g, b] = [0, 2, 4].map((i) =>
    Number.parseInt(digits.slice(i, i + 2), 16),
  )
  const a = String(alpha).replace(/^0(?=\.)/, "")
  return `rgba(${r},${g},${b},${a})`
}

/** An SVG file as a data: URI. Throws when the file is missing. */
export function svgDataUri(path: string): string {
  return `data:image/svg+xml;base64,${readFileSync(path).toString("base64")}`
}

/**
 * scripts/ui-contrast-math.ts — WCAG 2.2 contrast arithmetic for the UI guards (wave 146, lane 146H).
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure functions, no I/O except `loadTailwindPalette`, which reads the INSTALLED Tailwind theme so
 * every number a guard prints is derived from the colours the app actually ships (CLAUDE.md §2:
 * assert the rule, derive the number — never a hand-copied hex table that drifts on an upgrade).
 *
 * Colour spaces read: `#rgb` / `#rrggbb`, the shadcn token triplet `H S% L%` (app/globals.css),
 * `hsl(...)`, and Tailwind v4's `oklch(L% C H)`. Out-of-gamut oklch is clamped to sRGB after the
 * conversion, the way a browser renders it.
 *
 * Formulas: WCAG 2.x relative luminance (sRGB, 0.04045 knee) and contrast (L1 + 0.05) / (L2 + 0.05);
 * OKLab → linear sRGB with Björn Ottosson's published matrices; alpha compositing in sRGB space
 * (what a browser does for `bg-x/60` over a page colour).
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

export type RGB = { r: number; g: number; b: number } // 0..255 sRGB

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))

export function hexToRgb(hex: string): RGB | null {
  const m = hex.trim().replace(/^#/, "")
  if (/^[0-9a-f]{3}$/i.test(m)) return { r: parseInt(m[0] + m[0], 16), g: parseInt(m[1] + m[1], 16), b: parseInt(m[2] + m[2], 16) }
  if (/^[0-9a-f]{6}$/i.test(m)) return { r: parseInt(m.slice(0, 2), 16), g: parseInt(m.slice(2, 4), 16), b: parseInt(m.slice(4, 6), 16) }
  return null
}

export function hslToRgb(h: number, s: number, l: number): RGB {
  // h in degrees, s/l in 0..1
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return { r: Math.round(255 * f(0)), g: Math.round(255 * f(8)), b: Math.round(255 * f(4)) }
}

export function oklchToRgb(L: number, C: number, H: number): RGB {
  // L in 0..1
  const hr = (H * Math.PI) / 180
  const a = C * Math.cos(hr), b = C * Math.sin(hr)
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.291485548 * b
  const l3 = l_ ** 3, m3 = m_ ** 3, s3 = s_ ** 3
  const lin = [
    4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
  ]
  const enc = (x: number) => { const c = clamp01(x); return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055 }
  return { r: Math.round(255 * enc(lin[0])), g: Math.round(255 * enc(lin[1])), b: Math.round(255 * enc(lin[2])) }
}

/** Parse any colour spelling the app's CSS uses. Returns null for what it cannot read (never guesses). */
export function parseColor(raw: string): RGB | null {
  const v = raw.trim()
  if (v.startsWith("#")) return hexToRgb(v)
  let m = v.match(/^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*\)$/i)
  if (m) return oklchToRgb(m[2] ? Number(m[1]) / 100 : Number(m[1]), Number(m[3]), Number(m[4]))
  m = v.match(/^hsl\(\s*([\d.]+)\s*,?\s*([\d.]+)%\s*,?\s*([\d.]+)%\s*\)$/i)
  if (m) return hslToRgb(Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100)
  m = v.match(/^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/) // the shadcn token triplet
  if (m) return hslToRgb(Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100)
  if (/^white$/i.test(v)) return { r: 255, g: 255, b: 255 }
  if (/^black$/i.test(v)) return { r: 0, g: 0, b: 0 }
  return null
}

export function luminance({ r, g, b }: RGB): number {
  const ch = (c: number) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)
}

export function contrast(a: RGB, b: RGB): number {
  const la = luminance(a), lb = luminance(b)
  const hi = Math.max(la, lb), lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

/** `fg` at `alpha` over `bg` — what `bg-x/60` renders on a page colour. */
export function blend(fg: RGB, alpha: number, bg: RGB): RGB {
  const mix = (f: number, b: number) => Math.round(f * alpha + b * (1 - alpha))
  return { r: mix(fg.r, bg.r), g: mix(fg.g, bg.g), b: mix(fg.b, bg.b) }
}

export const toHex = ({ r, g, b }: RGB) => "#" + [r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")

/** WCAG 2.2 thresholds (SC 1.4.3 text, 1.4.11 non-text / focus). */
export const AA_TEXT = 4.5
export const AA_LARGE_OR_UI = 3

/**
 * The INSTALLED Tailwind palette: `--color-<hue>-<shade>` from node_modules/tailwindcss/theme.css.
 * Returns an empty map when the package is absent — the caller must treat that as "cannot measure",
 * never as "nothing failed".
 */
export function loadTailwindPalette(root = process.cwd()): Map<string, RGB> {
  const out = new Map<string, RGB>()
  const p = join(root, "node_modules", "tailwindcss", "theme.css")
  if (!existsSync(p)) return out
  const css = readFileSync(p, "utf8")
  for (const m of css.matchAll(/--color-([a-z]+-\d{2,3}):\s*([^;]+);/g)) {
    const rgb = parseColor(m[2])
    if (rgb) out.set(m[1], rgb)
  }
  const w = css.match(/--color-white:\s*([^;]+);/), k = css.match(/--color-black:\s*([^;]+);/)
  if (w) { const c = parseColor(w[1]); if (c) out.set("white", c) }
  if (k) { const c = parseColor(k[1]); if (c) out.set("black", c) }
  return out
}

/** Parse the `--name: value;` declarations of one CSS block (`:root` or `.dark`) of a stylesheet. */
export function readTokenBlock(css: string, selector: ":root" | ".dark"): Map<string, string> {
  const out = new Map<string, string>()
  const re = selector === ":root" ? /(^|\n):root\s*\{([\s\S]*?)\n\}/ : /(^|\n)\.dark\s*\{([\s\S]*?)\n\}/
  const m = css.match(re)
  if (!m) return out
  for (const d of m[2].matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) out.set(d[1], d[2].trim())
  return out
}

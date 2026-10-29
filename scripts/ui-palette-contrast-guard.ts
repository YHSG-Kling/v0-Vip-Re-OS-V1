#!/usr/bin/env tsx
/**
 * scripts/ui-palette-contrast-guard.ts   (npm run test:ui-palette-contrast — pure, no DB, no network)
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE HIGH-CONTRAST PALETTE, MEASURED — NOT ASSERTED.
 *
 * Owner ruling 16 (2026-10-29): "Make sure that the design of the complete agentic os match and it
 * pops with the same like color contrasts. this is the kernel's job." The lane brief (146H): one
 * consistent high-contrast palette and status/action styling, accessible interactions — "contrast
 * ratios — measure with the existing accessibility guards". No existing guard measured a single
 * contrast ratio (test:accessibility-preferences is the person's STATED preferences; test:ui-wiring-
 * census is wiring + mobile + icon labels). This guard is the measurement, in the `scripts/ui-*`
 * family the brief names as the kernel's design governance. It is not a UI kernel: it adds no
 * component, no theme layer and no runtime — it reads the one stylesheet and the screens.
 *
 * MEASURED AT bf67aa63 BEFORE ANY FIX (the denominator, CLAUDE.md §2):
 *   T  the LIVE palette (app/globals.css `:root`; `.dark` is applied by NO surface — see T4) failed
 *      WCAG 2.2 AA on four pairs: destructive button label 3.60 / 3.76 (white), destructive text on the
 *      page 3.76, muted text on the muted surface 4.34 (every inactive TabsTrigger), form-control
 *      boundary (`--input`: Input / Select / Textarea / Checkbox / Radio border, the unchecked Switch
 *      TRACK) 1.23 against the page — an unchecked switch was all but invisible.
 *   C  1,452 `text-{orange|amber|yellow|lime|green|emerald|teal|cyan|sky}-600` and 636 chromatic
 *      `-500` text classes across app/**\/*.tsx — `text-green-600` on white is 3.22, `text-amber-600`
 *      3.20, `text-yellow-600` 2.94 (numbers derived below from the INSTALLED Tailwind theme).
 *   B  146 white labels on a saturated fill below AA (`bg-green-600 text-white` 3.22,
 *      `bg-amber-500 text-white` 2.13, `bg-blue-500 text-white` 3.76).
 *
 * WHAT IS HELD
 *   T  TOKENS — every foreground/background pair the primitives render (app/components/ui/**) meets
 *      SC 1.4.3 (4.5:1 text) / SC 1.4.11 (3:1 control boundary, focus ring) AS RENDERED: the focus
 *      ring at its `/50` alpha over the page, the dark destructive fill at its `/60` alpha.
 *   P  PRIMITIVES — every focusable primitive declares a visible focus style (SC 2.4.7 / 2.4.11).
 *   C  TEXT — a plain `text-{hue}-{shade}` in a light-context class string meets 4.5:1 against the
 *      string's own light fill (or the page), 3:1 when it is LARGE (≥ text-2xl, or text-xl + bold)
 *      or sits on an ICON (a lucide-react import, an `…Icon` component, an <svg>) — SC 1.4.11 asks
 *      3:1 of informative graphics, so a status icon keeps its hue and only a sub-3:1 one darkens.
 *   B  ACTION FILLS — a plain `text-white` on a plain `bg-{hue}-{shade}` meets 4.5:1 (3:1 large).
 *      HARD ZERO for C and B on every module this lane owns; a RATCHET (shrink-only,
 *      scripts/ui-palette-contrast-baseline.json) on (a) modules with a DARK SECTION — a dark/neutral
 *      ≥700 fill, translucent white (`bg-white/5`, `text-white/60`), or a `text-white` string with no
 *      fill of its own (it leans on a dark parent) — where a light-context string may sit on a parent
 *      the string cannot see; (b) a PALE text shade (50–300) in a module that paints a saturated fill
 *      (`text-blue-200` as the timestamp of a `bg-blue-600` bubble — darkening it would put it ON the
 *      bubble's own colour); (c) the two directories another wave-146 lane owns (app/portal/** → 146C,
 *      app/dashboard/marketing/** → 146F).
 *      APPLIED AT bf67aa63 (lane 146H, `--fix`): 1,221 class strings in 479 modules, every line count
 *      unchanged; ratchets written at 225 + 27 dark-section, 9 pale-held, 56 + 11 portal, 62 marketing.
 *   --fix applies the SAME rule the check reads: the smallest darker shade OF THE SAME HUE that
 *      passes (a hover shade in the same string moves by the same number of steps, so the hover
 *      still reads as a change). A class name never lies about what it renders — no theme override
 *      re-points `green-600` at another colour.
 *   X  POSITIVE CONTROLS for every finder and for the token reader (§2: a broken finder and a clean
 *      tree both report zero).
 *
 * BLIND SPOTS (published beside the numbers, §2):
 *   · the fill a text class sits on is read from ITS OWN string (and an enclosing template's static
 *     text); a fill on a PARENT element in another string or file is invisible — hence the
 *     dark-section ratchet; a light parent fill other than the page (`bg-blue-50` card with a
 *     `text-blue-600` child in another string) is measured against white;
 *   · variant-prefixed classes (`hover:` `md:` `dark:` `group-hover:` …), opacity suffixes
 *     (`text-x/70`), arbitrary values (`text-[#…]`), inline `style={{ color }}`, element `opacity-*`
 *     and computed class names are not measured;
 *   · large-text detection reads the string's own size class (a size inherited from a parent reads
 *     as normal text, which can only over-darken, never under-measure);
 *   · `.dark` tokens are measured and held, but no surface applies `.dark` at HEAD (T4 counts the
 *     activators), so the 914 `dark:` variants in app/ are inert;
 *   · tenant brand colours (`brokerages.primary_color` on the public site / portal) are runtime
 *     values this static guard cannot see.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { stringLiterals, stripComments } from "./strip-comments"
import { walkTs } from "./runtime-roots"
import { journeyOf } from "./ui-journeys"
import { parseColor, contrast, blend, toHex, loadTailwindPalette, readTokenBlock, AA_TEXT, AA_LARGE_OR_UI, type RGB } from "./ui-contrast-math"

const ROOT = process.cwd()
const BASELINE_PATH = join(ROOT, "scripts", "ui-palette-contrast-baseline.json")
const FIX = process.argv.includes("--fix")
const WRITE_BASELINE = process.argv.includes("--write-baseline")
const onlyIdx = process.argv.indexOf("--only")
const ONLY = onlyIdx > 0 ? process.argv[onlyIdx + 1] : null

let pass = 0, fail = 0
const fails: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; fails.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const rel = (abs: string) => abs.slice(ROOT.length + 1).replace(/\\/g, "/")
const lineOf = (s: string, i: number) => s.slice(0, i).split("\n").length

// ── The installed palette ─────────────────────────────────────────────────────
const PALETTE = loadTailwindPalette(ROOT)
export const SHADES = ["50", "100", "200", "300", "400", "500", "600", "700", "800", "900", "950"] as const
const NEUTRALS = ["slate", "gray", "zinc", "neutral", "stone"]
const CHROMATIC = ["red", "orange", "amber", "yellow", "lime", "green", "emerald", "teal", "cyan", "sky", "blue", "indigo", "violet", "purple", "fuchsia", "pink", "rose"]
const HUES = [...CHROMATIC, ...NEUTRALS]
const HUE_ALT = HUES.join("|")
const SHADE_ALT = SHADES.join("|")
const WHITE: RGB = { r: 255, g: 255, b: 255 }
const shadeIdx = (s: string) => SHADES.indexOf(s as (typeof SHADES)[number])
const tw = (hue: string, shade: string) => PALETTE.get(`${hue}-${shade}`) ?? null

// ── T · tokens ────────────────────────────────────────────────────────────────
const CSS_PATH = join(ROOT, "app", "globals.css")
type Pair = { fg: string; bg: string; min: number; fgAlpha?: number; bgAlpha?: number; why: string }
/** The pairs the primitives RENDER (app/components/ui/** + the base layer). `bgAlpha` composites the fill
 *  over `--background` the way `bg-x/60` does; `fgAlpha` composites a ring/foreground the same way. */
export const LIGHT_PAIRS: Pair[] = [
  { fg: "foreground", bg: "background", min: AA_TEXT, why: "body text" },
  { fg: "card-foreground", bg: "card", min: AA_TEXT, why: "Card text" },
  { fg: "popover-foreground", bg: "popover", min: AA_TEXT, why: "Popover / Select / Dropdown text" },
  { fg: "primary-foreground", bg: "primary", min: AA_TEXT, why: "default Button / Badge label" },
  { fg: "secondary-foreground", bg: "secondary", min: AA_TEXT, why: "secondary Button / Badge label" },
  { fg: "accent-foreground", bg: "accent", min: AA_TEXT, why: "hovered ghost/outline Button, focused menu item" },
  { fg: "muted-foreground", bg: "muted", min: AA_TEXT, why: "inactive TabsTrigger on the TabsList" },
  { fg: "muted-foreground", bg: "background", min: AA_TEXT, why: "descriptions, placeholders, helper text" },
  { fg: "destructive-foreground", bg: "destructive", min: AA_TEXT, why: "destructive label (token pair)" },
  { fg: "white", bg: "destructive", min: AA_TEXT, why: "destructive Button / Badge label (`text-white`)" },
  { fg: "destructive", bg: "background", min: AA_TEXT, why: "error text (`text-destructive`, aria-invalid)" },
  { fg: "primary", bg: "background", min: AA_TEXT, why: "link Button" },
  { fg: "input", bg: "background", min: AA_LARGE_OR_UI, why: "form-control boundary + unchecked Switch track (SC 1.4.11)" },
  { fg: "ring", bg: "background", min: AA_LARGE_OR_UI, fgAlpha: 0.5, why: "focus ring `ring-ring/50` (SC 2.4.11 / 1.4.11)" },
  { fg: "sidebar-foreground", bg: "sidebar", min: AA_TEXT, why: "sidebar text" },
  { fg: "sidebar-primary-foreground", bg: "sidebar-primary", min: AA_TEXT, why: "sidebar primary item" },
  { fg: "sidebar-accent-foreground", bg: "sidebar-accent", min: AA_TEXT, why: "sidebar hovered item" },
]
/** Dark mode: the primitives composite the destructive fill at /60 (`dark:bg-destructive/60`). */
export const DARK_PAIRS: Pair[] = LIGHT_PAIRS.map((p) =>
  p.fg === "white" && p.bg === "destructive" ? { ...p, bgAlpha: 0.6, why: "destructive Button / Badge label over `dark:bg-destructive/60`" }
  : p.fg === "destructive-foreground" ? { ...p, bgAlpha: 0.6, why: "destructive label over `dark:bg-destructive/60`" }
  : p)

export function measureTokens(css: string, block: ":root" | ".dark", pairs: Pair[]): { pair: Pair; ratio: number | null; detail: string }[] {
  const t = readTokenBlock(css, block)
  const page = t.get("background") ? parseColor(t.get("background")!) : null
  const color = (n: string): RGB | null => (n === "white" ? WHITE : t.get(n) ? parseColor(t.get(n)!) : null)
  return pairs.map((pair) => {
    let fg = color(pair.fg), bg = color(pair.bg)
    if (!fg || !bg || !page) return { pair, ratio: null, detail: `unreadable token (${pair.fg} / ${pair.bg})` }
    if (pair.bgAlpha != null) bg = blend(bg, pair.bgAlpha, page)
    if (pair.fgAlpha != null) fg = blend(fg, pair.fgAlpha, bg)
    const ratio = contrast(fg, bg)
    return { pair, ratio, detail: `${pair.fg} ${toHex(fg)} on ${pair.bg} ${toHex(bg)} = ${ratio.toFixed(2)} (min ${pair.min}) — ${pair.why}` }
  })
}

// ── C / B · the class finders (pure: one source string in, findings + rewritten source out) ─────────
export type Finding = { kind: "TEXT" | "FILL"; line: number; token: string; ratio: number; min: number; on: string; fixTo: string | null; context: "icon" | "large" | "text"; pale: boolean }
const NEUTRAL_DARK = new RegExp(`(?:^|\\s)bg-(?:${NEUTRALS.join("|")})-(?:600|700|800|900|950)(?:/\\d+)?(?=\\s|$)`)
const CHROMA_DARK = new RegExp(`(?:^|\\s)bg-(?:${CHROMATIC.join("|")})-(?:500|600|700|800|900|950)(?:/\\d+)?(?=\\s|$)`)
const TOKEN_DARK = /(?:^|\s)(?:bg-(?:black|primary|destructive|foreground|sidebar-primary)(?:\/\d+)?|bg-gradient-to-\S+|bg-linear-to-\S+|from-\S+|glass-morphism|gradient-ai|gradient-success|gradient-warning)(?=\s|$)/
/** A class string that paints its own dark / saturated fill: a text class there is not on the page. */
export const isDarkString = (s: string) => NEUTRAL_DARK.test(s) || CHROMA_DARK.test(s) || TOKEN_DARK.test(s)
/** A MODULE with a dark section: a light-context string in it may sit on a dark parent (ratchet, not hard zero). */
const DARK_SECTION = new RegExp(`(?:^|[\\s"'\`])(?:bg-(?:${NEUTRALS.join("|")})-(?:700|800|900|950)|bg-black|from-(?:${HUE_ALT})-(?:700|800|900|950)|bg-(?:${CHROMATIC.join("|")})-(?:800|900|950)|glass-morphism)(?=[\\s"'\`/]|$)`)
/** Translucent white (`text-white/60`, `bg-white/5`, `border-white/10`) is drawn ON something dark. */
const TRANSLUCENT_WHITE = /(?:^|[\s"'`])(?:text|bg|border)-white\/\d+(?=[\s"'`]|$)/
/** A class string with a plain `text-white` and NO fill of its own relies on a dark / saturated PARENT. */
const leansOnDarkParent = (src: string) => stringLiterals(src).some((l) => /(?:^|\s)text-white(?=\s|$)/.test(l.text) && !/(?:^|\s)bg-/.test(l.text))
export const hasDarkSection = (src: string) => DARK_SECTION.test(src) || TRANSLUCENT_WHITE.test(src) || leansOnDarkParent(src)
/** A MODULE that paints a SATURATED fill somewhere (a chat bubble, a banner, a primary button). A PALE text
 *  shade (50–300) in such a module is presumed to sit on that fill — `text-blue-200` as the timestamp of a
 *  `bg-blue-600` bubble — so it is held, never darkened onto the fill it was chosen to contrast with. */
const FILLED_SECTION = new RegExp(`(?:^|[\\s"'\`])(?:bg-(?:${CHROMATIC.join("|")})-(?:500|600|700|800|900|950)|bg-(?:primary|destructive|black|foreground)|bg-gradient-to-[a-z]+|bg-linear-to-[a-z]+|from-[a-z]+-\\d{2,3})(?=[\\s"'\`/]|$)`)
export const hasFilledSection = (src: string) => FILLED_SECTION.test(src)
const isPale = (shade: string) => shadeIdx(shade) <= shadeIdx("300")

const TOKEN_FILLS: Record<string, string> = { "bg-white": "white", "bg-background": "background", "bg-card": "card", "bg-muted": "muted", "bg-secondary": "secondary", "bg-accent": "accent", "bg-popover": "popover" }
let LIGHT_TOKENS: Map<string, string> | null = null
function tokenColor(name: string): RGB | null {
  if (name === "white") return WHITE
  if (!LIGHT_TOKENS) LIGHT_TOKENS = existsSync(CSS_PATH) ? readTokenBlock(readFileSync(CSS_PATH, "utf8"), ":root") : new Map()
  const v = LIGHT_TOKENS.get(name)
  return v ? parseColor(v) : null
}
/** The light fill a class string paints on itself, composited over white; null → the page (white). */
export function ownLightFill(s: string): { rgb: RGB; label: string } | null {
  const m = s.match(new RegExp(`(?:^|\\s)bg-(${HUE_ALT})-(50|100|200|300|400)(?:/(\\d+))?(?=\\s|$)`))
  if (m) {
    const c = tw(m[1], m[2])
    if (c) return { rgb: m[3] ? blend(c, Number(m[3]) / 100, WHITE) : c, label: `bg-${m[1]}-${m[2]}${m[3] ? "/" + m[3] : ""}` }
  }
  for (const [cls, tok] of Object.entries(TOKEN_FILLS)) {
    const mm = s.match(new RegExp(`(?:^|\\s)${cls}(?:/(\\d+))?(?=\\s|$)`))
    if (mm) { const c = tokenColor(tok); if (c) return { rgb: mm[1] ? blend(c, Number(mm[1]) / 100, WHITE) : c, label: cls } }
  }
  return null
}
export const isLargeText = (s: string) => /(?:^|\s)text-(?:[2-9]xl)(?=\s|$)/.test(s) || (/(?:^|\s)text-xl(?=\s|$)/.test(s) && /(?:^|\s)font-(?:bold|extrabold|black)(?=\s|$)/.test(s))

/** Names a module imports from lucide-react (aliases included) — an element with one of these tags is an icon. */
export function iconNames(code: string): Set<string> {
  const out = new Set<string>()
  for (const m of code.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']lucide-react["']/g)) {
    for (const part of m[1].split(",")) {
      const p = part.trim().replace(/^type\s+/, "")
      if (!p) continue
      const as = p.match(/^(\w+)\s+as\s+(\w+)$/)
      out.add(as ? as[2] : p)
    }
  }
  return out
}
/** The JSX element whose className attribute holds the literal starting at `anchor`, or null. */
export function tagFor(code: string, anchor: number): string | null {
  const from = Math.max(0, anchor - 1200)
  const before = code.slice(from, anchor)
  let last: RegExpExecArray | null = null
  const re = /<([A-Za-z][\w.]*)/g
  for (let m = re.exec(before); m; m = re.exec(before)) last = m
  if (!last) return null
  const seg = before.slice(last.index).replace(/=>/g, "  ")
  if (/>/.test(seg)) return null // the tag closed before the literal: not its attribute
  if (!/\bclass(Name)?\s*=/.test(seg)) return null
  return last[1]
}

/** The static (non-`${…}`) character ranges of a template literal, as absolute offsets. */
function templateStaticRanges(code: string, start: number, end: number): Array<[number, number]> {
  const out: Array<[number, number]> = []
  let i = start + 1, segStart = i
  while (i < end - 1) {
    if (code[i] === "\\") { i += 2; continue }
    if (code[i] === "$" && code[i + 1] === "{") {
      out.push([segStart, i])
      let depth = 1; i += 2
      while (i < end - 1 && depth > 0) {
        const ch = code[i]
        if (ch === "'" || ch === '"' || ch === "`") { const q = ch; i++; while (i < end - 1 && code[i] !== q) { if (code[i] === "\\") i++; i++ } i++; continue }
        if (ch === "{") depth++
        else if (ch === "}") depth--
        i++
      }
      segStart = i
      continue
    }
    i++
  }
  out.push([segStart, end - 1])
  return out
}

const TEXT_TOKEN = new RegExp(`(^|[\\s"'\`])text-(${HUE_ALT})-(${SHADE_ALT})(?=[\\s"'\`]|$)`, "g")
const FILL_TOKEN = new RegExp(`(^|[\\s"'\`])bg-(${HUE_ALT})-(${SHADE_ALT})(?=[\\s"'\`]|$)`)
const PLAIN_WHITE = /(^|[\s"'`])text-white(?=[\s"'`]|$)/

/** Smallest shade ≥ `from` of `hue` whose contrast against `bg` (or with `fg` on it) reaches `min`. */
function passingShade(hue: string, from: string, min: number, measure: (c: RGB) => number): string | null {
  for (let k = shadeIdx(from); k < SHADES.length; k++) { const c = tw(hue, SHADES[k]); if (c && measure(c) >= min) return SHADES[k] }
  return null
}

/**
 * Scan one module. Returns every finding (with its fix) and, when `apply`, the module rewritten by the
 * SAME rule. Exported for the positive controls — the controls exercise exactly the code the tree runs.
 */
export function scanModule(src: string, apply: boolean, opts: { holdPale?: boolean } = {}): { findings: Finding[]; out: string; edits: number } {
  const code = stripComments(src)
  // stripComments deletes comments (offsets move); literals are located on the ORIGINAL source so an edit
  // lands where it belongs — stringLiterals skips comments by itself.
  const lits = stringLiterals(src)
  const icons = iconNames(code)
  const findings: Finding[] = []
  const edits: Array<{ start: number; end: number; text: string }> = []
  // An enclosing template's static text is part of a nested literal's context.
  const templates = lits.filter((l) => l.kind === "template")
  for (const lit of lits) {
    if (!/(?:^|[\s"'`])(?:text|bg)-/.test(lit.text)) continue
    const parent = templates.find((t) => t !== lit && t.start < lit.start && t.end > lit.end)
    const ctxText = parent ? `${lit.text} ${parent.text}` : lit.text
    if (isDarkString(lit.text) && !PLAIN_WHITE.test(lit.text)) continue
    const outer = parent ?? lit
    const tag = tagFor(src, outer.start)
    const isIcon = !!tag && (icons.has(tag) || /Icon$/.test(tag) || tag === "svg" || tag === "path")
    const large = isLargeText(ctxText)
    const ranges: Array<[number, number]> = lit.kind === "template" ? templateStaticRanges(src, lit.start, lit.end) : [[lit.start + 1, lit.end - 1]]
    for (const [a, b] of ranges) {
      let chunk = src.slice(a, b)
      let changed = false
      // B · white label on a saturated fill
      const fm = chunk.match(FILL_TOKEN)
      if (fm && PLAIN_WHITE.test(chunk) && !/(?:^|\s)bg-\S+\/\d+(?=\s|$)/.test(fm[0])) {
        const hue = fm[2], shade = fm[3], bg = tw(hue, shade)
        const min = large ? AA_LARGE_OR_UI : AA_TEXT
        if (bg && contrast(WHITE, bg) < min) {
          const to = passingShade(hue, shade, min, (c) => contrast(WHITE, c))
          findings.push({ kind: "FILL", line: lineOf(src, a), token: `text-white on bg-${hue}-${shade}`, ratio: contrast(WHITE, bg), min, on: `bg-${hue}-${shade}`, fixTo: to ? `bg-${hue}-${to}` : null, context: large ? "large" : "text", pale: false })
          if (apply && to) {
            const delta = shadeIdx(to) - shadeIdx(shade)
            chunk = chunk.replace(new RegExp(`(^|[\\s"'\`])bg-${hue}-${shade}(?=[\\s"'\`]|$)`), `$1bg-${hue}-${to}`)
            chunk = chunk.replace(new RegExp(`(^|[\\s"'\`])hover:bg-${hue}-(${SHADE_ALT})(?=[\\s"'\`]|$)`, "g"), (_m, p: string, h: string) => `${p}hover:bg-${hue}-${SHADES[Math.min(SHADES.length - 1, shadeIdx(h) + delta)]}`)
            changed = true
          }
        }
      }
      // C · coloured text on the page / its own light fill
      if (!isDarkString(chunk) && !isDarkString(lit.text)) {
        const fill = ownLightFill(chunk) ?? ownLightFill(ctxText)
        const bg = fill?.rgb ?? WHITE
        const min = isIcon || large ? AA_LARGE_OR_UI : AA_TEXT
        chunk = chunk.replace(TEXT_TOKEN, (whole, pre: string, hue: string, shade: string) => {
          const fg = tw(hue, shade)
          if (!fg) return whole
          const r = contrast(fg, bg)
          if (r >= min) return whole
          const to = passingShade(hue, shade, min, (c) => contrast(c, bg))
          const pale = isPale(shade)
          findings.push({ kind: "TEXT", line: lineOf(src, a), token: `text-${hue}-${shade}`, ratio: r, min, on: fill?.label ?? "page", fixTo: to ? `text-${hue}-${to}` : null, context: isIcon ? "icon" : large ? "large" : "text", pale })
          if (apply && to && !(pale && opts.holdPale)) { changed = true; return `${pre}text-${hue}-${to}` }
          return whole
        })
      }
      if (changed) edits.push({ start: a, end: b, text: chunk })
    }
  }
  let out = src
  for (const e of edits.sort((x, y) => y.start - x.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end)
  return { findings, out, edits: edits.length }
}

// ── populations ───────────────────────────────────────────────────────────────
/** Directories another wave-146 lane owns (the spec's lane briefs) — reported and ratcheted, never edited here. */
export const OTHER_LANE_DIRS: Record<string, string> = { "app/portal": "146C (contact portal)", "app/dashboard/marketing": "146F (marketing / video staging / lead magnets)" }
const otherLaneOf = (f: string) => Object.keys(OTHER_LANE_DIRS).find((d) => f === d || f.startsWith(d + "/")) ?? null

async function main() {
  console.log("\n━━ UI PALETTE CONTRAST — one high-contrast palette, measured (ruling 16) ━━\n")

  // ── X · positive controls first: a finder that cannot see a defect reports zero on a broken tree too ──
  console.log("[X · positive controls]")
  check("X0 the installed Tailwind palette is readable (node_modules/tailwindcss/theme.css) — without it nothing below can measure", PALETTE.size >= 200 && !!tw("green", "600"), `${PALETTE.size} colours`)
  const ctl = (s: string) => scanModule(s, true)
  const lucide = `import { Check, Star as Fav } from "lucide-react"\n`
  const c1 = ctl(`${lucide}export const A = () => <span className="text-xs text-green-600">ok</span>\n`)
  check("X1 coloured TEXT below 4.5:1 on the page is found and darkened within its hue (text-green-600 → text-green-700)", c1.findings.length === 1 && c1.findings[0].fixTo === "text-green-700" && c1.out.includes(`"text-xs text-green-700"`), JSON.stringify(c1.findings))
  const c2 = ctl(`${lucide}export const A = () => <Check className="h-4 w-4 text-green-600" />\n`)
  check("X2 an ICON is held to 3:1 (SC 1.4.11), so a status icon at 3.2:1 keeps its shade", c2.findings.length === 0, JSON.stringify(c2.findings))
  const c3 = ctl(`${lucide}export const A = () => <Fav className="h-4 w-4 text-yellow-500" />\n`)
  check("X3 an ICON below 3:1 (an aliased lucide import) is found and darkened (yellow-500 → yellow-700, 600 is 2.94)", c3.findings.length === 1 && c3.findings[0].context === "icon" && c3.findings[0].fixTo === "text-yellow-700", JSON.stringify(c3.findings))
  const c4 = ctl(`export const A = () => <div className="text-2xl font-bold text-green-600">42</div>\n`)
  check("X4 LARGE text (≥ text-2xl) is held to 3:1", c4.findings.length === 0, JSON.stringify(c4.findings))
  const c5 = ctl(`export const M = { ok: { cls: "bg-blue-100 text-blue-600" } }\n`)
  check("X5 a chip is measured against ITS OWN fill — blue-600 passes on the page (5.25) but not on blue-100 (4.30) → blue-700 — even in a status map outside JSX", c5.findings.length === 1 && c5.findings[0].on === "bg-blue-100" && c5.findings[0].fixTo === "text-blue-700", JSON.stringify(c5.findings))
  const c6 = ctl(`export const A = () => <div className="bg-gray-900 text-gray-400">x</div>\n`)
  check("X6 a string that paints its own DARK fill is not measured against the page", c6.findings.length === 0, JSON.stringify(c6.findings))
  const c7 = ctl(`export const A = () => <button className="bg-green-600 hover:bg-green-700 text-white">Go</button>\n`)
  check("X7 a white label on a saturated FILL below 4.5:1 is found; the fill and its hover move by the same steps", c7.findings.length === 1 && c7.findings[0].kind === "FILL" && c7.out.includes("bg-green-700 hover:bg-green-800 text-white"), JSON.stringify({ f: c7.findings, out: c7.out }))
  const c8 = ctl(`export const A = () => <a className="hover:text-green-600 md:text-amber-500">x</a>\n// className="text-green-600"\n/* "text-amber-500" */\n`)
  check("X8 variant-prefixed classes and COMMENTS are not code (a tombstone is not a call site, §2)", c8.findings.length === 0, JSON.stringify(c8.findings))
  const c9 = ctl("export const A = ({ on }: { on: boolean }) => <span className={`px-2 ${on ? \"text-green-600\" : \"text-gray-400\"}`}>x</span>\n")
  check("X9 literals nested in a template's interpolation are measured (both arms found and fixed)", c9.findings.length === 2 && c9.out.includes(`"text-green-700"`) && c9.out.includes(`"text-gray-500"`), JSON.stringify(c9.findings))
  const c10 = ctl("export const A = ({ d }: { d: string }) => <p className={`text-sm text-amber-600 ${d}`}>x</p>\n")
  check("X10 a template's STATIC text is rewritten without touching its interpolation", c10.out.includes("`text-sm text-amber-700 ${d}`"), c10.out)
  check("X11 the dark-section detector sees a dark fill, translucent white and a fill-less white label — and ignores a light module and a white label on its own fill",
    hasDarkSection(`<div className="bg-slate-900">`) && hasDarkSection(`<div className="border-white/10 bg-white/5">`) && hasDarkSection(`<h2 className="text-sm text-white">x</h2>`)
    && !hasDarkSection(`<div className="bg-slate-50 text-slate-600">`) && !hasDarkSection(`<button className="bg-blue-700 text-white">x</button>`))
  const badCss = `:root {\n  --background: 0 0% 100%;\n  --foreground: 0 0% 0%;\n  --destructive: 0 84.2% 60.2%;\n}\n`
  const badT = measureTokens(badCss, ":root", [{ fg: "white", bg: "destructive", min: AA_TEXT, why: "control" }, { fg: "foreground", bg: "background", min: AA_TEXT, why: "control" }])
  check("X12 the token reader FAILS the pre-fix destructive (#ef4444 under white, 3.76) and passes black on white", badT[0].ratio != null && badT[0].ratio < AA_TEXT && badT[1].ratio != null && badT[1].ratio > 20, badT.map((r) => r.detail).join(" | "))
  const c13 = ctl(`export const A = () => <span className="text-indigo-500">ok</span>\n`)
  check("X13 a shade that already passes is left alone (indigo-500 = 4.58 on white)", c13.findings.length === 0 && c13.edits === 0, JSON.stringify(c13.findings))
  const bubble = `export const B = () => <div className="rounded-lg bg-blue-600 text-white p-2">hi<p className="text-xs text-blue-200">10:02</p></div>\n`
  const c14 = scanModule(bubble, true, { holdPale: hasFilledSection(bubble) })
  check("X14 a PALE shade in a module that paints a saturated fill (the bubble timestamp) is found but HELD — never darkened onto its own bubble", hasFilledSection(bubble) && c14.findings.some((f) => f.pale && f.token === "text-blue-200") && c14.out.includes("text-blue-200"), JSON.stringify({ f: c14.findings, out: c14.out }))
  const empty = `import { MessageSquare } from "lucide-react"\nexport const E = () => <MessageSquare className="h-8 w-8 text-gray-300" />\n`
  const c15 = scanModule(empty, true, { holdPale: hasFilledSection(empty) })
  check("X15 a PALE icon in a light module (no saturated fill anywhere) IS darkened to 3:1 (gray-300 → gray-500)", !hasFilledSection(empty) && c15.out.includes("text-gray-500"), c15.out)

  // ── T · tokens ──────────────────────────────────────────────────────────────
  console.log("\n[T · the one palette — app/globals.css tokens, as the primitives render them]")
  const css = existsSync(CSS_PATH) ? readFileSync(CSS_PATH, "utf8") : ""
  check("T0 app/globals.css exists and is the stylesheet the root layout imports", !!css && /import\s+['"]\.\/globals\.css['"]/.test(readFileSync(join(ROOT, "app", "layout.tsx"), "utf8")))
  const light = measureTokens(css, ":root", LIGHT_PAIRS)
  for (const r of light) console.log(`    light · ${r.detail}`)
  const lightBad = light.filter((r) => r.ratio == null || r.ratio < r.pair.min)
  check(`T1 every LIGHT (live) pair meets its WCAG 2.2 threshold — ${light.length} pairs`, lightBad.length === 0, lightBad.map((r) => r.detail).join("; "))
  const dark = measureTokens(css, ".dark", DARK_PAIRS)
  for (const r of dark) console.log(`    dark  · ${r.detail}`)
  const darkBad = dark.filter((r) => r.ratio == null || r.ratio < r.pair.min)
  check(`T2 every DARK pair meets its threshold as the primitives composite it — ${dark.length} pairs (held so enabling dark mode never ships a failing palette)`, darkBad.length === 0, darkBad.map((r) => r.detail).join("; "))
  // T3 · one live palette: exactly one stylesheet the app imports defines the :root tokens
  const cssImports = new Set<string>()
  for (const f of walkTs(join(ROOT, "app"))) for (const m of readFileSync(f, "utf8").matchAll(/import\s+['"]([^'"]+\.css)['"]/g)) cssImports.add(m[1])
  const tokenSheets = [...cssImports].filter((p) => /globals\.css$/.test(p))
  check("T3 ONE live palette — the app imports exactly one token stylesheet (styles/globals.css is the unreferenced v0 template, not a second palette)", tokenSheets.length === 1, [...cssImports].join(", "))
  // T4 · publish whether dark mode is reachable at all
  const appTsx = walkTs(join(ROOT, "app")).filter((f) => f.endsWith(".tsx"))
  let darkActivators = 0, darkVariants = 0
  for (const f of appTsx) {
    const s = stripComments(readFileSync(f, "utf8"))
    darkActivators += (s.match(/classList\.(?:add|toggle)\(\s*["']dark["']|<ThemeProvider\b|\battribute=["']class["']/g) ?? []).length
    darkVariants += (s.match(/\bdark:[a-z]/g) ?? []).length
  }
  console.log(`    T4 published: ${darkActivators} dark-mode activators in app/**/*.tsx; ${darkVariants} \`dark:\` variants (inert while 0 activators)`)
  check("T4 the dark-mode census ran over the app (its count is published, not assumed)", appTsx.length > 500)
  if (darkActivators === 0) console.log("    T4 dark mode is UNREACHABLE at HEAD — the live palette is the light one; T2 holds the dark tokens anyway")

  // ── P · primitives ──────────────────────────────────────────────────────────
  console.log("\n[P · every focusable primitive shows focus]")
  const FOCUSABLE_PRIMITIVES = ["button", "input", "textarea", "select", "checkbox", "radio-group", "switch", "tabs", "toggle", "toggle-group", "slider", "accordion", "dialog", "sheet", "badge", "dropdown-menu", "calendar"]
  const noFocus = FOCUSABLE_PRIMITIVES.filter((p) => {
    const f = join(ROOT, "app", "components", "ui", `${p}.tsx`)
    return !existsSync(f) || !/focus-visible:|(?:^|[\s"'`])focus:|has-focus:/.test(readFileSync(f, "utf8"))
  })
  check(`P1 the ${FOCUSABLE_PRIMITIVES.length} focusable primitives in app/components/ui each declare a visible focus style`, noFocus.length === 0, noFocus.join(", "))

  // ── C / B · the screens ─────────────────────────────────────────────────────
  console.log("\n[C / B · coloured text and action fills on every screen]")
  const POP = appTsx.filter((f) => !/\/app\/components\/ui\//.test(f) && !/\/app\/api\//.test(f)).filter((f) => !ONLY || rel(f).startsWith(ONLY))
  type Row = { file: string; f: Finding }
  const hard: Row[] = [], darkSec: Row[] = [], paleHeld: Row[] = [], other: Record<string, Row[]> = {}
  const perJourney: Record<string, { modules: number; text: number; fill: number }> = {}
  let edited = 0, editedModules = 0
  for (const abs of POP) {
    const f = rel(abs)
    const src = readFileSync(abs, "utf8")
    const lane = otherLaneOf(f)
    const stripped = stripComments(src)
    const darkFile = hasDarkSection(stripped)
    const filledFile = hasFilledSection(stripped)
    const mayFix = FIX && !lane && !darkFile
    const { findings, out, edits } = scanModule(src, mayFix, { holdPale: filledFile })
    if (mayFix && edits > 0 && out !== src) { writeFileSync(abs, out); edited += edits; editedModules++ }
    // After a fix, re-read what is now on disk — the check judges the tree, not the intent.
    const now = mayFix && edits > 0 ? scanModule(out, false, { holdPale: filledFile }).findings : findings
    const j = journeyOf(f) ?? "(outside every journey)"
    perJourney[j] ??= { modules: 0, text: 0, fill: 0 }
    perJourney[j].modules++
    for (const fd of now) {
      perJourney[j][fd.kind === "TEXT" ? "text" : "fill"]++
      const row = { file: f, f: fd }
      if (lane) (other[lane] ??= []).push(row)
      else if (darkFile) darkSec.push(row)
      else if (filledFile && fd.pale && fd.kind === "TEXT") paleHeld.push(row)
      else hard.push(row)
    }
  }
  if (FIX) console.log(`    --fix rewrote ${edited} class string(s) in ${editedModules} module(s) (other-lane directories and dark-section modules untouched)`)
  console.log(`    denominator: ${POP.length} modules (app/**/*.tsx minus ui primitives and api) · ${Object.keys(perJourney).length} journeys`)
  for (const [j, v] of Object.entries(perJourney).sort()) if (v.text + v.fill > 0) console.log(`      ${j}: ${v.text} text · ${v.fill} fill (${v.modules} modules)`)
  const show = (rows: Row[], n = 25) => rows.slice(0, n).map((r) => `${r.file}:${r.f.line} ${r.f.token} ${r.f.ratio.toFixed(2)}<${r.f.min} on ${r.f.on} (${r.f.context}) → ${r.f.fixTo ?? "no passing shade"}`).join("\n        ")
  check(`C1 HARD ZERO — no coloured text below its threshold on the modules this lane owns (light-context, no dark section)`, hard.filter((r) => r.f.kind === "TEXT").length === 0, "\n        " + show(hard.filter((r) => r.f.kind === "TEXT")))
  check(`B1 HARD ZERO — no white label on a sub-AA saturated fill on the modules this lane owns`, hard.filter((r) => r.f.kind === "FILL").length === 0, "\n        " + show(hard.filter((r) => r.f.kind === "FILL")))
  const unfixable = [...hard, ...darkSec, ...paleHeld, ...Object.values(other).flat()].filter((r) => !r.f.fixTo)
  check("C2 every finding has a passing darker shade in its own hue (the fix never changes hue)", unfixable.length === 0, show(unfixable))
  for (const [dir, rows] of Object.entries(other)) console.log(`    OUTSIDE-LANE ${dir} (${OTHER_LANE_DIRS[dir]}): ${rows.length} finding(s) in ${new Set(rows.map((r) => r.file)).size} module(s) — the owning lane runs \`npx tsx scripts/ui-palette-contrast-guard.ts --fix --only ${dir}\``)
  console.log(`    DARK-SECTION modules (ratchet; a parent fill the string cannot see): ${darkSec.length} finding(s) in ${new Set(darkSec.map((r) => r.file)).size} module(s)`)
  console.log(`    PALE shades held in modules with a saturated fill (ratchet; presumed to sit on that fill): ${paleHeld.length} finding(s) in ${new Set(paleHeld.map((r) => r.file)).size} module(s)`)

  // ── R · ratchets ────────────────────────────────────────────────────────────
  console.log("\n[R · ratchets — shrink-only outside the hard zero]")
  const counts: Record<string, number> = {
    "darkSection.TEXT": darkSec.filter((r) => r.f.kind === "TEXT").length,
    "darkSection.FILL": darkSec.filter((r) => r.f.kind === "FILL").length,
    "paleOnFilledModule.TEXT": paleHeld.length,
  }
  for (const dir of Object.keys(OTHER_LANE_DIRS)) {
    counts[`otherLane.${dir}.TEXT`] = (other[dir] ?? []).filter((r) => r.f.kind === "TEXT").length
    counts[`otherLane.${dir}.FILL`] = (other[dir] ?? []).filter((r) => r.f.kind === "FILL").length
  }
  if (ONLY) { console.log("    (--only: ratchets not judged on a partial population)") }
  else {
    if (WRITE_BASELINE) {
      writeFileSync(BASELINE_PATH, JSON.stringify({ _: "Shrink-only ratchets for scripts/ui-palette-contrast-guard.ts (wave 146, lane 146H). darkSection.* = sub-AA coloured text / white-on-fill in modules that also paint a dark section (a parent fill the class string cannot see, so --fix does not touch them); paleOnFilledModule.TEXT = a pale (50–300) text shade in a module that paints a saturated fill (presumed to sit on it; held); otherLane.<dir>.* = the same findings in a directory another wave-146 lane owns (fix there with --fix --only <dir>). Each may only fall; regenerate deliberately with --write-baseline and say why.", counts }, null, 2) + "\n")
      console.log(`    baseline written: ${JSON.stringify(counts)}`)
    }
    const baseline = existsSync(BASELINE_PATH) ? (JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as { counts: Record<string, number> }).counts : {}
    const grew = Object.entries(counts).filter(([k, n]) => n > (baseline[k] ?? 0)).map(([k, n]) => `${k} ${baseline[k] ?? 0} → ${n}`)
    console.log(`    counts: ${Object.entries(counts).map(([k, n]) => `${k}=${n}`).join(" · ")}`)
    check("R1 no ratcheted count grew", grew.length === 0, grew.join(", "))
    check("R2 the baseline file exists and names every ratcheted key", Object.keys(counts).every((k) => k in baseline), Object.keys(counts).filter((k) => !(k in baseline)).join(", "))
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
  if (fail) { console.log("FAILURES:\n  - " + fails.join("\n  - ")); process.exit(1) }
  console.log("✅ UI_PALETTE_CONTRAST_PASS — one palette, every measured pair at WCAG 2.2 AA; no sub-AA coloured text or action fill on this lane's screens")
}
// Run only when invoked as the guard, so a canary can import scanModule / measureTokens / the pair tables
// without running (and rewriting with --fix) the whole tree.
if (/ui-palette-contrast-guard\.ts$/.test(process.argv[1] ?? "")) main().catch((e) => { console.error(e); process.exit(1) })

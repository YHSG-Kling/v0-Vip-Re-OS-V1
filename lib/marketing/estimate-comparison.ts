// lib/marketing/estimate-comparison.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ESTIMATE COMPARISON PIECE (wave 82, lane 82D — owner verbatim: "taking
// the estimates on every real estate page that we retired as screenshots,
// merging to show each value on those pages listing the property page (on
// realtorcom, on homes.com....) for a marketing piece like..finding out what
// your home is worth in todays market can make you feel overwhelmed when
// comparing all of these sites...we can help ..or something similar and catchy
// and you are the expert in real estate viral and effective content.").
//
// ALREADY EXISTED — REUSED, never rebuilt:
//   · lib/assets/screenshot-capture.ts — THE seam, for the Zillow still only
//     (82D's `hostScope: "estimate_comparison"` for the other three portals is
//     retired at 83C — their figures come from lib/marketing/
//     estimate-web-search.ts, an AI web search, never a screenshot).
//   · lib/marketing/tenant-screenshot-door.ts captureTenantEstimateStill — the
//     Zillow card rides the EXISTING campaign still (a Zestimate still is
//     campaign material; the comparison is a campaign).
//   · lib/marketing/estimate-sources.ts — the ONE vocabulary: the campaign
//     source (Zillow) + COMPARISON_ESTIMATE_SOURCES + estimateStillUseVerdict.
//   · app/actions/marketing-studio.ts approveAsset / rejectAsset — the human
//     approval rail every capture and the composite land on (pending).
//   · lib/remotion/media-host.ts hostRenderedMedia — the ONE media host.
//   · sharp — already the SVG→PNG rasterizer (lib/video/composite-attribution.ts).
//   · lib/marketing/creative-playbooks.ts — the `estimate_comparison` play
//     installs through the SAME rail as the Zestimate Challenge; its channel
//     copy stays AI-authored from briefs (the catalog's owner rule), while the
//     ON-IMAGE words below are the vetted layout copy the creative prints.
//
// HOW THE NUMBERS GET ON THE PIECE. ZILLOW: a human approves the Zestimate
// still, then CONFIRMS the figure they see on it (confirmComparisonFigure).
// REALTOR.COM / REDFIN / HOMES.COM (wave 83C — owner: "we should use ai to
// search the internet for the property and what realtor.com, homes.com and
// redfin [show]"): NO SCREENSHOT. lib/marketing/estimate-web-search.ts runs an
// AI web search for the territory property, extracts the figure with its source
// URL and date (facts only, verified verbatim), and stages it PENDING; the
// human's approval confirms it. When the search finds nothing, a person types
// the figure (the fallback), which lands pending too. Only approved + confirmed
// cards are composed, at least two. The three figure_only portals print as
// TEXT under a plain, logo-free label (estimate-sources.ts ToS posture).
//
// NEVER AN ESTIMATE OF VALUE: the piece shows the websites' figures as what
// they are, the spread between them, and invites a no-obligation home-value
// review. It promises no number, names no agent opinion of value, and carries
// the disclaimer on every format (NAR SoP 11-1; TALCB; USPAP AO-18).
//
// Every DB-touching dependency is imported lazily so the pure composer loads
// under tsx for scripts/estimate-comparison-guard.ts.

import {
  COMPARISON_ESTIMATE_SOURCES, comparisonEstimateSource, estimateStillUseVerdict, ESTIMATE_COMPARISON_USE,
  type ComparisonEstimateSourceKey,
} from "@/lib/marketing/estimate-sources"

// ── THE COPY (written as the lane's expert pass; see $S/lane82D-notes.md) ────
// Hook psychology: pattern interrupt on a number mismatch (curiosity gap), the
// homeowner's own overwhelm named back to them (recognition), contrarian truth
// ("it only sells for one"). CTA: a review, never a number (value-review rule).
// Fair-housing clean: no people, no neighborhoods-as-people, no schools, no
// steering — the only subject is the house and the websites.

export const COMPARISON_HOOKS = [
  { key: "four_sites", text: "{count} websites. {count} different prices. Which one is right?" },
  { key: "overwhelmed", text: "Looked up your home's value online and felt more confused? You're not alone." },
  { key: "sells_for_one", text: "Your home has {count} online prices. It only sells for one." },
  { key: "spread", text: "{spread} apart. Same house. Same day." },
  { key: "cant_agree", text: "The internet can't agree on what your home is worth." },
] as const
export type ComparisonHookKey = (typeof COMPARISON_HOOKS)[number]["key"]

export const COMPARISON_SUBHEAD =
  "Each site runs its own model on its own data, and none of them has been inside your home. A local review looks at what the algorithms can't: condition, updates, and what buyers are actually paying nearby."

export const COMPARISON_CTAS = {
  print: "Scan for a free, no-obligation home-value review",
  social: "DM \"VALUE\" for a no-obligation home-value review",
  web: "Request your no-obligation home-value review",
  video: "Book a free, no-obligation home-value review",
} as const
export type ComparisonChannel = keyof typeof COMPARISON_CTAS

export const COMPARISON_SOCIAL_CAPTION =
  "{hook}\n\nIf you've looked up your home's value online and walked away more confused than when you started, that's not you — it's the math. Each website runs its own model on its own data, and none of them has walked through your kitchen.\n\nThe spread on this one home: {spread}.\n\nWant a local, human read on what buyers are actually paying? DM \"VALUE\" and we'll set up a no-obligation home-value review.\n\n{disclaimer}"

export const COMPARISON_EMAIL_SUBJECT = "Why {count} websites can't agree on your home's value"

/** The four-beat script the video producer stages with the `screenshot`
 *  body treatment (the composite + the Zillow still as screens). */
export const COMPARISON_VIDEO_BEATS = [
  "Hook — {hook}",
  "The cards — each website's figure on screen, one at a time; the spread lands last.",
  "Why — every site uses different data, and none has seen the inside of the home.",
  "Invite — {cta}. No pressure, no obligation.",
] as const

export function comparisonDisclaimer(capturedOn: string): string {
  return `Figures shown as published by each website on ${capturedOn}. They are automated estimates, not appraisals, and not this brokerage's opinion of value. Trademarks belong to their owners; no affiliation or endorsement is implied.`
}

// ── Pure composer ────────────────────────────────────────────────────────────

/** One piece of evidence: an approved Zillow still + the figure a human
 *  confirmed on it, or (83C) an approved web-searched / typed portal figure. */
export interface ComparisonEvidence {
  assetId: string
  source: string
  /** The still (Zillow) — or, for a web figure, the portal page it came from. */
  url: string | null
  approvalStatus: string | null
  capturedAt: string | null
  /** The confirmed figure (whole USD): typed off an approved still, or the
   *  web-searched figure once a human approved it. */
  confirmedFigureUsd: number | null
  /** How it arrived (83C). Omitted = a still (the 82D shape). */
  via?: "still" | "web_search" | "human_typed"
  /** Web figures: a plain provider detail for the card label (realtor.com's panel). */
  labelDetail?: string | null
}

export interface ComparisonCard {
  source: ComparisonEstimateSourceKey
  label: string
  figureUsd: number
  figureText: string
  capturedOn: string
  /** Only for a still_with_attribution source (Zillow) — never a figure_only portal's pixels. */
  stillUrl: string | null
  evidenceAssetId: string
  isHigh: boolean
  isLow: boolean
}

export type ComparisonLayout = "row" | "grid" | "stacked"
export const COMPARISON_FORMATS = {
  postcard_6x9: { width: 2700, height: 1800, layout: "row" as ComparisonLayout, channel: "print" as ComparisonChannel },
  social_square: { width: 1080, height: 1080, layout: "grid" as ComparisonLayout, channel: "social" as ComparisonChannel },
  story_vertical: { width: 1080, height: 1920, layout: "stacked" as ComparisonLayout, channel: "social" as ComparisonChannel },
} as const
export type ComparisonFormat = keyof typeof COMPARISON_FORMATS

export const MIN_COMPARISON_CARDS = 2
/** Sanity band for a human-typed figure (whole USD). */
export const FIGURE_MIN_USD = 10_000
export const FIGURE_MAX_USD = 100_000_000

export function formatUsd(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`
}

export function validateConfirmedFigure(raw: unknown): { ok: true; figureUsd: number } | { ok: false; reason: string } {
  const n = typeof raw === "number" ? raw : Number(String(raw ?? "").replace(/[$,\s]/g, ""))
  if (!Number.isFinite(n) || !Number.isInteger(Math.round(n))) return { ok: false, reason: "the confirmed figure must be a whole-dollar number read off the approved still" }
  const r = Math.round(n)
  if (r < FIGURE_MIN_USD || r > FIGURE_MAX_USD) return { ok: false, reason: `the confirmed figure ${formatUsd(r)} is outside ${formatUsd(FIGURE_MIN_USD)}–${formatUsd(FIGURE_MAX_USD)} — check what the still shows` }
  return { ok: true, figureUsd: r }
}

export interface ComparisonPlan {
  ok: true
  cards: ComparisonCard[]
  lowUsd: number
  highUsd: number
  spreadUsd: number
  spreadText: string
  spreadPct: number
  capturedOn: string
  /** Why a source did not make the piece (not captured, pending, figure unconfirmed…). */
  omitted: Array<{ source: string; reason: string }>
}

/** PURE, FAIL-CLOSED: the cards a piece may carry — approved evidence with a
 *  confirmed figure, one per source (newest wins), the verdict asked per card;
 *  refused below MIN_COMPARISON_CARDS. WAVE 83C: a web-searched portal's card
 *  comes ONLY from a web-searched or typed figure — a screenshot of that site
 *  (an 82D capture) never makes a card any more. */
export function planComparisonCards(evidence: readonly ComparisonEvidence[]): ComparisonPlan | { ok: false; reason: string; omitted: Array<{ source: string; reason: string }> } {
  const omitted: Array<{ source: string; reason: string }> = []
  const cards: ComparisonCard[] = []
  for (const src of COMPARISON_ESTIMATE_SOURCES) {
    const admissible = (e: ComparisonEvidence) => src.evidenceVia === "web_search" ? (e.via === "web_search" || e.via === "human_typed") : (e.via ?? "still") === "still"
    const all = evidence.filter((e) => e.source === src.key)
    const rows = all.filter(admissible).sort((a, b) => String(b.capturedAt ?? "").localeCompare(String(a.capturedAt ?? "")))
    if (!rows.length) {
      omitted.push({ source: src.key, reason: all.length ? "only a screenshot of this site is on file — screenshots of it are no longer used; run the web search or type the figure it shows" : src.evidenceVia === "web_search" ? "no figure yet — run the web search (or type the figure the site shows)" : "no capture yet" })
      continue
    }
    const e = rows.find((r) => r.approvalStatus === "approved" && r.confirmedFigureUsd != null) ?? null
    if (!e) {
      const any = rows[0]
      omitted.push({ source: src.key, reason: any.approvalStatus !== "approved" ? `${src.evidenceVia === "web_search" ? "figure" : "capture"} ${any.approvalStatus ?? "pending"} — approve it first` : "figure not confirmed — type the figure the still shows" })
      continue
    }
    const verdict = estimateStillUseVerdict(src.key, ESTIMATE_COMPARISON_USE)
    if (!verdict.ok) { omitted.push({ source: src.key, reason: verdict.reason }); continue }
    const fig = validateConfirmedFigure(e.confirmedFigureUsd)
    if (!fig.ok) { omitted.push({ source: src.key, reason: fig.reason }); continue }
    const detail = (e.labelDetail ?? "").replace(/[®™℠©]/g, "").trim().slice(0, 28)
    cards.push({
      source: src.key, label: detail ? `${src.cardLabel} · ${detail}` : src.cardLabel, figureUsd: fig.figureUsd, figureText: formatUsd(fig.figureUsd),
      capturedOn: String(e.capturedAt ?? "").slice(0, 10), stillUrl: src.posture === "still_with_attribution" ? e.url : null,
      evidenceAssetId: e.assetId, isHigh: false, isLow: false,
    })
  }
  if (cards.length < MIN_COMPARISON_CARDS) {
    return { ok: false, reason: `an estimate comparison needs at least ${MIN_COMPARISON_CARDS} approved captures with confirmed figures (have ${cards.length})`, omitted }
  }
  const lowUsd = Math.min(...cards.map((c) => c.figureUsd))
  const highUsd = Math.max(...cards.map((c) => c.figureUsd))
  for (const c of cards) { c.isHigh = c.figureUsd === highUsd && highUsd !== lowUsd; c.isLow = c.figureUsd === lowUsd && highUsd !== lowUsd }
  const spreadUsd = highUsd - lowUsd
  const dates = cards.map((c) => c.capturedOn).filter(Boolean).sort()
  const capturedOn = dates.length ? dates[dates.length - 1] : ""
  return { ok: true, cards, lowUsd, highUsd, spreadUsd, spreadText: formatUsd(spreadUsd), spreadPct: lowUsd > 0 ? Math.round((spreadUsd / lowUsd) * 1000) / 10 : 0, capturedOn, omitted }
}

export interface ComparisonCopy {
  hookKey: ComparisonHookKey
  headline: string
  subhead: string
  spreadLine: string
  cta: string
  disclaimer: string
  socialCaption: string
  emailSubject: string
  videoBeats: string[]
}

/** PURE: the on-image words for a plan + channel. The `spread` hook is used
 *  only when the websites genuinely disagree (spread > 0). */
export function comparisonCopy(plan: ComparisonPlan, opts: { hookKey?: ComparisonHookKey; channel?: ComparisonChannel } = {}): ComparisonCopy {
  const count = String(plan.cards.length)
  const wanted = opts.hookKey && (opts.hookKey !== "spread" || plan.spreadUsd > 0) ? opts.hookKey : "four_sites"
  const hookDef = COMPARISON_HOOKS.find((h) => h.key === wanted) ?? COMPARISON_HOOKS[0]
  const fill = (t: string) => t.replace(/\{count\}/g, count).replace(/\{spread\}/g, plan.spreadText)
  const headline = fill(hookDef.text)
  const cta = COMPARISON_CTAS[opts.channel ?? "print"]
  const disclaimer = comparisonDisclaimer(plan.capturedOn)
  return {
    hookKey: hookDef.key, headline, subhead: COMPARISON_SUBHEAD,
    spreadLine: plan.spreadUsd > 0 ? `${plan.spreadText} between the highest and lowest estimate` : "Every site landed on the same figure — rare, and still not a price",
    cta, disclaimer,
    socialCaption: fill(COMPARISON_SOCIAL_CAPTION).replace("{hook}", headline).replace("{disclaimer}", disclaimer),
    emailSubject: fill(COMPARISON_EMAIL_SUBJECT),
    videoBeats: COMPARISON_VIDEO_BEATS.map((b) => b.replace("{hook}", headline).replace("{cta}", COMPARISON_CTAS.video)),
  }
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

/** Wrap text into lines of at most `max` characters (word boundaries). */
function wrap(text: string, max: number): string[] {
  const out: string[] = []
  let line = ""
  for (const w of text.split(/\s+/)) {
    if ((line + " " + w).trim().length > max && line) { out.push(line); line = w } else line = (line + " " + w).trim()
  }
  if (line) out.push(line)
  return out
}

/**
 * PURE: the creative as SVG — cards in a row (6x9 postcard), a 2x2 grid
 * (square) or stacked (story); each card a logo-free label + its figure +
 * capture date, the high/low marked; the hook, the "why" line, the spread, the
 * CTA (+ the tracked QR on print), the brand and the disclaimer + EHO line.
 * Text only: no portal pixels, no logos (figure_only posture). Every wrap
 * width is derived from the geometry (≈0.55 em per character, Helvetica).
 */
export function renderComparisonSvg(
  plan: ComparisonPlan, copy: ComparisonCopy, format: ComparisonFormat,
  brand: ComparisonBrand = { name: "" },
  qrDataUrl?: string | null,
): string {
  const f = COMPARISON_FORMATS[format]
  const W = f.width, H = f.height
  const s = Math.min(W, H) / 1080
  const color = /^#[0-9a-f]{6}$/i.test(brand.primaryColor ?? "") ? String(brand.primaryColor) : "#1f3a5f"
  const pad = 60 * s
  const fontFamily = `font-family="Helvetica, Arial, sans-serif"`
  const chars = (width: number, font: number) => Math.max(8, Math.floor(width / (0.55 * font)))
  const text = (x: number, y: number, size: number, body: string, extra = "") => `<text x="${Math.round(x)}" y="${Math.round(y)}" ${fontFamily} font-size="${Math.round(size)}"${extra ? " " + extra : ""}>${esc(body)}</text>`
  const parts: string[] = []
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`)
  parts.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`)
  parts.push(`<rect width="${W}" height="${Math.round(12 * s)}" fill="${color}"/>`)

  // ── top: hook + why ──
  const hf = 58 * s
  let y = pad + hf
  for (const l of wrap(copy.headline, chars(W - pad * 2, hf))) { parts.push(text(pad, y, hf, l, `font-weight="700" fill="#111827"`)); y += hf * 1.17 }
  if (format !== "social_square") {
    const sf = 26 * s
    y += 6 * s
    for (const l of wrap(copy.subhead, chars(W - pad * 2, sf))) { parts.push(text(pad, y, sf, l, `fill="#374151"`)); y += sf * 1.3 }
  }
  y += 18 * s

  // ── bottom (laid out from the bottom up): disclaimer + EHO, brand, QR ──
  const df = 17 * s, dlh = 22 * s
  const dLines = wrap([copy.disclaimer, brand.fairHousingLine ?? ""].filter(Boolean).join(" "), chars(W - pad * 2, df))
  const dTop = H - pad - (dLines.length - 1) * dlh
  const showQr = !!qrDataUrl && f.channel === "print"
  const qrSize = 200 * s
  const brandY = dTop - df - 14 * s
  // ── middle: cards ──
  const cols = format === "postcard_6x9" ? Math.min(4, plan.cards.length) : f.layout === "grid" ? 2 : 1
  const rows = Math.ceil(plan.cards.length / cols)
  const gap = 24 * s
  const spreadF = 34 * s, ctaF = 32 * s
  const textRight = showQr ? W - pad - qrSize - 30 * s : W - pad
  const ctaLines = wrap(copy.cta, chars(textRight - pad, ctaF))
  const spreadLines = wrap(copy.spreadLine, chars(textRight - pad, spreadF))
  const belowCards = 40 * s + spreadLines.length * spreadF * 1.25 + 10 * s + ctaLines.length * ctaF * 1.3
  const bottomBlock = Math.max(belowCards, showQr ? qrSize + 20 * s : 0)
  const cardW = (W - pad * 2 - gap * (cols - 1)) / cols
  const cardH = Math.max(120 * s, Math.min(230 * s, (brandY - 30 * s - bottomBlock - y - gap * (rows - 1)) / rows))
  const labelF = Math.min(30 * s, (cardW - 56 * s) / (0.55 * 22))
  const figF = Math.min(64 * s, (cardW - 56 * s) / (0.62 * 9))
  plan.cards.forEach((c, i) => {
    const cx = pad + (i % cols) * (cardW + gap)
    const cy = y + Math.floor(i / cols) * (cardH + gap)
    const tag = c.isHigh ? "HIGHEST" : c.isLow ? "LOWEST" : ""
    parts.push(`<rect x="${Math.round(cx)}" y="${Math.round(cy)}" width="${Math.round(cardW)}" height="${Math.round(cardH)}" rx="${Math.round(18 * s)}" fill="#f3f4f6" stroke="${tag ? color : "#d1d5db"}" stroke-width="${Math.round(3 * s)}"/>`)
    parts.push(text(cx + 28 * s, cy + 24 * s + labelF, labelF, c.label, `fill="#374151"`))
    parts.push(text(cx + 28 * s, cy + cardH * 0.64, figF, c.figureText, `font-weight="700" fill="#111827"`))
    parts.push(text(cx + 28 * s, cy + cardH - 22 * s, 20 * s, `as shown ${c.capturedOn}`, `fill="#6b7280"`))
    if (tag) parts.push(text(cx + cardW - 28 * s, cy + cardH - 22 * s, 22 * s, tag, `text-anchor="end" font-weight="700" fill="${color}"`))
  })
  y += rows * cardH + (rows - 1) * gap + 40 * s + spreadF
  for (const l of spreadLines) { parts.push(text(pad, y, spreadF, l, `font-weight="700" fill="${color}"`)); y += spreadF * 1.25 }
  y += 10 * s
  for (const l of ctaLines) { parts.push(text(pad, y, ctaF, l, `fill="#111827"`)); y += ctaF * 1.3 }
  if (showQr) parts.push(`<image x="${Math.round(W - pad - qrSize)}" y="${Math.round(brandY - 30 * s - qrSize)}" width="${Math.round(qrSize)}" height="${Math.round(qrSize)}" href="${esc(qrDataUrl!)}"/>`)
  if (brand.name) parts.push(text(W - pad, brandY, 26 * s, brand.name, `text-anchor="end" font-weight="700" fill="#111827"`))
  let dy = dTop
  for (const l of dLines) { parts.push(text(pad, dy, df, l, `fill="#6b7280"`)); dy += dlh }
  parts.push(`</svg>`)
  return parts.join("")
}

/** Brand inputs for the piece (lib/branding/resolve-brand-context.ts — the ONE
 *  cascade): the display name, the primary colour, and the Equal Housing
 *  Opportunity short disclosure every advertisement carries. */
export interface ComparisonBrand { name: string; primaryColor?: string | null; fairHousingLine?: string | null }

export interface EstimateComparisonCreative {
  ok: true
  plan: ComparisonPlan
  copy: ComparisonCopy
  svgs: Record<ComparisonFormat, string>
  /** What the video producer stages as input_props.screenshotUrls: the Zillow
   *  still (still_with_attribution) — the composite PNGs are appended once hosted. */
  videoStillUrls: string[]
  customerFacingValue: false
}

/** PURE: evidence → plan → copy → every format's SVG. */
export function composeEstimateComparison(
  evidence: readonly ComparisonEvidence[],
  opts: { hookKey?: ComparisonHookKey; brand?: ComparisonBrand; qrDataUrl?: string | null } = {},
): EstimateComparisonCreative | { ok: false; reason: string; omitted: Array<{ source: string; reason: string }> } {
  const plan = planComparisonCards(evidence)
  if (!plan.ok) return plan
  const copy = comparisonCopy(plan, { hookKey: opts.hookKey, channel: "print" })
  const svgs = Object.fromEntries((Object.keys(COMPARISON_FORMATS) as ComparisonFormat[]).map((fmt) => {
    const c = COMPARISON_FORMATS[fmt].channel === "print" ? copy : { ...copy, cta: COMPARISON_CTAS[COMPARISON_FORMATS[fmt].channel] }
    return [fmt, renderComparisonSvg(plan, c, fmt, opts.brand, opts.qrDataUrl)]
  })) as Record<ComparisonFormat, string>
  return { ok: true, plan, copy, svgs, videoStillUrls: plan.cards.map((c) => c.stillUrl).filter((u): u is string => !!u), customerFacingValue: false }
}

// ── DB side (lazy) ───────────────────────────────────────────────────────────

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ")

export type ComparisonGatherOutcome =
  | { source: ComparisonEstimateSourceKey; ok: true; via: "still" | "web_search"; assetId: string; note: string }
  | { source: ComparisonEstimateSourceKey; ok: false; via: "still" | "web_search"; reason: string; fallback: boolean }

/**
 * Gather the evidence for every comparison source, PENDING. Zillow: the
 * campaign still door (a Zestimate still is campaign material). Realtor.com /
 * Redfin / Homes.com (wave 83C): NO screenshot — an AI web search for the
 * territory property through lib/marketing/estimate-web-search.ts, each found
 * figure staged pending with its source URL and date. A portal the search
 * could not read reports `fallback: true` (a person types the figure).
 *
 * TOMBSTONE (§1.3, 83C): `captureEstimateComparisonStills` (82D) screenshotted
 * the three portals through the seam's comparison scope; it is replaced here
 * (same callers: app/actions/creative-playbooks.ts, app/actions/marketing/
 * tenant-screenshots.ts) and the seam scope is retired
 * (lib/assets/screenshot-capture.ts, the 83C tombstone above readyRulesForHost).
 */
export async function gatherEstimateComparisonEvidence(
  args: { svc: any; brokerageId: string; userId: string | null; address: string; listingId?: string | null },
  deps: { still?: Record<string, unknown>; web?: import("@/lib/marketing/estimate-web-search").WebEstimateDeps } = {},
): Promise<{ ok: true; outcomes: ComparisonGatherOutcome[] } | { ok: false; reason: string }> {
  if (!args.brokerageId) return { ok: false, reason: "REFUSED: an estimate comparison needs the session's brokerage id" }
  const address = (args.address ?? "").trim().replace(/\s+/g, " ")
  if (address.length < 6) return { ok: false, reason: "an estimate comparison needs a street address (6+ characters)" }
  const { captureTenantEstimateStill } = await import("@/lib/marketing/tenant-screenshot-door")
  const { stageWebEstimateFigures } = await import("@/lib/marketing/estimate-web-search")
  const outcomes: ComparisonGatherOutcome[] = []
  for (const src of COMPARISON_ESTIMATE_SOURCES.filter((s) => s.evidenceVia === "still")) {
    const r = await captureTenantEstimateStill({ brokerageId: args.brokerageId, userId: args.userId, source: src.key, address, listingId: args.listingId ?? null }, { ...((deps.still ?? {}) as any), svc: args.svc })
    outcomes.push(r.ok ? { source: src.key, ok: true, via: "still", assetId: r.assetId, note: r.cached ? "still already captured today (pending/approved)" : "still captured (pending your approval)" } : { source: src.key, ok: false, via: "still", reason: r.reason, fallback: false })
  }
  const web = await stageWebEstimateFigures({ svc: args.svc, brokerageId: args.brokerageId, userId: args.userId, address, listingId: args.listingId ?? null }, deps.web ?? {})
  if (!web.ok) {
    for (const src of COMPARISON_ESTIMATE_SOURCES.filter((s) => s.evidenceVia === "web_search")) outcomes.push({ source: src.key, ok: false, via: "web_search", reason: web.reason, fallback: false })
  } else {
    for (const o of web.outcomes) {
      if (o.state === "staged") outcomes.push({ source: o.source, ok: true, via: "web_search", assetId: o.assetId, note: `found ${formatUsd(o.figureUsd)} on ${o.sourceUrl} (pending your approval)` })
      else if (o.state === "already_staged") outcomes.push({ source: o.source, ok: true, via: "web_search", assetId: o.assetId, note: "a figure is already staged for this address" })
      else outcomes.push({ source: o.source, ok: false, via: "web_search", reason: o.reason, fallback: o.state === "not_found" })
    }
  }
  return { ok: true, outcomes }
}

/** DB: the tenant's comparison evidence for an address (every approval
 *  state), tenant-predicated — the Zillow stills AND (83C) the staged web /
 *  typed figures. A web figure's approval IS its confirmation (the human saw
 *  the figure, its source link and date before approving); a later typed
 *  correction (confirmComparisonFigure) wins over the extracted figure. */
export async function listComparisonEvidence(svc: any, brokerageId: string, address: string): Promise<ComparisonEvidence[]> {
  if (!brokerageId) return []
  const { SCREENSHOT_ASSET_KIND } = await import("@/lib/assets/screenshot-capture")
  const { ESTIMATE_WEB_FIGURE_KIND } = await import("@/lib/marketing/estimate-web-search")
  const [stills, figures] = await Promise.all([
    svc.from("marketing_assets")
      .select("id, asset_url, approval_status, metadata")
      .eq("asset_type", "image").eq("visibility_scope", "brokerage").eq("brokerage_id", brokerageId)
      .eq("metadata->>asset_kind", SCREENSHOT_ASSET_KIND)
      .order("updated_at", { ascending: false }).limit(200),
    svc.from("marketing_assets")
      .select("id, asset_url, approval_status, metadata")
      .eq("asset_type", "snippet").eq("visibility_scope", "brokerage").eq("brokerage_id", brokerageId)
      .eq("metadata->>asset_kind", ESTIMATE_WEB_FIGURE_KIND)
      .order("updated_at", { ascending: false }).limit(200),
  ])
  if (stills.error) console.error("[estimate-comparison] still evidence read refused:", stills.error.message)
  if (figures.error) console.error("[estimate-comparison] web figure read refused:", figures.error.message)
  const want = norm(address)
  type Row = { id: string; asset_url: string | null; approval_status: string | null; metadata: Record<string, any> | null }
  const mine = (rows: Row[] | null | undefined) => ((rows ?? []) as Row[]).filter((r) => comparisonEstimateSource(r.metadata?.estimate_source) && (!want || norm(r.metadata?.address) === want))
  const num = (v: unknown) => (typeof v === "number" ? v : null)
  return [
    ...mine(stills.error ? [] : stills.data).map((r): ComparisonEvidence => ({
      assetId: r.id, source: String(r.metadata?.estimate_source), url: r.asset_url, approvalStatus: r.approval_status, via: "still",
      capturedAt: typeof r.metadata?.captured_at === "string" ? r.metadata.captured_at : null,
      confirmedFigureUsd: num(r.metadata?.confirmed_figure_usd),
    })),
    ...mine(figures.error ? [] : figures.data).map((r): ComparisonEvidence => ({
      assetId: r.id, source: String(r.metadata?.estimate_source), url: typeof r.metadata?.source_url === "string" ? r.metadata.source_url : null,
      approvalStatus: r.approval_status, via: r.metadata?.figure_via === "human_typed" ? "human_typed" : "web_search",
      capturedAt: typeof r.metadata?.retrieved_at === "string" ? r.metadata.retrieved_at : null,
      confirmedFigureUsd: num(r.metadata?.confirmed_figure_usd) ?? (r.approval_status === "approved" ? num(r.metadata?.figure_usd) : null),
      labelDetail: typeof r.metadata?.label_detail === "string" ? r.metadata.label_detail : null,
    })),
  ]
}

/**
 * DB: a human confirms the figure an APPROVED capture shows. Tenant-predicated
 * read + counted update (CLAUDE.md §3 — an unmatched id is a refusal, never a
 * silent success). The figure is the portal's, recorded for campaign copy —
 * the comparison piece (estimateStillUseVerdict) and, for the Zillow still,
 * the Zestimate Challenge (wave 84B: creative-playbooks.ts
 * zestimateFigureBrief, quoted as Zillow's figure) — never a value the OS
 * states as its own, never read by a value surface or the AI ISA.
 */
export async function confirmComparisonFigure(
  svc: any, args: { brokerageId: string; userId: string | null; assetId: string; figure: unknown; now?: Date },
): Promise<{ ok: true; figureUsd: number } | { ok: false; reason: string }> {
  if (!args.brokerageId) return { ok: false, reason: "REFUSED: confirming a figure needs the session's brokerage id" }
  const fig = validateConfirmedFigure(args.figure)
  if (!fig.ok) return fig
  const { data: row, error } = await svc.from("marketing_assets").select("id, approval_status, metadata")
    .eq("id", args.assetId).eq("brokerage_id", args.brokerageId).maybeSingle()
  if (error) return { ok: false, reason: `comparison capture read refused: ${error.message}` }
  if (!row) return { ok: false, reason: "comparison capture not found for this brokerage" }
  const meta = ((row as any).metadata ?? {}) as Record<string, unknown>
  if (!comparisonEstimateSource(meta.estimate_source as string)) return { ok: false, reason: "that asset is not an estimate comparison capture" }
  if ((row as any).approval_status !== "approved") return { ok: false, reason: "approve the capture first — a figure is confirmed only off an approved still" }
  const { data: upd, error: updErr } = await svc.from("marketing_assets")
    .update({ metadata: { ...meta, confirmed_figure_usd: fig.figureUsd, figure_confirmed_by: args.userId, figure_confirmed_at: (args.now ?? new Date()).toISOString() } })
    .eq("id", args.assetId).eq("brokerage_id", args.brokerageId).select("id")
  if (updErr) return { ok: false, reason: `figure confirmation refused: ${updErr.message}` }
  if (!((upd ?? []) as unknown[]).length) return { ok: false, reason: "figure confirmation matched no row (tenant predicate refused)" }
  return { ok: true, figureUsd: fig.figureUsd }
}

export const ESTIMATE_COMPARISON_ASSET_KIND = "estimate_comparison"

export type ComparisonBuildOutcome =
  | { state: "composed"; assetIds: Partial<Record<ComparisonFormat, string>>; urls: Partial<Record<ComparisonFormat, string>>; copy: ComparisonCopy; videoStillUrls: string[] }
  | { state: "needs_evidence"; reason: string; omitted: Array<{ source: string; reason: string }> }
  | { state: "refused"; reason: string }

/**
 * DB: compose the piece from the tenant's approved + confirmed evidence,
 * rasterize every format (sharp), host each PNG (the ONE media host) and file
 * each as a tenant marketing asset, PENDING — campaign + video material that
 * a human approves on the existing rail before any channel uses it.
 */
export async function buildEstimateComparisonCreative(
  args: { svc: any; brokerageId: string; userId: string | null; address: string; hookKey?: ComparisonHookKey; brand?: ComparisonBrand; qrDataUrl?: string | null },
): Promise<ComparisonBuildOutcome> {
  if (!args.brokerageId) return { state: "refused", reason: "REFUSED: composing needs the session's brokerage id" }
  const evidence = await listComparisonEvidence(args.svc, args.brokerageId, args.address)
  const creative = composeEstimateComparison(evidence, { hookKey: args.hookKey, brand: args.brand, qrDataUrl: args.qrDataUrl })
  if (!creative.ok) return { state: "needs_evidence", reason: creative.reason, omitted: creative.omitted }
  const c = creative
  const sharp = (await import("sharp")).default
  const { hostRenderedMedia } = await import("@/lib/remotion/media-host")
  const { createHash } = await import("node:crypto")
  const key = createHash("sha256").update(JSON.stringify([args.brokerageId, norm(args.address), c.plan.cards.map((x) => [x.source, x.figureUsd]), c.copy.hookKey])).digest("hex").slice(0, 24)
  const assetIds: Partial<Record<ComparisonFormat, string>> = {}
  const urls: Partial<Record<ComparisonFormat, string>> = {}
  for (const fmt of Object.keys(c.svgs) as ComparisonFormat[]) {
    let png: Buffer
    try { png = await sharp(Buffer.from(c.svgs[fmt])).png().toBuffer() }
    catch (e) { return { state: "refused", reason: `comparison render (${fmt}) failed: ${(e as Error).message}` } }
    let url: string
    try { url = await hostRenderedMedia(args.svc, `estimate-comparison/${args.brokerageId}/${key}-${fmt}.png`, png, "image/png") }
    catch (e) { return { state: "refused", reason: (e as Error).message } }
    const { data: row, error } = await args.svc.from("marketing_assets").insert({
      brokerage_id: args.brokerageId, created_by: args.userId, visibility_scope: "brokerage", asset_type: "image",
      asset_name: `Estimate comparison (${fmt}) — ${args.address}`.slice(0, 160), asset_url: url, thumbnail_url: url,
      preview_text: c.copy.headline.slice(0, 280), source_table: "image_library",
      // Marketing-campaign material ONLY (83C): it carries the Zestimate among
      // its cards, and the Zestimate is "marketing campaigns strictly". The
      // comparison play's own video gets it through the install rail, never
      // through a generic video picker.
      tags: ["library", ESTIMATE_COMPARISON_ASSET_KIND, fmt, "use:marketing_campaign"],
      approval_status: "pending",
      metadata: {
        asset_kind: ESTIMATE_COMPARISON_ASSET_KIND, format: fmt, address: args.address, comparison_key: key,
        uses: ["marketing_campaign"], hook_key: c.copy.hookKey, headline: c.copy.headline, cta: c.copy.cta,
        disclaimer: c.copy.disclaimer, spread_usd: c.plan.spreadUsd,
        cards: c.plan.cards.map((x) => ({ source: x.source, label: x.label, figure_usd: x.figureUsd, captured_on: x.capturedOn, evidence_asset_id: x.evidenceAssetId, via: evidence.find((e) => e.assetId === x.evidenceAssetId)?.via ?? "still", source_url: evidence.find((e) => e.assetId === x.evidenceAssetId)?.url ?? null })),
        customer_facing_value: false, usage: "campaign_material_never_an_estimate_of_value",
      },
    }).select("id").single()
    if (error || !row) return { state: "refused", reason: `comparison asset insert refused: ${error?.message ?? "no row"}` }
    assetIds[fmt] = (row as { id: string }).id
    urls[fmt] = url
  }
  return { state: "composed", assetIds, urls, copy: c.copy, videoStillUrls: [...c.videoStillUrls, ...(urls.social_square ? [urls.social_square] : [])] }
}

/** DB: the APPROVED composite for an address + format (never a pending one). */
export async function approvedComparisonCreative(svc: any, brokerageId: string, address: string | null, format: ComparisonFormat): Promise<{ id: string; url: string } | null> {
  if (!brokerageId) return null
  const { data, error } = await svc.from("marketing_assets").select("id, asset_url, metadata")
    .eq("brokerage_id", brokerageId).eq("approval_status", "approved")
    .eq("metadata->>asset_kind", ESTIMATE_COMPARISON_ASSET_KIND).eq("metadata->>format", format)
    .order("updated_at", { ascending: false }).limit(20)
  if (error) { console.error("[estimate-comparison] composite read refused:", error.message); return null }
  const want = norm(address)
  const hit = ((data ?? []) as Array<{ id: string; asset_url: string; metadata: any }>).find((r) => !want || norm(r.metadata?.address) === want)
  return hit ? { id: hit.id, url: hit.asset_url } : null
}

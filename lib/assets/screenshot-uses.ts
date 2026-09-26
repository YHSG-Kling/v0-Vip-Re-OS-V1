// lib/assets/screenshot-uses.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE SCREENSHOT USE RULE (wave 84, lane 84B — owner verbatim, 2026-09-26:
// "screenshots can be used for all marketing/assets/videos/guides/education,
// etc. only the zillow zestimate screenshot can be used for marketing campaigns
// including video.").
//
// WHERE IT LIVES. The seam (lib/assets/screenshot-capture.ts) RE-EXPORTS every
// name below unchanged — server code imports the rule from the seam, as it
// always has. The definitions sit in this file because the rule has CLIENT
// readers too (app/settings/campaign-bundles/estimate-stills-card.tsx,
// app/dashboard/superadmin/demo-room/demo-stills-card.tsx, and the pure
// vocabulary lib/marketing/estimate-sources.ts that the tenant UI imports),
// and the seam cannot be bundled for the browser (node:crypto, the service
// client). PURE — no imports — so there is exactly ONE definition and no
// client-side mirror (demo-stills-card used to carry a hand copy of
// SCREENSHOT_USES; it now imports this list).
//
// THE RULE, by SUBJECT (what the still shows), never by who captured it:
//   · general — an OS surface, product UI, a listing or tenant page: EVERY use
//     (marketing campaigns and their videos, product videos, demos, training /
//     guides / education, the shared image library).
//   · zillow_zestimate — the Zillow property page with its Zestimate: marketing
//     campaigns INCLUDING the campaign's video (`marketing_campaign`,
//     `campaign_video`) and nothing else (not a product video, a demo, a
//     training figure or image-library stock).
//   · other_portal_estimate — a Redfin / Realtor.com / Homes.com (or any other
//     portal's) estimate page: NO use. Those figures are web-searched TEXT only
//     (lib/marketing/estimate-web-search.ts), never a screenshot.
// Any use outside SCREENSHOT_USES (a CMA, a valuation, a price opinion…) is
// refused for every subject — a screenshot is material, never a value.
//
// "guides / education" map onto `training`: the academy's learning_modules ARE
// the guides (lib/education/agent-guide.ts answers from them) and the
// onboarding figures land in them (lib/education/onboarding-authoring.ts).
// "assets" is `image_library` (app/actions/marketing/image-library.ts, the
// picker every tenant creative surface reads). One spelling per use (§6).

/** How a still was captured (the seam's two entry kinds). */
export const SCREENSHOT_KINDS = ["os_surface", "public_page"] as const
export type ScreenshotKind = (typeof SCREENSHOT_KINDS)[number]

/** Every use a still may be selected for — the `use:<x>` tag vocabulary on
 *  marketing_assets.tags, mirrored in metadata.uses (no CHECK on either —
 *  read live 2026-09-26, so no migration). */
export const SCREENSHOT_USES = [
  "marketing_campaign", // a marketing campaign's creative (postcard, social, email, landing art)
  "campaign_video",     // THAT campaign's own video (the screenshot body treatment)
  "product_video",      // product / brand / explainer videos (ProductPromoReel Ken Burns slot)
  "demo",               // product demos ([[STILL:url]])
  "training",           // academy / onboarding / guides / education modules (figures)
  "image_library",      // the shared asset library every creative picker reads
] as const
export type ScreenshotUse = (typeof SCREENSHOT_USES)[number]

/** WHAT the still shows — the rule's key. */
export const SCREENSHOT_SUBJECTS = ["general", "zillow_zestimate", "other_portal_estimate"] as const
export type ScreenshotSubject = (typeof SCREENSHOT_SUBJECTS)[number]

/** THE RULE — the uses each subject may serve. */
const SCREENSHOT_USE_RULE: Readonly<Record<ScreenshotSubject, readonly ScreenshotUse[]>> = {
  general: SCREENSHOT_USES,
  zillow_zestimate: ["marketing_campaign", "campaign_video"],
  other_portal_estimate: [],
}

/** The Zestimate still's uses — marketing campaigns including their video. */
export const ZESTIMATE_SCREENSHOT_USES: readonly ScreenshotUse[] = SCREENSHOT_USE_RULE.zillow_zestimate

/** The one public host whose page is a Zestimate still. */
const ZESTIMATE_HOST = "zillow.com"

/** PURE: normalise a capture kind or a subject to the subject. An os_surface
 *  still is general; a public_page still is the Zillow Zestimate page (the
 *  ONLY public host the seam captures since 81D). Anything else is treated as
 *  another portal's estimate — fail closed. */
function screenshotSubject(kind: ScreenshotSubject | ScreenshotKind | string | null | undefined): ScreenshotSubject {
  if ((SCREENSHOT_SUBJECTS as readonly string[]).includes(String(kind))) return kind as ScreenshotSubject
  if (kind === "os_surface") return "general"
  if (kind === "public_page") return "zillow_zestimate"
  return "other_portal_estimate"
}

function hostIsZillow(url: unknown): boolean {
  if (typeof url !== "string") return false
  try { const h = new URL(url).hostname.toLowerCase(); return h === ZESTIMATE_HOST || h.endsWith(`.${ZESTIMATE_HOST}`) } catch { return false }
}

/** metadata.asset_kind of the estimate-comparison COMPOSITE
 *  (lib/marketing/estimate-comparison.ts ESTIMATE_COMPARISON_ASSET_KIND — the
 *  zestimate-only proof holds the two equal). The composite prints the Zillow
 *  still, so it is judged as the Zestimate. */
const ESTIMATE_COMPOSITE_KIND = "estimate_comparison"

/** PURE: the subject of a stored row. Fail-closed order:
 *   · a retired 82D comparison-only row → other_portal_estimate;
 *   · a recorded estimate source → zillow_zestimate for `zillow_zestimate`,
 *     other_portal_estimate for any other portal;
 *   · the comparison composite (it embeds the Zillow still) → zillow_zestimate;
 *   · a public_page row with no recorded source → by its source_url host
 *     (zillow.com → zillow_zestimate, anything else → other_portal_estimate);
 *   · everything else (an OS surface, product UI…) → general. */
export function screenshotSubjectOfRow(row: { metadata?: Record<string, unknown> | null }): ScreenshotSubject {
  const m = row.metadata ?? {}
  if (m.comparison_only === true) return "other_portal_estimate"
  if (typeof m.estimate_source === "string") return m.estimate_source === "zillow_zestimate" ? "zillow_zestimate" : "other_portal_estimate"
  if (m.asset_kind === ESTIMATE_COMPOSITE_KIND) return "zillow_zestimate"
  if (m.screenshot_kind !== "public_page") return "general"
  return hostIsZillow(m.source_url) ? "zillow_zestimate" : "other_portal_estimate"
}

/** PURE: does this row carry a screenshot the rule governs — a screenshot row,
 *  or any row whose subject is a portal estimate (the comparison composite, a
 *  staged portal figure image)? Pickers that also list non-screenshot images
 *  (the image library) ask this first; a plain image is not the rule's. */
export function isScreenshotRuleRow(row: { metadata?: Record<string, unknown> | null }): boolean {
  return row.metadata?.asset_kind === "screenshot" || screenshotSubjectOfRow(row) !== "general"
}

/** PURE: the uses a subject (or capture kind) may serve, in vocabulary order. */
export function screenshotUsesFor(kind: ScreenshotSubject | ScreenshotKind): ScreenshotUse[] {
  return [...SCREENSHOT_USE_RULE[screenshotSubject(kind)]]
}

/**
 * THE PREDICATE — may a still of this subject (or capture kind) serve `use`?
 * Stable name and signature; lane 84A's video director consumes it for the
 * Zestimate staging (`screenshotUseAllowed("zillow_zestimate", "campaign_video")`).
 */
export function screenshotUseAllowed(kind: ScreenshotSubject | ScreenshotKind, use: string): boolean {
  return (SCREENSHOT_USE_RULE[screenshotSubject(kind)] as readonly string[]).includes(use)
}

type ScreenshotUseVerdict = { ok: true } | { ok: false; reason: string }

/** PURE: the predicate with the reason a refusal names. */
export function screenshotUseVerdict(kind: ScreenshotSubject | ScreenshotKind, use: string): ScreenshotUseVerdict {
  if (screenshotUseAllowed(kind, use)) return { ok: true }
  const subject = screenshotSubject(kind)
  if (!(SCREENSHOT_USES as readonly string[]).includes(use)) return { ok: false, reason: `REFUSED: "${use}" is not a screenshot use (${SCREENSHOT_USES.join(" | ")}) — a screenshot is material, never a value` }
  if (subject === "zillow_zestimate") return { ok: false, reason: `REFUSED: the Zillow Zestimate screenshot serves marketing campaigns including their video only (${ZESTIMATE_SCREENSHOT_USES.join(" | ")}) — "${use}" is not one` }
  if (subject === "other_portal_estimate") return { ok: false, reason: `REFUSED: another portal's estimate page is never used as a screenshot — its figure is web-searched text for the estimate comparison piece only` }
  return { ok: false, reason: `REFUSED: "${use}" is not allowed for a ${subject} screenshot` }
}

export function screenshotUseTag(use: ScreenshotUse): string { return `use:${use}` }

/** PURE: the tags array with exactly this use set (other tags kept). */
export function tagsWithUses(tags: readonly string[] | null | undefined, uses: readonly ScreenshotUse[]): string[] {
  const kept = (tags ?? []).filter((t) => !t.startsWith("use:"))
  const valid = SCREENSHOT_USES.filter((u) => uses.includes(u))
  return [...kept, ...valid.map(screenshotUseTag)]
}

/** metadata.uses_rule stamp — a row whose uses were written under THIS rule. */
export const SCREENSHOT_USES_RULE_VERSION = "84B"

/** The four-use vocabulary rows were tagged with before 84B (78B-83C). */
const PRE_84B_FULL_VOCABULARY = ["marketing_campaign", "product_video", "demo", "training"] as const

/**
 * PURE: the uses a row may be SELECTED for = what it records ∩ THE RULE for
 * its subject. Recorded = the `use:` tags, else metadata.uses, else (a row
 * captured before uses existed) every use.
 *
 * LEGACY LIFT (rows without the 84B stamp): the old vocabulary had no
 * `campaign_video` and no `image_library`. A row tagged `marketing_campaign`
 * served its campaign's video under 80D-83C too (installCreativePlaybook
 * handed the approved still to the campaign's own video), so it also serves
 * `campaign_video`; a row tagged with the WHOLE old vocabulary meant "every
 * use", so it serves every current use. The rule then clamps — a Zestimate
 * row tagged product_video / demo / training by an 80D capture never lists
 * for those, and an other-portal row lists for nothing.
 */
export function usesOfRow(row: { tags?: readonly string[] | null; metadata?: Record<string, unknown> | null }): ScreenshotUse[] {
  const isUse = (u: unknown): u is ScreenshotUse => (SCREENSHOT_USES as readonly string[]).includes(String(u))
  const fromTags = (row.tags ?? []).filter((t) => t.startsWith("use:")).map((t) => t.slice(4)).filter(isUse)
  const meta = row.metadata?.uses
  let recorded: ScreenshotUse[] = fromTags.length
    ? fromTags
    : Array.isArray(meta) ? meta.filter(isUse) : [...SCREENSHOT_USES]
  if (row.metadata?.uses_rule !== SCREENSHOT_USES_RULE_VERSION && (fromTags.length || Array.isArray(meta))) {
    const had = new Set<string>(recorded)
    if (PRE_84B_FULL_VOCABULARY.every((u) => had.has(u))) recorded = [...SCREENSHOT_USES]
    else if (had.has("marketing_campaign") && !had.has("campaign_video")) recorded = [...recorded, "campaign_video"]
  }
  const allowed = SCREENSHOT_USE_RULE[screenshotSubjectOfRow(row)] as readonly string[]
  return SCREENSHOT_USES.filter((u) => recorded.includes(u) && allowed.includes(u))
}

/** PURE: may THIS stored row be selected for `use` — its subject's rule AND
 *  its recorded (human-narrowable) uses. What every picker asks. */
export function screenshotRowUseAllowed(row: { tags?: readonly string[] | null; metadata?: Record<string, unknown> | null }, use: string): boolean {
  return (usesOfRow(row) as readonly string[]).includes(use)
}

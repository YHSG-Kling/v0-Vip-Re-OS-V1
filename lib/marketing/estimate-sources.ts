// lib/marketing/estimate-sources.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ZESTIMATE — THE ONE PROPERTY-PAGE STILL a tenant's marketing may capture
// (wave 81, lane 81D, owner verbatim: "the zestimate screenshot is the only
// property page screenshot so get rid of the other site mentions because the
// zestimate marketing strategy only uses zillow zestimate property page
// screenshots with the picture of the property on zillow with the zestimate
// showing and will be used in some marketing campaigns. there can be many uses
// for the screenshots.").
//
// PURE — no imports — so the tenant UI (a client component) and the server
// door (lib/marketing/tenant-screenshot-door.ts) read ONE list (CLAUDE.md §6).
// The `host` MUST be on lib/assets/screenshot-capture.ts::PUBLIC_PAGE_HOSTS
// (the seam's ToS allowlist) and the seam's PUBLIC_PAGE_READY_RULES for that
// host must cover every `mustShow` label here; scripts/zestimate-only-guard.ts
// and scripts/tenant-screenshot-door-guard.ts assert both.
//
// TOMBSTONE (§1.3, 2026-09-24 — owner ruling above): `realtor_estimate`,
// `redfin_estimate` and `homes_estimate` were three sibling sources this file
// carried from wave 80D (realtor.com / redfin.com / homes.com, each with its own
// ToS note). They are RETIRED, not moved: the Zestimate strategy uses Zillow
// property-page stills only, so no other portal is a valid source and nothing
// captures from those hosts any more. The seam's allowlist shrank with them
// (screenshot-capture.ts PUBLIC_PAGE_HOSTS). A stored row whose
// metadata.estimate_source still names a retired key is simply never picked
// (pickApprovedStill matches the source key) — it is history, not a defect.
// WAVE 82D: the three return for ONE use — the estimate COMPARISON piece
// (COMPARISON_ESTIMATE_SOURCES at the foot of this file, owner-ruled); they
// never re-enter ESTIMATE_SOURCES, the campaign-still vocabulary. WAVE 83C:
// and they are never screenshotted again — their figures come from an AI web
// search (evidenceVia "web_search", lib/marketing/estimate-web-search.ts).
//
// ToS NOTES (Exa, 2026-09-23 + 2026-09-24). The still is MARKETING MATERIAL
// captured for the tenant's own campaign, pending a human's approval, with
// source + capture time recorded — the "ZMA / Zestimate-was-wrong" postcard the
// industry runs (Inman 2024-12-08 "16 direct-mail examples"; Listing Leads ZMA:
// "print out a screenshot of their Zestimate"; Harris Real Estate Daily
// 2025-07-23). Zillow's own page carries the disclaimer that the Zestimate "is
// not an appraisal" and the 2026 Zestimate-accuracy litigation turned on how
// prominently the figure was displayed versus that disclaimer — so the still is
// shown WHOLE (photo + figure + Zillow's own framing), never cropped to the
// number, never re-typeset as the agent's own. Zillow's developer terms forbid
// presenting Zillow data as if it came from a third party, using it for mailing
// lists, or separating the address from the Zestimate; the word marks are
// registered (nominative use only — never the logo, trade dress or an implied
// endorsement). TALCB ("choose your words carefully") + NAR SoP 11-1 + USPAP
// AO-18: a licensee never presents a number as an opinion of VALUE — the still
// is the portal's own number, shown as what it is, and the agent's number is
// spoken at the appointment, never by the OS.

export const ESTIMATE_SOURCE_KEYS = ["zillow_zestimate"] as const
export type EstimateSourceKey = (typeof ESTIMATE_SOURCE_KEYS)[number]

/** What a valid still MUST show — the labels the seam's readiness rule for the
 *  host proves before a pixel is kept (lib/assets/screenshot-capture.ts
 *  PUBLIC_PAGE_READY_RULES). Owner: "the picture of the property on zillow with
 *  the zestimate showing". */
export const ZESTIMATE_STILL_MUST_SHOW = ["property_photo", "zestimate"] as const
export type EstimateStillMustShow = (typeof ZESTIMATE_STILL_MUST_SHOW)[number]

export interface EstimateSource {
  key: EstimateSourceKey
  /** Picker label. */
  label: string
  /** The portal's own name for its number (nominative reference only). */
  estimateName: string
  /** The ONE host the page search is restricted to for this source. */
  host: string
  /** Extra search words that find the estimate page for an address. */
  searchHint: string
  /** What the capture must show before the still is kept (seam-enforced). */
  mustShow: readonly EstimateStillMustShow[]
  /** What the tenant agrees to before capturing — shown in the picker. */
  tosNote: string
}

export const ESTIMATE_SOURCES: readonly EstimateSource[] = [
  {
    key: "zillow_zestimate", label: "Zillow — Zestimate", estimateName: "Zestimate", host: "zillow.com", searchHint: "zestimate",
    mustShow: ZESTIMATE_STILL_MUST_SHOW,
    tosNote: "Zestimate® and Zillow® are registered marks of Zillow Group — name them descriptively only (no logo, no implied endorsement). Zillow's terms bar re-presenting its data as your own, building mailing lists from it, or separating the address from the number: the still is the Zillow property page shown whole — the property photo and the Zestimate together, as the portal's own figure — with the source and capture date recorded. A human approves it before any campaign uses it.",
  },
] as const

export function estimateSource(key: string | null | undefined): EstimateSource | null {
  return ESTIMATE_SOURCES.find((s) => s.key === key) ?? null
}

/** The default (and only) source a Zestimate Challenge install captures from —
 *  the playbook "rides on Zillow" by its own ridesOn line
 *  (lib/marketing/creative-playbooks.ts). */
export const DEFAULT_ESTIMATE_SOURCE: EstimateSourceKey = "zillow_zestimate"

/** The compliance line every consumer of a still carries beside it — the
 *  number on the page is the portal's, never the agent's opinion of value and
 *  never an appraisal (TALCB; NAR SoP 11-1; USPAP AO-18). */
export const ESTIMATE_STILL_DISCLAIMER =
  "Online estimate shown as published by its source on the capture date. It is an automated figure, not an appraisal and not this brokerage's opinion of value."

// ═════════════════════════════════════════════════════════════════════════════
// (b) THE ZESTIMATE STILL IS MARKETING-CAMPAIGN MATERIAL, STRICTLY
// (wave 82, lane 82D, owner verbatim: "the zillow zestimate screenshot should
// only be used for campaigns and not other estimate of value."; NARROWED wave
// 83, lane 83C, owner verbatim: "zestimate is marketing campaigns strictly.").
//
// A still is the PORTAL's figure shown whole, as marketing material. It is
// never a CMA input, a valuation, a home-value report, a price opinion, a
// listing price, an appraisal or any value a customer is told is "the" value —
// and (83C) never demo, training, product-video or image-library stock either:
// the ONLY seam use it carries is `marketing_campaign`, plus the estimate
// comparison piece, which is itself a marketing campaign (the
// `estimate_comparison` play in lib/marketing/creative-playbooks.ts). A
// campaign's OWN video still shows it — installCreativePlaybook hands the
// APPROVED still straight to that campaign's video (app/actions/
// creative-playbooks.ts createPlaybookVideo screenshotUrls) — but no other
// video picks it up. estimateStillUseVerdict is the ONE rule: the seam
// (lib/assets/screenshot-capture.ts usesOfRow / setScreenshotUses), the image
// library (app/actions/marketing/image-library.ts) and the tenant door read it;
// scripts/zestimate-only-guard.ts proves it with positive controls and
// scripts/estimate-comparison-guard.ts proves no value surface reads a still.
// ═════════════════════════════════════════════════════════════════════════════

/** Uses that would present a still as an ESTIMATE OF VALUE — always refused. */
export const ESTIMATE_OF_VALUE_USES = [
  "cma", "valuation", "home_value_report", "price_opinion", "listing_price", "appraisal", "customer_facing_value", "net_sheet",
] as const

/** The ONE use the multi-site comparison piece carries (wave 82D (a)). */
export const ESTIMATE_COMPARISON_USE = "estimate_comparison" as const

/** The generic creative pickers (the approved image library every tenant
 *  creative surface reads — video create, the growth studio). NOT a campaign
 *  by itself, so since 83C no estimate still is admitted to it. */
export const IMAGE_LIBRARY_USE = "image_library" as const

/** The ONLY seam use (lib/assets/screenshot-capture.ts SCREENSHOT_USES) a
 *  Zestimate still may carry — wave 83C: "zestimate is marketing campaigns
 *  strictly". demo / training / product_video are refused. */
export const ZESTIMATE_STILL_USES = ["marketing_campaign"] as const

export type EstimateStillUseVerdict = { ok: true } | { ok: false; reason: string }

/**
 * PURE, FAIL-CLOSED: may evidence from `sourceKey` be used for `use`?
 *   · any ESTIMATE_OF_VALUE_USES → refused (a portal figure is never a value);
 *   · zillow_zestimate → `marketing_campaign` and the comparison piece ONLY
 *     (83C — demo, training, product_video and the image library refused);
 *   · a COMPARISON-ONLY source (realtor / redfin / homes) → the comparison
 *     piece ONLY (since 83C its figure arrives by AI web search, never a
 *     still — lib/marketing/estimate-web-search.ts);
 *   · an unknown source or use → refused.
 */
export function estimateStillUseVerdict(sourceKey: string | null | undefined, use: string): EstimateStillUseVerdict {
  if ((ESTIMATE_OF_VALUE_USES as readonly string[]).includes(use)) {
    return { ok: false, reason: `REFUSED: an online-estimate still is campaign material, never an estimate of value — "${use}" would present the portal's figure as a value` }
  }
  if (sourceKey === DEFAULT_ESTIMATE_SOURCE) {
    if (use === ESTIMATE_COMPARISON_USE || (ZESTIMATE_STILL_USES as readonly string[]).includes(use)) return { ok: true }
    return { ok: false, reason: `REFUSED: a Zestimate still is for marketing campaigns strictly — "${use}" is not one (${[...ZESTIMATE_STILL_USES, ESTIMATE_COMPARISON_USE].join(" | ")})` }
  }
  if (comparisonEstimateSource(sourceKey)) {
    return use === ESTIMATE_COMPARISON_USE
      ? { ok: true }
      : { ok: false, reason: `REFUSED: a ${String(sourceKey)} figure exists only for the estimate comparison piece — "${use}" is not ${ESTIMATE_COMPARISON_USE}` }
  }
  return { ok: false, reason: `REFUSED: "${String(sourceKey)}" is not an estimate source this OS captures` }
}

// ── COMPARISON SOURCES (wave 82D (a)) ────────────────────────────────────────
// Owner verbatim: "taking the estimates on every real estate page that we
// retired as screenshots, merging to show each value on those pages listing
// the property page (on realtorcom, on homes.com....) for a marketing piece
// like..finding out what your home is worth in todays market can make you feel
// overwhelmed when comparing all of these sites...we can help".
//
// RESTORED from the wave-80D form (git show f198fdd1:lib/marketing/
// estimate-sources.ts) for ONE use only — ESTIMATE_COMPARISON_USE. The 81D
// tombstone above still holds for everything else: ESTIMATE_SOURCES (the
// campaign-still vocabulary) remains Zillow alone. The Zestimate joins the
// comparison as one of the four cards.
//
// ToS POSTURE (Exa, 2026-09-25 — the portals' own terms):
//   · realtor.com Terms of Use: no copying/displaying/reproducing any Content
//     "except with the express written permission of Move"; scraping named.
//   · Redfin Terms of Use §2.3.3: no reproducing/redistributing/derivative
//     works "or attempt to commercially gain" from the Services.
//   · Homes.com (CoStar): CoStar retains all rights in its imagery; its marks
//     only with written consent.
// So the published creative carries each portal's FIGURE as TEXT under a
// plain, logo-free, nominative label ("Redfin Estimate"), never their pixels,
// logo or trade dress. Only the Zillow still (posture
// `still_with_attribution`, the 81D ruling) may appear as a picture.
//
// WAVE 83C (owner verbatim: "since we can't use the screenshots for the real
// estate sites showing the homes value except for zillow for marketing
// campaigns, we should use ai to search the internet for the property and what
// realtor.com, homes.com and redfin [show]."): the three portals are no longer
// SCREENSHOTTED at all, not even as evidence. `evidenceVia: "web_search"` —
// lib/marketing/estimate-web-search.ts runs an AI web search (Exa through
// lib/providers/dispatch.ts dispatchWebSearch, spend booked, tenant from the
// session) for the property on that portal's host, a routed model extracts
// the figure with its source URL and date (facts only, verified verbatim
// against the page text), and the figure lands PENDING for a human's approval.
// When the search finds nothing, a human types the figure the portal shows
// (the fallback). Zillow alone keeps `evidenceVia: "still"`.
// ── BEGIN COMPARISON-ONLY BLOCK ──────────────────────────────────────────────

export const COMPARISON_ESTIMATE_SOURCE_KEYS = ["zillow_zestimate", "realtor_estimate", "redfin_estimate", "homes_estimate"] as const
export type ComparisonEstimateSourceKey = (typeof COMPARISON_ESTIMATE_SOURCE_KEYS)[number]

/** What the piece may carry from a source: its still as a picture (Zillow),
 *  or its figure as text under a logo-free label (the three others). */
export type ComparisonStillPosture = "still_with_attribution" | "figure_only"

/** How the figure reaches the piece: the Zillow still (a human reads it off
 *  the approved capture), or an AI web search (83C) staged for approval. */
export type ComparisonEvidenceVia = "still" | "web_search"

export interface ComparisonEstimateSource {
  key: ComparisonEstimateSourceKey
  /** Logo-free, nominative card label (the portal's own name for its number). */
  cardLabel: string
  host: string
  /** Extra search words that find the portal's page for an address. */
  searchHint: string
  /** The portal's own names for its figure (what the extraction looks for). */
  estimateNames: readonly string[]
  /** Still sources: the labels the seam's readiness rule confirms on screen. */
  mustShow: readonly string[]
  posture: ComparisonStillPosture
  evidenceVia: ComparisonEvidenceVia
  tosNote: string
}

export const COMPARISON_ESTIMATE_SOURCES: readonly ComparisonEstimateSource[] = [
  {
    key: "zillow_zestimate", cardLabel: "Zillow Zestimate", host: "zillow.com", searchHint: "zestimate", estimateNames: ["Zestimate"], mustShow: ZESTIMATE_STILL_MUST_SHOW, posture: "still_with_attribution", evidenceVia: "still",
    tosNote: "Zestimate® and Zillow® are registered marks of Zillow Group — named descriptively only. The still is the Zillow page shown whole (photo + Zestimate), source and capture date recorded, approved by a human before use.",
  },
  {
    key: "realtor_estimate", cardLabel: "Realtor.com estimate", host: "realtor.com", searchHint: "RealEstimate home value", estimateNames: ["RealEstimate", "estimated value", "Estimate"], mustShow: [], posture: "figure_only", evidenceVia: "web_search",
    tosNote: "realtor.com® is a mark of Move, Inc. Its terms bar reproducing its content without written permission, so nothing is screenshotted: an AI web search finds the figure the page publishes, records the source link and date, and you approve it; the piece prints it as text under a plain label — no screenshot, no logo.",
  },
  {
    key: "redfin_estimate", cardLabel: "Redfin Estimate", host: "redfin.com", searchHint: "Redfin Estimate", estimateNames: ["Redfin Estimate", "estimate"], mustShow: [], posture: "figure_only", evidenceVia: "web_search",
    tosNote: "Redfin® and Redfin Estimate™ are marks of Redfin Corporation. Its terms bar reproducing or redistributing its pages, so nothing is screenshotted: an AI web search finds the figure the page publishes, records the source link and date, and you approve it; the piece prints it as text under a plain label — no screenshot, no logo.",
  },
  {
    key: "homes_estimate", cardLabel: "Homes.com estimate", host: "homes.com", searchHint: "home value estimate", estimateNames: ["Homes.com Estimate", "estimated value", "estimate"], mustShow: [], posture: "figure_only", evidenceVia: "web_search",
    tosNote: "Homes.com® is a mark of CoStar Group, which reserves all rights in its imagery. Nothing is screenshotted: an AI web search finds the figure the page publishes, records the source link and date, and you approve it; the piece prints it as text under a plain label — no screenshot, no logo.",
  },
] as const

// ── END COMPARISON-ONLY BLOCK ────────────────────────────────────────────────

export function comparisonEstimateSource(key: string | null | undefined): ComparisonEstimateSource | null {
  return COMPARISON_ESTIMATE_SOURCES.find((s) => s.key === key) ?? null
}

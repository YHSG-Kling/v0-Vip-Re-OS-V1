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

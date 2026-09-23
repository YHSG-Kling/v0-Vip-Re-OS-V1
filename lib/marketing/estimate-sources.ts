// lib/marketing/estimate-sources.ts
// ─────────────────────────────────────────────────────────────────────────────
// "ZESTIMATE & CO." — THE CLOSED VOCABULARY OF ONLINE-ESTIMATE SOURCES a tenant
// may pick a marketing still from (wave 80, lane 80D, owner verbatim: "tenant
// can pick zestimate & co. … screenshots can be used by tenants").
//
// PURE — no imports — so the tenant UI (a client component) and the server
// door (lib/marketing/tenant-screenshot-door.ts) read ONE list (CLAUDE.md §6).
// Every `host` here MUST be on lib/assets/screenshot-capture.ts::PUBLIC_PAGE_HOSTS
// (the seam's ToS allowlist); scripts/tenant-screenshot-door-guard.ts asserts
// the subset so a source can never name a host the seam refuses.
//
// ToS NOTES (Exa, 2026-09-23). The stills are MARKETING MATERIAL captured for
// the tenant's own campaign, pending a human's approval, with source + capture
// time recorded — the "ZMA / Zestimate-was-wrong" postcard the industry runs
// (Inman 2024-12-08 "16 direct-mail examples"; Listing Leads ZMA: "print out a
// screenshot of their Zestimate"; Harris Real Estate Daily 2025-07-23). The
// portals' terms still govern: Zillow's developer terms forbid presenting
// Zillow data as if it came from a third party, using it for mailing lists,
// or separating the address from the Zestimate; the word marks are registered
// (nominative use only — never the logo, trade dress or an implied
// endorsement; zillapi.com/legal/trademark-and-affiliation lays the test out).
// TALCB ("choose your words carefully") + NAR SoP 11-1: a licensee never
// presents a number as an opinion of VALUE — the still is the portal's own
// number, shown as what it is, and the agent's number is spoken at the
// appointment, never by the OS.

export const ESTIMATE_SOURCE_KEYS = ["zillow_zestimate", "realtor_estimate", "redfin_estimate", "homes_estimate"] as const
export type EstimateSourceKey = (typeof ESTIMATE_SOURCE_KEYS)[number]

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
  /** What the tenant agrees to before capturing — shown in the picker. */
  tosNote: string
}

export const ESTIMATE_SOURCES: readonly EstimateSource[] = [
  {
    key: "zillow_zestimate", label: "Zillow — Zestimate", estimateName: "Zestimate", host: "zillow.com", searchHint: "zestimate",
    tosNote: "Zestimate® and Zillow® are registered marks of Zillow Group — name them descriptively only (no logo, no implied endorsement). Zillow's terms bar re-presenting its data as your own, building mailing lists from it, or separating the address from the number: the still is shown whole, as the portal's own figure, with the source and capture date recorded. A human approves it before any campaign uses it.",
  },
  {
    key: "realtor_estimate", label: "Realtor.com — Home value estimate", estimateName: "Realtor.com estimate", host: "realtor.com", searchHint: "home value estimate",
    tosNote: "Realtor.com® is a registered mark of Move, Inc. / News Corp — descriptive reference only. Its estimate is an automated model shown as the portal's own figure with source and capture date recorded; never re-branded, never scraped into a list. A human approves the still before use.",
  },
  {
    key: "redfin_estimate", label: "Redfin — Redfin Estimate", estimateName: "Redfin Estimate", host: "redfin.com", searchHint: "redfin estimate",
    tosNote: "Redfin Estimate™ and Redfin® are marks of Redfin Corporation — descriptive reference only. The still shows the portal's own figure with source and capture date recorded; nothing is extracted from the page. A human approves the still before use.",
  },
  {
    key: "homes_estimate", label: "Homes.com — Home value", estimateName: "Homes.com estimate", host: "homes.com", searchHint: "home value",
    tosNote: "Homes.com® is a mark of CoStar Group — descriptive reference only. The still shows the portal's own figure with source and capture date recorded; nothing is extracted from the page. A human approves the still before use.",
  },
] as const

export function estimateSource(key: string | null | undefined): EstimateSource | null {
  return ESTIMATE_SOURCES.find((s) => s.key === key) ?? null
}

/** The default source a Zestimate Challenge install captures from when the
 *  tenant has not picked one — the playbook "rides on Zillow" by its own
 *  ridesOn line (lib/marketing/creative-playbooks.ts). */
export const DEFAULT_ESTIMATE_SOURCE: EstimateSourceKey = "zillow_zestimate"

/** The compliance line every consumer of a still carries beside it — the
 *  number on the page is the portal's, never the agent's opinion of value and
 *  never an appraisal (TALCB; NAR SoP 11-1; USPAP AO-18). */
export const ESTIMATE_STILL_DISCLAIMER =
  "Online estimate shown as published by its source on the capture date. It is an automated figure, not an appraisal and not this brokerage's opinion of value."

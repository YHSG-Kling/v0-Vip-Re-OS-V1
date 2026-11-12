/**
 * lib/listings/listing-description-styles.ts — THE ONE listing-description STYLE
 * vocabulary (wave 87, lane 87B). Client-safe (no server-only): the agent's style
 * picker renders it, the session action validates against it, and the server-only
 * writer (lib/listings/listing-description-core.ts) prompts from it.
 *
 * Owner, verbatim (2026-09-28): "listing description can be an ai tool for agents
 * and can assist with a new listing marketing." The AGENT picks the style — no
 * value-derived rule (lane 86F's "$1M ⇒ luxury" floor is retired on the owner's
 * ruling; the unattended paths write the neutral DEFAULT and the agent restyles).
 *
 * §6 — TWO SPELLINGS MERGED. The agent-facing door took
 * "standard | luxury | family | investment" and the core took
 * "luxury | family | investor | first_time_buyer". One vocabulary now:
 *   · "investment" → "investor" (the core's spelling);
 *   · "family" is RETIRED, not renamed. A writing style aimed at families is a
 *     familial-status framing — a protected class under the Fair Housing Act — and
 *     the compliance block the writer carries forbids leaning on it. A stored or
 *     posted "family" normalizes to the neutral default, never to another audience.
 * Every style is a VOICE for describing the PROPERTY, never a description of who
 * should live there.
 */

export const LISTING_DESCRIPTION_STYLES = ["standard", "luxury", "investor", "first_time_buyer"] as const
export type ListingDescriptionStyle = (typeof LISTING_DESCRIPTION_STYLES)[number]

/** The neutral house style — what an unattended writer uses when no agent picked one. */
export const DEFAULT_LISTING_DESCRIPTION_STYLE: ListingDescriptionStyle = "standard"

export const LISTING_DESCRIPTION_STYLE_LABELS: Record<ListingDescriptionStyle, string> = {
  standard: "Standard",
  luxury: "Luxury",
  investor: "Investment",
  first_time_buyer: "Starter home",
}

/** The writing instruction each style puts in front of the model — property-first, always. */
export const LISTING_DESCRIPTION_STYLE_GUIDE: Record<ListingDescriptionStyle, string> = {
  standard: "Clear, professional real estate copy: lead with the home's strongest verified features.",
  luxury: "Elevated, refined language about finishes, craftsmanship, setting and design — the property, not the buyer.",
  investor: "Numbers-forward: condition, layout flexibility, location facts and upkeep; no income or return promises.",
  first_time_buyer: "Approachable, plain-spoken copy about move-in readiness, low-maintenance features and practical layout.",
}

/** Retired / legacy spellings → the one vocabulary. */
const LEGACY_STYLE_MAP: Record<string, ListingDescriptionStyle> = {
  investment: "investor",
  family: DEFAULT_LISTING_DESCRIPTION_STYLE,
}

export function isListingDescriptionStyle(v: unknown): v is ListingDescriptionStyle {
  return typeof v === "string" && (LISTING_DESCRIPTION_STYLES as readonly string[]).includes(v)
}

/** Any posted/stored value → a member of the vocabulary (unknown → the neutral default). */
export function normalizeListingDescriptionStyle(v: unknown): ListingDescriptionStyle {
  if (isListingDescriptionStyle(v)) return v
  if (typeof v === "string" && LEGACY_STYLE_MAP[v.trim().toLowerCase()]) return LEGACY_STYLE_MAP[v.trim().toLowerCase()]
  return DEFAULT_LISTING_DESCRIPTION_STYLE
}

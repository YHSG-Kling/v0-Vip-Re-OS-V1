// lib/video/commission-situation.ts
//
// PURE situation-builder for the `commission_video` sequence step — maps a step into the
// VideoSituation the Video Director (commissionVideo) expects. Kept separate from the adapter (and
// the server-only Director) so the kind/defaulting logic is unit-tested under plain tsx.
//
// The step opts into a situation kind via step.video_situation_kind; anything unrecognized falls
// back to "explainer" (a general, low-data-dependency value video that suits re-engagement).

export type SituationKind =
  | "new_listing" | "price_drop" | "just_sold" | "open_house" | "coming_soon"
  | "market_update" | "cma" | "explainer" | "presentation" | "anniversary"
  | "testimonial" | "neighborhood"

const VALID_KINDS = new Set<SituationKind>([
  "new_listing", "price_drop", "just_sold", "open_house", "coming_soon",
  "market_update", "cma", "explainer", "presentation", "anniversary",
  "testimonial", "neighborhood",
])

export const DEFAULT_SITUATION_KIND: SituationKind = "explainer"

export interface CommissionSituation {
  kind: SituationKind
  tier: "solo_agent" | "team" | "brokerage" | "multi_location" | "platform"
  targetChannel: "tiktok" | "instagram" | "youtube" | "facebook" | "email" | "portal"
  facts: Record<string, unknown>
}

/** Build the VideoSituation for a commission_video step. Pure. */
export function commissionSituationForStep(
  step: { video_situation_kind?: string | null },
  ctx?: { contactId?: string | null; listingId?: string | null; tier?: CommissionSituation["tier"] },
): CommissionSituation {
  const raw = (step.video_situation_kind ?? "").trim() as SituationKind
  const kind = VALID_KINDS.has(raw) ? raw : DEFAULT_SITUATION_KIND
  const facts: Record<string, unknown> = {}
  if (ctx?.contactId) facts.contact_id = ctx.contactId
  if (ctx?.listingId) facts.listing_id = ctx.listingId
  return {
    kind,
    tier: ctx?.tier ?? "solo_agent",
    targetChannel: "email", // commission_video steps feed a later video-email send
    facts,
  }
}

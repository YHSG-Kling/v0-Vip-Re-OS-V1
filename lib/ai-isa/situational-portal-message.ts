// lib/ai-isa/situational-portal-message.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE PORTAL as a them-first NLP channel — a logged-in contact/lifetime customer is met
// IN-APP with a personal, situational note (the highest-attention, zero-cost touch), not just
// static cards. Pure copy core; engageContact posts the output to client_portal_messages on
// re-engagement (compliance-gated, deduped), so the portal joins email/voice/video/content as
// a first-class outreach channel.
//
// Four personas (buyer / seller / both / lifetime), them-first, Fair-Housing safe by
// construction (stage + intent only — never a protected class or age).

export type PortalPersona = "buyer" | "seller" | "both" | "lifetime"

export interface SituationalPortalInput {
  firstName: string
  persona: PortalPersona
  /** Coarse stage hint (buyer_stage / motivation) — phrasing only. */
  stage?: string | null
}

/** buildSituationalPortalMessage — PURE. A them-first in-app note for the contact's situation. */
export function buildSituationalPortalMessage(i: SituationalPortalInput): string {
  const first = i.firstName?.trim() || "there"
  switch (i.persona) {
    case "seller":
      return `Hi ${first} — your neighborhood's been active lately, so I refreshed what your home could sell for today and dropped the number in your dashboard. No pressure at all; whenever you'd like to talk timing or strategy, just reply right here and I'll take it from there.`
    case "both":
      return `Hi ${first} — I've lined up both sides of your move: a few homes that fit what you're after, plus an updated read on your current place so the timing works out. Take a look whenever you have a sec, and reply here with any questions — we'll map it out together, your pace.`
    case "lifetime":
      return `Hi ${first} — just keeping you in the loop: homes in your area have kept moving, so your equity has likely grown, and I left a fresh snapshot in your dashboard. Nothing you need to do — I'm always here for a question, a referral, or whenever the next move comes up.`
    case "buyer":
    default:
      return `Hi ${first} — a quick note on your search: a few homes that line up with what you're after have come on, and I've flagged the strongest ones for you here. Whenever you'd like a closer look or a showing, just reply and I'll set it up. No rush at all — this moves at your pace.`
  }
}

// lib/ai-isa/contact-reel-situation.ts
// ─────────────────────────────────────────────────────────────────────────────
// TRULY SITUATIONAL video per CONTACT persona — buyer / seller / both / lifetime each map to
// a DISTINCT Director reel kind, so the ISA's video touch fits where the person actually is
// (not one generic clip). The ISA does NOT commission this itself — it DELEGATES to the Asset
// Manager (the team's video director) over the bus; this is the pure decision the handler reads.
//
//   buyer    → "explainer"      (an avatar-led "here's what's moving for buyers like you" reel)
//   seller   → "cma"            (a "what your home is worth now" value reel)
//   both     → "market_update"  (the whole market — both sides of a must-sell-to-buy move)
//   lifetime → "anniversary"    (the equity/anniversary report for a past client)
//
// PURE — no I/O. The handler resolves the assigned-agent presenter + commissions the reel.

import type { SituationKind, VideoSituation } from "@/lib/video/video-director"

export type ContactReelPersona = "buyer" | "seller" | "both" | "lifetime"

/** Map a contacts.contact_type to the reel persona (default buyer). */
export function contactReelPersona(contactType: string | null | undefined): ContactReelPersona {
  switch ((contactType ?? "").toLowerCase()) {
    case "seller":   return "seller"
    case "both":     return "both"
    case "lifetime": return "lifetime"
    default:         return "buyer"
  }
}

/** The Director SituationKind that fits each contact persona. */
export function situationKindForContact(persona: ContactReelPersona): SituationKind {
  switch (persona) {
    case "seller":   return "cma"
    case "both":     return "market_update"
    case "lifetime": return "anniversary"
    case "buyer":    return "explainer"
  }
}

/** Build the Director situation the Asset Manager commissions for a contact's reel (the
 *  persona-MOMENT fallback — used when no fresh popular topic is available). */
export function buildContactReelSituation(args: {
  contactId: string
  persona: ContactReelPersona
}): VideoSituation {
  return {
    kind: situationKindForContact(args.persona),
    tier: "solo_agent",
    targetChannel: "email", // the reel rides the ISA's re-engagement email (and the portal)
    facts: { contactId: args.contactId, persona: args.persona },
  }
}

/**
 * buildContactWelcomeSituation — the FIRST touch the moment a buyer LEAD becomes a CONTACT: a
 * personal "welcome to the team" avatar reel fronted by the assigned agent (Director kind
 * "lead_intro" → the calm "A Quick Hello" hello). This is the warm handshake that opens the
 * representation relationship — distinct from the persona-situational follow-up reels. Idempotent
 * per (contact, welcome) downstream via the director key.
 */
export function buildContactWelcomeSituation(args: {
  contactId: string
  persona: ContactReelPersona
}): VideoSituation {
  return {
    kind: "lead_intro", // a personal welcome hello — "great to have you, here's how I'll help"
    tier: "solo_agent",
    targetChannel: "email", // rides the gated 1:1 welcome/invite email + the portal
    facts: { contactId: args.contactId, persona: args.persona, moment: "welcome" },
  }
}

/**
 * buildSellerConversionSituation — the un-converted SELLER moment: a homeowner became a CONTACT (they
 * asked "what's my home worth?" / signaled selling) and has a seller-mode portal, but hasn't booked a
 * listing consult yet. The seller mirror of the buyer welcome reel: a personal, value-forward avatar
 * reel from the assigned agent — "here's what your home could really sell for, and what your move could
 * look like — let's map it together." Director kind "lead_intro" (a personal avatar hello fronted by
 * the assigned agent) — CUSTOMER-FACING (kind "cma" is marked in_house/agent-only by the Director, so
 * it would never reach the seller). Number-discipline + compliance handled by the Director gate; the
 * moment seeds the gateway script. Drives to the seller-mode portal + a no-pressure consult.
 *
 * CONTINUOUS nurture (mirrors the buyer): pass a rotating topic so each cadence cycle delivers a FRESH
 * value reel ("what your home could sell for" → "staging that adds the most" → "is now the right time
 * to list?") instead of repeating one welcome reel. The topic varies the director key, so the Director
 * commissions a distinct reel each cycle until the homeowner converts. No topic → the value-forward
 * first touch.
 */
export function buildSellerConversionSituation(args: {
  contactId: string
  topicTitle?: string | null
  valueAngle?: string | null
}): VideoSituation {
  return {
    kind: "lead_intro",
    tier: "solo_agent",
    targetChannel: "email", // rides the gated 1:1 email embedding the reel + the seller-mode portal CTA
    facts: {
      contactId: args.contactId,
      persona: "seller",
      moment: "seller_conversion",
      ...(args.topicTitle ? { topic: args.topicTitle } : {}),
      ...(args.valueAngle ? { value_angle: args.valueAngle } : {}),
    },
  }
}

/**
 * buildOfferConfidenceSituation — the OFFER moment: a buyer reached the offer-strategy stage
 * (they found the one). A personal, motivational avatar reel fronted by the assigned agent that
 * builds the confidence to WRITE — "you found it, you're ready, here's how we make a strong
 * offer together." Kept number-free for compliance (the concrete price plan goes to the AGENT
 * in the gated brief, not the buyer video). Pairs the analytical plan with the human push.
 */
export function buildOfferConfidenceSituation(args: { contactId: string }): VideoSituation {
  return {
    kind: "explainer",
    tier: "solo_agent",
    targetChannel: "email",
    facts: { contactId: args.contactId, persona: "buyer", moment: "offer_confidence" },
  }
}

/**
 * buildSavedHomeNudgeSituation — a PERSONAL avatar note from the assigned agent when a home the
 * buyer saved changes (a price drop, or it's back on the market — the highest-emotion moments). A
 * warm 20-second "hey, that home you loved just got more interesting — let's take a look together"
 * fronted by the agent (Director 'lead_intro'). Number-free for compliance; drives to the portal.
 */
export function buildSavedHomeNudgeSituation(args: { contactId: string; nudgeKind: string }): VideoSituation {
  return {
    kind: "lead_intro",
    tier: "solo_agent",
    targetChannel: "email",
    facts: { contactId: args.contactId, persona: "buyer", moment: "saved_home_nudge", nudge: args.nudgeKind },
  }
}

/**
 * buildOfferCompsSituation — the AGENT-FACING comps reel for a buyer's target at the offer moment.
 * Director kind "cma" (which the Director marks audience_type 'in_house' — agent-only, so the
 * client never gets the black-and-white scope), animating "this home vs recent sales" via the
 * CMAReel CompsBar. The render queue sources the comps for the subject address downstream. The
 * agent watches it to prep their recommendation — the analytical companion to the buyer's
 * motivational offer-confidence reel.
 */
export function buildOfferCompsSituation(args: {
  contactId: string
  subjectAddress: string
  subjectPrice?: number | null
}): VideoSituation {
  return {
    kind: "cma",
    tier: "solo_agent",
    targetChannel: "email",
    facts: {
      contactId: args.contactId,
      subject_address: args.subjectAddress,
      ...(args.subjectPrice ? { subject_price: args.subjectPrice } : {}),
      audience: "agent", // in_house — the agent's offer prep, never shown black-and-white to the client
      moment: "offer_comps",
    },
  }
}

/** content_topic_bank categories that pertain to each persona's SITUATION — the follow-up
 *  reel pulls a POPULAR KEYWORD topic from these (the first touch is the welcome avatar reel;
 *  every follow-up rides a fresh, persona-relevant informational topic). */
export function personaTopicCategories(persona: ContactReelPersona): string[] {
  switch (persona) {
    case "buyer":    return ["buyer_advice", "home_buying", "finance", "first_time_buyer"]
    case "seller":   return ["seller_advice", "home_selling", "pricing", "staging"]
    case "both":     return ["buyer_advice", "seller_advice", "finance", "market_update"]
    case "lifetime": return ["home_improvement", "home_value", "market_update", "homeownership"]
  }
}

/**
 * buildInformationalReelSituation — the FOLLOW-UP reel: an avatar-led EXPLAINER built around a
 * POPULAR KEYWORD topic that pertains to the contact's persona (not a fixed kind). The topic
 * facts seed the Director's gateway-written script; rotating topics make every follow-up fresh.
 */
export function buildInformationalReelSituation(args: {
  contactId: string
  persona: ContactReelPersona
  topicTitle: string
  valueAngle?: string | null
  categories?: string[]
}): VideoSituation {
  return {
    kind: "explainer",
    tier: "solo_agent",
    targetChannel: "email",
    facts: {
      contactId: args.contactId,
      persona: args.persona,
      topic: args.topicTitle,
      ...(args.valueAngle ? { value_angle: args.valueAngle } : {}),
      ...(args.categories && args.categories.length ? { categories: args.categories.join(", ") } : {}),
    },
  }
}

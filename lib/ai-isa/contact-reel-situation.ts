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

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

/** Build the Director situation the Asset Manager commissions for a contact's reel. */
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

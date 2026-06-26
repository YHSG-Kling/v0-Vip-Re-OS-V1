// lib/ai-isa/saved-home-nudge.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE SAVED-HOME WATCH — a buyer's saved/matched homes are LIVING, and when one changes the AI
// team reaches out PERSONALLY (the AI ISA, persona-aware, with the agent's avatar/voice on the
// highest-emotion moments). RealScout sends a generic alert; we send a 20-second note from the
// buyer's own agent. PURE: classify a change into the nudge the ISA personalizes. No I/O.
//
// Honest + them-first: every nudge drives back to OUR portal, never a stark number, always a
// reason to talk to the agent. The owner's no-spam rule holds — these fire on a REAL change to a
// home the buyer ALREADY engaged, not a cold blast.

export type SavedHomeNudgeKind =
  | "price_drop"        // the home they saved got cheaper — the strongest "act now" moment
  | "back_on_market"    // a prior deal fell through — their saved home is available again
  | "under_contract"    // a saved home is getting an offer — move on it or pivot to similar
  | "new_match"         // a fresh listing fits their (now learned) criteria
  | "open_house"        // an open house this weekend at a saved/matched home

export interface SavedHomeNudge {
  kind: SavedHomeNudgeKind
  /** Short, warm headline for the personalized message. */
  headline: string
  /** The angle the gateway should write the body around (them-first, portal-driving). */
  angle: string
  /** high = time-critical (act this week); medium = stay-engaged. */
  urgency: "high" | "medium"
  /** Worth a PERSONAL avatar reel from the agent (the highest-emotion moments). */
  avatarWorthy: boolean
}

/**
 * classifySavedHomeNudge — PURE. Map a saved-home change to the personalized nudge the ISA sends.
 * The strongest emotional moments (a price drop on a home they loved, or it coming back on the
 * market) are avatar-worthy — a personal video from their agent. Status/new-match/open-house keep
 * momentum. Returns null for an unknown kind (never fabricate a reason to reach out).
 */
export function classifySavedHomeNudge(kind: string): SavedHomeNudge | null {
  switch (kind) {
    case "price_drop":
      return {
        kind: "price_drop",
        headline: "A home you loved just got more affordable",
        angle: "warmly tell the buyer a home they saved just dropped in price — a real opening to take another look — and invite them to talk it through with you in their portal. Do NOT quote the exact new price; that's the agent's conversation.",
        urgency: "high",
        avatarWorthy: true,
      }
    case "back_on_market":
      return {
        kind: "back_on_market",
        headline: "Good news — a home you saved is available again",
        angle: "a home the buyer saved came back on the market (a prior deal fell through) — share the good news, note these move fast, and invite them to see it (and everything) in their portal.",
        urgency: "high",
        avatarWorthy: true,
      }
    case "under_contract":
      return {
        kind: "under_contract",
        headline: "A home you saved is getting interest",
        angle: "a home the buyer saved is going under contract — gently let them know, reassure them you've got similar options ready, and invite them to their portal to look together. No pressure.",
        urgency: "high",
        avatarWorthy: false,
      }
    case "new_match":
      return {
        kind: "new_match",
        headline: "A new home just hit that fits you",
        angle: "a fresh listing matches what the buyer is looking for (their learned criteria) — invite them to see it in their portal before others do. Keep it light and exciting.",
        urgency: "medium",
        avatarWorthy: false,
      }
    case "open_house":
      return {
        kind: "open_house",
        headline: "An open house this weekend on a home you're watching",
        angle: "there's an open house this weekend at a home the buyer saved or matched — invite them to go (offer to join/prep them) and to RSVP/details in their portal.",
        urgency: "medium",
        avatarWorthy: false,
      }
    default:
      return null
  }
}

/** The nudge kinds, for callers that enumerate. */
export const SAVED_HOME_NUDGE_KINDS: SavedHomeNudgeKind[] = [
  "price_drop", "back_on_market", "under_contract", "new_match", "open_house",
]

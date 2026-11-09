// lib/ai-isa/saved-home-nudge.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE SAVED-HOME WATCH — a buyer's saved/matched homes are LIVING, and when one changes the AI
// team reaches out PERSONALLY (the AI ISA, persona-aware, with the agent's avatar/voice on the
// highest-emotion moments). RealScout sends a generic alert; we send a 20-second note from the
// buyer's own agent. The classifier is PURE (no I/O); decideSavedHomeNudge (wave 149, C29) hands its pick to the arbiter.
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
  | "coming_soon"       // an exclusive pre-MLS / coming-soon home matches them — first look
  // WAVE 151 (lane 151J, directive 151J "status changes" on a saved home): the home they saved LEFT the market —
  // sold / withdrawn / expired / the source no longer carries it. An honest fact told once, then a pivot to similar
  // homes; never framed as "getting interest" (that is under_contract). Not video-worthy (an ending is not a highlight).
  | "no_longer_available"

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
/**
 * OWNER RULING (2026-09-08): "no video nudges for under contract." A saved home
 * going under contract may earn a gated portal NOTE; it never fronts an avatar
 * reel. Enforced here (the classifier answers avatarWorthy=false for these kinds
 * no matter what the case below says) and asserted by
 * scripts/video-lanes-audit-guard.ts — routeSavedHomeNudge picks the bus from
 * this flag, so this is the one place the ruling has to hold.
 */
export const NO_VIDEO_NUDGE_KINDS: readonly SavedHomeNudgeKind[] = ["under_contract"]

export function classifySavedHomeNudge(kind: string): SavedHomeNudge | null {
  const nudge = classifySavedHomeNudgeUnruled(kind)
  if (nudge && (NO_VIDEO_NUDGE_KINDS as readonly string[]).includes(nudge.kind)) return { ...nudge, avatarWorthy: false }
  return nudge
}

function classifySavedHomeNudgeUnruled(kind: string): SavedHomeNudge | null {
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
    case "coming_soon":
      return {
        kind: "coming_soon",
        headline: "An exclusive first look — a coming-soon home that fits you",
        angle: "a coming-soon / pre-MLS home matches what the buyer is looking for — give them an EXCLUSIVE first look before it hits the open market, and invite them to see it (and reserve a private showing) in their portal. Make them feel like an insider.",
        urgency: "high",
        avatarWorthy: true,
      }
    case "no_longer_available":
      return {
        kind: "no_longer_available",
        headline: "A home you saved is no longer on the market",
        angle: "a home the buyer saved is no longer listed (sold, withdrawn or expired — say only what the source reported, never guess which) — tell them plainly and kindly, reassure them you have similar homes ready, and invite them to their portal to look together. No pressure, no exact figures.",
        urgency: "medium",
        avatarWorthy: false,
      }
    default:
      return null
  }
}

/** What the router does with a saved-home change, once the arbiter decided. */
export type SavedHomeNudgeRoute = "avatar_reel" | "written_note" | "agent" | "hold"

/**
 * WAVE 149 (lane 149C, owner ruling 7 / contract C29 — lane 148Z Still open: saved-home-nudge onto the arbiter). The classifier
 * above is the PLANNER: it knows what changed and which moments are worth a personal video. It no longer decides alone — it
 * proposes, and the ARBITER chooses from this buyer's evidence: a personal avatar reel from their agent (only where the
 * classifier allows one — never for under contract), a short written note to their portal, the agent personally, or a bounded
 * hold (a buyer touched an hour ago does not need a second note now). The classifier's own pick is the fallback, so an outage
 * keeps the old routing. Ledgered as followup.decision.* (planner `saved_home_nudge`). Never throws.
 */
export async function decideSavedHomeNudge(
  svc: { from: (t: string) => any },
  params: { brokerageId: string; contactId: string; nudge: SavedHomeNudge; hasAssignedAgent?: boolean; hoursSinceAnyTouch?: number | null; now?: Date },
  deps: { decide?: import("./followup-arbiter").ArbiterDecide; record?: boolean } = {},
): Promise<{ route: SavedHomeNudgeRoute; rationale: string; source: "ai" | "deterministic"; waitHours: number | null }> {
  const { arbitratePlannedTouch } = await import("./followup-arbiter")
  const n = params.nudge
  const options = [
    ...(n.avatarWorthy ? [{ id: "avatar_reel", kind: "video" as const, channels: ["email" as const, "in_app" as const], why: [`${n.headline} — one of the highest-emotion moments; a 20-second personal video from their own agent`] }] : []),
    { id: "written_note", kind: "communication" as const, channels: ["email" as const, "in_app" as const], why: [`${n.headline} — a short, warm note that brings them back to their portal (${n.urgency} urgency)`] },
    { id: "agent", kind: "agent_intervention" as const, channels: ["human_task" as const], why: ["their agent reaches out personally — when the moment needs a conversation, not a message"] },
  ]
  const r = await arbitratePlannedTouch(svc, {
    brokerageId: params.brokerageId, planner: "saved_home_nudge", subject: { type: "contact", id: params.contactId }, now: params.now ?? new Date(),
    options, planned: n.avatarWorthy ? "avatar_reel" : "written_note",
    // A time-critical change (a price drop, back on market) is answered now; a lower-urgency one may wait.
    offerWait: n.urgency !== "high",
    moment: { key: `saved_home_${n.kind}`, intent: `A home this buyer saved changed (${n.kind.replace(/_/g, " ")}). Decide how — and whether now — their team lets them know. ${n.angle}` },
    relationship: { type: "contact", persona: "buyer", hasAssignedAgent: params.hasAssignedAgent ?? false },
    history: { hoursSinceAnyTouch: params.hoursSinceAnyTouch ?? null },
    urgency: n.urgency === "high" ? "high" : "normal",
  }, deps)
  const route: SavedHomeNudgeRoute = r.decision.kind === "wait" ? "hold" : r.decision.kind === "agent_intervention" ? "agent" : r.decision.kind === "video" && n.avatarWorthy ? "avatar_reel" : "written_note"
  return { route, rationale: r.decision.rationale, source: r.decision.source, waitHours: r.decision.waitHours }
}

/** The nudge kinds, enumerated.
 *  @proofSeam no runtime caller enumerates the kinds — classifySavedHomeNudge branches per kind and the reactor calls it per event; this roster exists so scripts/saved-home-nudge-simulator.ts can sweep every kind through the classifier and prove each one yields a nudge (a kind added to the union but not the switch goes red). */
export const SAVED_HOME_NUDGE_KINDS: SavedHomeNudgeKind[] = [
  "price_drop", "back_on_market", "under_contract", "new_match", "open_house", "coming_soon", "no_longer_available",
]

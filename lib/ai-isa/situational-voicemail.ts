// lib/ai-isa/situational-voicemail.ts
// ─────────────────────────────────────────────────────────────────────────────
// SITUATIONAL voicemail scripts — a ringless voice drop should speak to WHERE THE PERSON
// ACTUALLY IS (them-first), never a generic blast. A real-estate voicemail that references
// the person's real situation ("a couple 3-beds in your range just came up — wanted you to
// have first look") converts far better than "just checking in". This is the pure, testable
// copy core; engageContact passes the output to orchestrateVoicedropSend as a scriptOverride.
//
// Spoken-length disciplined (≤ ~25s ≈ ~55 words) and FAIR-HOUSING SAFE BY CONSTRUCTION:
// references the person's STAGE + INTENT only — never race, religion, sex, national origin,
// disability, familial status, or age itself. {agent_name} is interpolated by the sender.

export type VoicemailSide = "buyer" | "seller" | "both" | "past_client"

export interface SituationalVoicemailInput {
  firstName: string
  side: VoicemailSide
  /** A coarse stage/intent hint (buyer_stage / motivation_type / lifecycle). */
  stage?: string | null
  /** True when there is a concrete, fresh hook (new matches / a value move) to lead with. */
  hasFreshHook?: boolean
}

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase()

/**
 * buildSituationalVoicemailScript — PURE. Compose a short, natural, them-first voicemail for
 * the recipient's situation. Deterministic (the same situation → the same script), so it's
 * unit-testable and safe as the fallback when the gateway is unavailable.
 */
export function buildSituationalVoicemailScript(i: SituationalVoicemailInput): string {
  const first = i.firstName?.trim() || "there"
  const stage = norm(i.stage)

  if (i.side === "seller") {
    if (/list|sell|cma|valuation|apprais/.test(stage)) {
      return `Hi ${first}, it's {agent_name}. Values in your neighborhood shifted this quarter, so I pulled a fresh look at what your home could sell for today. No pressure at all — I just wanted you to have the real number. Give me a call back whenever it's convenient and I'll walk you through it.`
    }
    return `Hi ${first}, it's {agent_name}. I was thinking about your place and put together a quick, no-pressure snapshot of where the market's at for a home like yours right now. Reach out anytime — happy to share it whenever you're ready.`
  }

  if (i.side === "both") {
    // A buyer AND seller (must sell to buy) — speak to BOTH journeys + the timing between them.
    return `Hi ${first}, it's {agent_name}. I've been watching both sides of your move — a few homes that fit just came up, and I pulled where your current place stands so we can line the timing up right. No pressure at all; call me back when you get a sec and we'll map it out together.`
  }

  if (i.side === "past_client") {
    return `Hi ${first}, it's {agent_name} — just thinking of you. Homes in your area have moved nicely, so your equity's likely grown; I put together a quick snapshot for you. No need to do anything — just call me back if you'd ever like to take a look. Always here for you.`
  }

  // Buyer
  if (/tour|showing|active|search|configured/.test(stage)) {
    return i.hasFreshHook
      ? `Hi ${first}, it's {agent_name}. A couple homes that fit what you're after just came up, and I wanted you to have first look before they get busy this weekend. Call me back when you get a sec and I'll send them over.`
      : `Hi ${first}, it's {agent_name}. I've been keeping an eye out and have a quick idea to tighten up the search so we find the right one faster. Give me a ring when you have a moment.`
  }
  if (/preapprov|financ|lender/.test(stage)) {
    return `Hi ${first}, it's {agent_name}. Quick one on the financing side — I want to make sure you're set up to move fast when the right home shows up. Call me back when you can and we'll get it squared away.`
  }
  // Buyer, early / unknown stage
  return `Hi ${first}, it's {agent_name}. I wanted to reconnect and see how I can help with your move whenever the timing feels right — no pressure at all. Just give me a call back when you get a chance and I'll take it from there.`
}

// lib/kernel/warm-handoff.ts
//
// THE WARM HANDOFF — when a portal conversation needs a human, the human is pulled in WITH the
// full picture instead of a bare "someone needs you" ping. The client never repeats themselves;
// the agent walks in informed. Kills two anxieties at once: the client's "I have to explain all
// this again" and the agent's "I'm walking in blind."
//
// This COMPOSES existing primitives — the portal chat transcript, the durable context_spine, the
// 11-manager team brief (runTeamQuery), and the ISA qualification brief — into ONE agent-facing
// briefing. The composer is PURE (the proof pins it down); the runner gathers the live parts and
// routes a single `warm_handoff` notification carrying the brief. Agent-facing internal briefing —
// not client outreach — so it is structured, not generated marketing copy.

export interface HandoffParts {
  contactName: string | null
  /** What the client JUST said — the escalation trigger. */
  triggerMessage: string | null
  spineSummary: string | null
  preferences: string[]
  openNextStep: string | null
  sentiment: string | null
  teamLines: { manager: string; line: string }[]
  /** Recent transcript, oldest→newest. */
  transcript: { who: string; text: string }[]
  isaBackground: string | null
}

export interface WarmHandoffBrief {
  headline: string
  clientSays: string | null
  whatTheyWant: string[]
  openCommitment: string | null
  sentiment: string
  /** Deterministic guidance — what to lead with, given why they escalated. */
  suggestedFocus: string
  teamKnows: { manager: string; line: string }[]
  recentTranscript: { who: string; text: string }[]
  isaBackground: string | null
}

const RETENTION = /cancel|back ?out|pulling out|losing the house|deal is falling|walk away/
const LEGAL = /sue|lawsuit|attorney|legal action/
const PANIC = /scared|worried|panicking|anxious|freaking/

/** Pure: derive what the agent should lead with, from why the client escalated. */
export function deriveSuggestedFocus(triggerMessage: string | null, sentiment: string | null, openNextStep: string | null): string {
  const t = (triggerMessage ?? "").toLowerCase()
  if (LEGAL.test(t)) return "Legal-sensitive — acknowledge, avoid admissions, loop in the broker/compliance before responding."
  if (RETENTION.test(t)) return "Retention risk — reassure first, then re-anchor on their goal and the concrete next step."
  if (PANIC.test(t)) return "Emotional moment — lead with empathy and one clear, calming next step."
  if (openNextStep) return `Pick up the open commitment already on record: ${openNextStep}`
  if (sentiment === "negative") return "Cooling — address the specific concern head-on before anything else."
  return "Answer their latest question directly and confirm the next step."
}

/** Pure: assemble the warm-handoff brief from the gathered parts. No fabrication — empty stays empty. */
export function composeHandoffBrief(p: HandoffParts): WarmHandoffBrief {
  const who = p.contactName?.trim() || "This client"
  return {
    headline: `${who} escalated from the portal — here's the full picture so you don't have to ask.`,
    clientSays: p.triggerMessage?.trim() || null,
    whatTheyWant: p.preferences ?? [],
    openCommitment: p.openNextStep ?? null,
    sentiment: p.sentiment ?? "unknown",
    suggestedFocus: deriveSuggestedFocus(p.triggerMessage, p.sentiment, p.openNextStep),
    teamKnows: p.teamLines ?? [],
    recentTranscript: (p.transcript ?? []).slice(-12),
    isaBackground: p.isaBackground?.trim() || null,
  }
}

/** A short, human title for the notification (agent-facing). */
export function handoffTitle(contactName: string | null): string {
  return `${contactName?.trim() || "A client"} needs you — warm handoff ready`
}

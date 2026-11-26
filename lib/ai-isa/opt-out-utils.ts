// Pure, synchronous opt-out detection utilities.
// No "use server" — safe to import from both client components and route handlers.

export type OptOutChannel = "email" | "sms" | "phone" | "direct_mail" | "all"

export interface DetectOptOutResult {
  isOptOut: boolean
  channel: OptOutChannel
  confidence: "high" | "medium"
}

/**
 * THE REVOCATION WORDS — ONE vocabulary (CLAUDE.md §6; wave 148, lane 148B — C16). A reply that IS one of these (trailing
 * punctuation and "please" tolerated) revokes consent on every channel. The list is the carrier keyword set (STOP, STOPALL,
 * UNSUBSCRIBE, CANCEL, END, QUIT) plus the words the FCC's 2024 TCPA revocation order (FCC 24-24, 47 CFR §64.1200 — the rule
 * this repo's law registry cites) names as a per-se reasonable revocation: "revoke" and "opt out". app/api/sms/inbound-optout
 * used to keep its OWN regex (without revoke / opt out) — it now reads this one. So do the two other copies found by the
 * orphan census (each merged ONTO this list first, then retired with a tombstone): the communication spine's inbound STOP
 * (lib/communication-spine/ingest-message-service.ts — brought "remove") and the AI ISA's HARD_STOP (lib/kernel/ai-isa.ts —
 * brought "remove me"). Neither knew "revoke", so an FCC revocation sent through either door was not honoured.
 */
export const REVOCATION_KEYWORDS = ["stop", "stopall", "stop all", "unsubscribe", "cancel", "end", "quit", "optout", "opt out", "opt-out", "revoke", "remove", "remove me"] as const

/** PURE — is this whole message a revocation keyword? (the carrier / FCC single-word reply). */
export function isRevocationKeyword(text: string | null | undefined): boolean {
  const t = String(text ?? "").toLowerCase().replace(/[.!?,;:]+$/g, "").replace(/^please\s+|\s+please$/g, "").replace(/\s+/g, " ").trim()
  return (REVOCATION_KEYWORDS as readonly string[]).includes(t)
}

export function detectOptOutIntent(text: string): DetectOptOutResult {
  const lower = text.toLowerCase().trim()

  // TCPA-standard single-word commands + the FCC revocation words — highest confidence (the ONE list above)
  if (isRevocationKeyword(lower)) {
    return { isOptOut: true, channel: "all", confidence: "high" }
  }

  // High-confidence global phrases
  const globalPhrases = [
    "do not contact me",
    "do not call me",
    "remove me from your list",
    "stop all messages",
    "unsubscribe from all",
    "take me off your list",
    "stop contacting me",
    "please stop",
    "leave me alone",
    "i do not want to be contacted",
    "do not reach out",
  ]
  if (globalPhrases.some((p) => lower.includes(p))) {
    return { isOptOut: true, channel: "all", confidence: "high" }
  }

  // Channel-specific patterns
  if (/stop.*email|no.*email|unsubscribe.*email|email.*stop/i.test(lower)) {
    return { isOptOut: true, channel: "email", confidence: "medium" }
  }
  if (/stop.*text|stop.*sms|no.*text|no.*sms|stop.*message/i.test(lower)) {
    return { isOptOut: true, channel: "sms", confidence: "high" }
  }
  if (/stop.*call|no.*call|do not call|don't call/i.test(lower)) {
    return { isOptOut: true, channel: "phone", confidence: "high" }
  }
  if (/stop.*mail|no.*mail|remove.*mail/i.test(lower)) {
    return { isOptOut: true, channel: "direct_mail", confidence: "medium" }
  }

  return { isOptOut: false, channel: "all", confidence: "high" }
}

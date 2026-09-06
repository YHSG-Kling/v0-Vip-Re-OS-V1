// lib/voice/isa-readiness-copy.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE PURE HALF of ISA calling readiness — the blocker vocabulary and the words
// an agent reads. Split out because lib/voice/isa-readiness.ts is `server-only`
// (it queries the tenant), and both the guard and any client surface need to
// reason about the copy without pulling a server module in. Same split as
// lib/did/contract.ts vs lib/did/consent.ts, for the same reason.
//
// These strings are what a human ACTS ON. The ones they replace told agents to
// go configure VAPI — a vendor the voice lane retired — so the guard holds this
// wording to account deliberately.

/** What is missing, if anything. Ordered as the executor checks them. */
export type IsaBlocker = "no_brokerage" | "no_number" | "no_twilio" | null

export interface IsaCallingReadiness {
  /** True when an AI outbound call could actually be placed today. */
  canPlaceAiCalls: boolean
  blocker: IsaBlocker
  /** What the agent is told. Null when ready. */
  reason: string | null
  ctaLabel: string | null
  ctaHref: string | null
}

/**
 * The blocker in words. PURE, so the guard can hold the wording to account —
 * these strings are what an agent acts on, and the previous ones sent them to
 * configure a vendor that no longer exists.
 */
export function describeIsaBlocker(blocker: IsaBlocker): Omit<IsaCallingReadiness, "canPlaceAiCalls" | "blocker"> {
  switch (blocker) {
    case "no_brokerage":
      return {
        reason: "This account isn't linked to a brokerage yet, so there's no line to call from.",
        ctaLabel: null, ctaHref: null,
      }
    case "no_number":
      return {
        reason:
          "AI calling needs a phone number of your own to dial from — calls show your line, never a shared one. " +
          "Connect a number to turn it on.",
        ctaLabel: "Connect a number", ctaHref: "/settings/phone",
      }
    case "no_twilio":
      return {
        reason:
          "Your calling provider isn't connected yet. Once it is, the AI can place calls from your own number.",
        ctaLabel: "Connect calling", ctaHref: "/settings/phone",
      }
    default:
      return { reason: null, ctaLabel: null, ctaHref: null }
  }
}

// lib/communication/call-disclosures.ts
// ─────────────────────────────────────────────────────────────────────────────
// PURE disclosure composers for AI calls — importable from simulators and any
// runtime (no server-only guard; nothing here touches secrets or I/O).
//
// UNIFORM NATIONAL POSTURE (the defensible one):
//  · AI disclosure on EVERY AI call — the FCC's 2024 ruling puts AI-generated
//    voices under the TCPA, and state bot laws (CA B.O.T. Act, Utah AI Policy
//    Act, Colorado AI Act) require disclosing the AI. One policy, all states.
//  · Recording announcement on EVERY recorded call — 13 all-party-consent
//    states require it; always announcing removes the state-lookup failure mode.
// Both composers are idempotent — they never stack a second disclosure onto a
// message that already carries one.

export const RECORDING_DISCLOSURE =
  "This call may be recorded for quality and training purposes. "

const AI_MENTION = /\b(AI|A\.I\.|artificial intelligence|virtual assistant|digital assistant|automated assistant)\b/i

/** PURE: is the AI already disclosed in this message? */
export function hasAiDisclosure(message: string): boolean {
  return AI_MENTION.test(message)
}

/** PURE: guarantee the AI disclosure — prepend only when absent. */
export function ensureAiDisclosure(firstMessage: string): string {
  if (hasAiDisclosure(firstMessage)) return firstMessage
  return `You're speaking with an AI assistant. ${firstMessage}`
}

/** PURE: the full legal preamble for an AI call's first message — AI disclosure
 *  (always) + recording announcement (when the call is recorded, which is the
 *  default). THE one composer both inbound and outbound paths use. */
export function withAiCallDisclosures(
  firstMessage: string,
  opts: { recipientPhone?: string | null; recorded?: boolean } = {},
): string {
  let msg = ensureAiDisclosure(firstMessage)
  if (opts.recorded !== false && !/recorded/i.test(msg)) {
    msg = `${RECORDING_DISCLOSURE}${msg}`
  }
  return msg
}

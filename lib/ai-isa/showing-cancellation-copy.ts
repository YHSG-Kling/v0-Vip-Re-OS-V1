// lib/ai-isa/showing-cancellation-copy.ts
// ─────────────────────────────────────────────────────────────────────────────
// PURE copy core for the showing-cancellation follow-up — a buyer who cancels a tour is a warm
// moment, not a dead end. The deterministic floor (the gateway may rewrite in the agent's voice;
// this is the warm, them-first, portal-driving baseline). No I/O, no server-only — unit-testable.

import { sanitizeProperNoun } from "@/lib/compliance/client-text-guard"

/** Days back to sweep for freshly-cancelled showings (next-day gentle, not an instant pushy ping). */
export const CANCELLATION_LOOKBACK_DAYS = 3

/** PURE. The warm, them-first reschedule/pivot copy (the gateway can rewrite; this is the floor). */
export function buildCancellationFollowup(
  firstName: string | null,
  propertyAddress: string | null,
): { subject: string; body: string } {
  const name = sanitizeProperNoun(firstName ?? "", 60) || "there"
  const home = propertyAddress ? ` for ${propertyAddress}` : ""
  return {
    subject: "Want to find another time — or a few others?",
    body: `Hi ${name} — I saw the showing${home} didn't end up working out, no problem at all. Want me to find another time that fits your schedule? Or, if it's not quite the one, I can line up a couple of similar homes that just came up. Either way, everything's waiting for you in your portal whenever you're ready.`,
  }
}

// lib/voice/voice-report-format.ts
//
// Voice spoken-output for the glass-box reports — turns the decision-receipts trail and the
// steer-my-day digest into natural spoken sentences, so the agent can ASK ("why did the Hendersons
// get that?", "who's slipping today?") and HEAR a straight answer. The voice admin already exists;
// these are the report verbs' tongues. Pure (no I/O), unit-tested directly.

import type { ReceiptEntry } from "@/lib/intelligence/decision-receipts"
import type { SteerMyDay } from "@/lib/intelligence/steer-my-day"

/** Spoken "here's why this client got what they got" — the most recent receipts, plainly. Pure. */
export function spokenReceipts(contactName: string | null, receipts: ReceiptEntry[], maxN = 4): string {
  const who = contactName?.trim() || "this contact"
  if (!receipts || receipts.length === 0) {
    return `I don't have any recorded touches for ${who} yet — nothing's gone out, and nothing's been held.`
  }
  const lines = receipts.slice(0, maxN).map((r) => r.summary)
  return `Here's the trail for ${who}: ${lines.join("; ")}.`
}

/** Spoken "who needs you first + what the team plans today" from the steer-my-day digest. The work
 *  queue spans the whole funnel, so a lead is named as a lead and a lifetime client as a client. Pure. */
export function spokenSteerDay(steer: SteerMyDay, names?: Record<string, string>): string {
  if (!steer) return "Nothing to steer today."
  if (steer.workFirst.length === 0) {
    return `${steer.headline}.`
  }
  const who = steer.workFirst
    .map((w) => {
      const name = names?.[w.id] ?? (w.kind === "lead" ? "a lead" : "a client")
      return w.kind === "lead" ? `${name} (lead, ${w.band}, ${w.score})` : `${name} (${w.band}, ${w.score})`
    })
    .join(", ")
  return `${steer.headline}. Work these first: ${who}.`
}

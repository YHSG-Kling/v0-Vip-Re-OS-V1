/**
 * lib/buyer-search/voice-turn.ts — THE VOICE TURN-TAKING MODEL (wave 147, lane 147C, contract C10).
 *
 * CLIENT-SAFE and PURE: no server import of any kind (only types), so the buyer's portal can
 * compose what it SPEAKS from the server's answer without bundling a service client.
 *
 * The model, in the order the buyer experiences it:
 *   1. The buyer TAPS to talk. The portal never listens unprompted (privacy, and no surprise
 *      recordings) — a tap is the turn boundary.
 *   2. Their words become the same turn a typed sentence is (one parser, one store, one search).
 *   3. The assistant answers SHORT: at most three homes (a listener cannot hold more), one
 *      sentence each — how many of their asks fit, the first miss, and which asks the listing
 *      cannot answer, said as unknown.
 *   4. It ends with exactly ONE question (the first "what you didn't say" clarification, else an
 *      offer to keep watching or to widen) — then it stops talking and waits for the next tap.
 *   5. Barge-in: a tap while it is speaking cancels the speech; the buyer always has the floor.
 */
import type { CriteriaFit } from "./explanation-generator"

export interface VoiceQuestion { question: string }

/** Speak a price the way a person says it ("575 thousand", "1.2 million"). */
export function spokenPrice(n: number | null): string {
  if (n == null) return "an unlisted price"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, "")} million`
  if (n >= 10_000) return `${Math.round(n / 1000)} thousand`
  return `${n} dollars`
}

/** PURE. The spoken turn: ≤ 3 homes, one sentence each, unknowns said as unknown, ONE question. */
export function voiceTurnPlan(input: {
  results: Array<{ label: string; price: number | null; fit: CriteriaFit | null }>
  clarifications: VoiceQuestion[]
  changedFields?: string[]
}): { spoken: string; question: string } {
  const lines: string[] = []
  if (input.changedFields?.length) lines.push("Got it — I've updated your search.")
  if (input.results.length === 0) {
    lines.push("Nothing matches all of that right now.")
  } else {
    lines.push(`I found ${input.results.length} ${input.results.length === 1 ? "home" : "homes"}. Here ${input.results.length === 1 ? "it is" : "are the top ones"}.`)
    for (const r of input.results.slice(0, 3)) {
      const parts = [`${r.label}, at ${spokenPrice(r.price)}`]
      const fit = r.fit
      if (fit) {
        const total = fit.matches.length + fit.misses.length
        if (total > 0) parts.push(`fits ${fit.matches.length} of ${total} things you asked for`)
        if (fit.misses[0]) parts.push(`but ${fit.misses[0].detail.charAt(0).toLowerCase()}${fit.misses[0].detail.slice(1)}`)
        if (fit.unknowns.length) parts.push(`and the listing can't tell me about ${fit.unknowns.slice(0, 2).map((u) => u.ask.toLowerCase()).join(" or ")}`)
      }
      lines.push(`${parts.join(", ")}.`)
    }
  }
  const question = input.clarifications[0]?.question
    ?? (input.results.length ? "Want me to keep watching for new ones like these?" : "Should I widen the price or the area a little?")
  return { spoken: `${lines.join(" ")} ${question}`.trim(), question }
}

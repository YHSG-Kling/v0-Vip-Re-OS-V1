/**
 * lib/intelligence/small-wins.ts
 *
 * SMALL-WINS CELEBRATION (concierge list #20) — "celebrate app acceptance,
 * loan approval, inspection resolution — not just closing." The portal
 * already celebrates these moments TO the client (event-translator
 * severity 'celebration'); this closes the AGENT half: the morning after a
 * mid-deal win, the briefing hands the agent a congrats note already
 * drafted, with the Gift Studio one click away for the moments that
 * deserve more than words.
 *
 * The signal is REAL: portal_event_stream rows the projector already
 * resolved to a contact + agent, severity 'celebration'. Two celebrations
 * are DELIBERATELY excluded — transaction.closed (the Gift Studio's
 * ungifted-closings queue owns closing gifts) and lifetime.anniversary
 * (the anniversary rail owns it) — one moment, one owner, no double
 * nudges. PURE composer; the loader in daily-briefing-generator does the
 * I/O. NOT server-only (simulator-driven).
 */

import type { PriorityAction } from "./daily-briefing-generator"

export interface CelebrationRow {
  contactId: string
  /** how the client prefers to be addressed (resolveAddressing.addressAs). */
  addressAs: string
  /** portal_event_stream.event_type (celebration severity). */
  eventType: string
}

/** Celebrations OWNED by other rails — never double-nudged here. */
export const CELEBRATIONS_OWNED_ELSEWHERE = new Set(["transaction.closed", "lifetime.anniversary"])

const WINS: Record<string, { line: string; manager: string }> = {
  "offer.accepted":              { line: "their offer just got accepted",       manager: "shopping_agent" },
  "transaction.under_contract":  { line: "they're officially under contract",   manager: "deal_coordinator" },
  "financing.cleared":           { line: "their financing cleared",             manager: "deal_coordinator" },
  "transaction.closing_scheduled": { line: "their closing date is on the calendar", manager: "deal_coordinator" },
  "listing.went_live":           { line: "their home just went live",           manager: "listing_concierge" },
}

/** PURE: yesterday's mid-deal wins → congrats actions with the note drafted.
 *  One win per contact (latest first in the input wins); capped. */
export function composeSmallWinActions(rows: CelebrationRow[], limit = 3): PriorityAction[] {
  const seen = new Set<string>()
  const out: PriorityAction[] = []
  for (const r of rows) {
    if (CELEBRATIONS_OWNED_ELSEWHERE.has(r.eventType)) continue
    const win = WINS[r.eventType]
    if (!win) continue
    if (seen.has(r.contactId)) continue
    seen.add(r.contactId)
    out.push({
      priority: "medium",
      action: `Celebrate with ${r.addressAs} — ${win.line}`,
      context: `Draft: "${r.addressAs}, ${win.line} — that's a real milestone and you earned it. Take a breath tonight; I've got the next steps." A small congrats gift is one click in the Gift Studio (occasion: congratulations).`,
      manager: win.manager,
      entity_type: "contact",
      entity_id: r.contactId,
      action_type: "draft_followup",
    })
    if (out.length >= limit) break
  }
  return out
}

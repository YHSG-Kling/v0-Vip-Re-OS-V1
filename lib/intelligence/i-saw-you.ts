/**
 * lib/intelligence/i-saw-you.ts
 *
 * END-OF-DAY "I SAW YOU" NOTES — the luxury-details manifesto, verbatim:
 * "When a client engages heavily (many listings viewed, questions asked),
 * the OS suggests a simple 'Saw how much you worked on this today; here's
 * what I'm doing with it' note to close the loop."
 *
 * The signal is REAL engagement the portal already records —
 * client_portal_activity rows (affordability checks, offer-help asks,
 * modules viewed, showing requests) plus property_views touched in the
 * same window. A client who put in a heavy evening and hears NOTHING back
 * learns the portal is a vending machine; one line from their agent the
 * next morning teaches them a team watched.
 *
 * PURE composer: rows in → PriorityAction[] for the agent's morning
 * briefing, each carrying a ready-to-send, NON-SALESY draft (recognition,
 * not a pitch — no listings attached, no ask). The threshold keeps this an
 * "I see you" moment, not noise: light browsing never triggers it.
 * Deterministic; the loader in daily-briefing-generator does the I/O.
 * NOT server-only (simulator-driven).
 */

import type { PriorityAction } from "./daily-briefing-generator"

export interface EngagementDayRow {
  contactId: string
  /** how the client prefers to be addressed (resolveAddressing.addressAs). */
  addressAs: string
  /** client_portal_activity rows in the window (real actions they took). */
  portalActions: number
  /** distinct saved/matched homes they viewed in the window. */
  homesViewed: number
  /** the most human-readable thing they did (e.g. "checked affordability"), optional. */
  highlight: string | null
}

/** A day counts as HEAVY when the client did real work, not a drive-by. */
export const I_SAW_YOU_MIN_SIGNALS = 4

const workedOn = (r: EngagementDayRow): string => {
  const bits: string[] = []
  if (r.homesViewed > 0) bits.push(`${r.homesViewed} home${r.homesViewed === 1 ? "" : "s"}`)
  if (r.portalActions > 0) bits.push(`${r.portalActions} step${r.portalActions === 1 ? "" : "s"} in your portal`)
  return bits.join(" and ")
}

/** PURE: heavy-engagement days → morning-briefing actions with the note
 *  already drafted. Sorted busiest-first, capped (a briefing, not a feed). */
export function composeISawYouActions(rows: EngagementDayRow[], limit = 3): PriorityAction[] {
  return rows
    .filter((r) => r.portalActions + r.homesViewed >= I_SAW_YOU_MIN_SIGNALS)
    .sort((a, b) => (b.portalActions + b.homesViewed) - (a.portalActions + a.homesViewed))
    .slice(0, limit)
    .map((r) => ({
      priority: "medium" as const,
      action: `Send ${r.addressAs} an "I saw you" note — they put real time in yesterday`,
      context: [
        `Draft (recognition, not a pitch): "${r.addressAs}, I saw how much ground you covered yesterday — ${workedOn(r)}${r.highlight ? `, including ${r.highlight}` : ""}. I'm working through what that tells me and I'll bring you my read. Nothing you need to do."`,
      ].join(" "),
      manager: "sphere_of_influence",
      entity_type: "contact" as const,
      entity_id: r.contactId,
      action_type: "draft_followup" as const,
    }))
}

/** Humanize a client_portal_activity.activity_type for the draft's highlight. */
export function humanizePortalActivity(activityType: string | null | undefined): string | null {
  const t = (activityType ?? "").toLowerCase()
  if (!t) return null
  if (t.includes("affordability")) return "checking what you can afford"
  if (t.includes("offer")) return "working through offer questions"
  if (t.includes("net_sheet")) return "running your net-proceeds numbers"
  if (t.includes("showing")) return "requesting a showing"
  if (t.includes("module")) return "reading up on the process"
  if (t.includes("task")) return "knocking out your checklist"
  return null
}

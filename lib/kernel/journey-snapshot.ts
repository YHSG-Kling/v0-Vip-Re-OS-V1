// lib/kernel/journey-snapshot.ts
//
// JOURNEY SNAPSHOT (the spec's "expose visible status" rule) — one line that
// makes the journey-first architecture VISIBLE to the agent: which journey
// this contact is living, what stage, the last frontier that fired, and
// what's next. Composed ENTIRELY from state the OS already writes (deal
// stage, buyer stage, close date, the frontier rationale tags) — no new
// tables, no new writes; the tags ARE the journey memory.

export interface FrontierTouch { kind: string; at: string }

/** PURE: recognize a frontier's rationale tag and name it in agent language. */
export function parseFrontierKind(rationale: string | null | undefined): string | null {
  const r = rationale ?? ""
  if (r.includes("[TOUR_RECAP]")) return "tour recap"
  if (r.includes("[BUYER_WEEKLY]")) return "weekly search story"
  if (r.includes("[SELLER_WEEKLY]")) return "weekly seller update"
  if (r.includes("[TC_WEEKLY]")) return "weekly deal note"
  if (r.includes("[POSTCLOSE]")) return "post-close check-in"
  if (r.includes("[WEEKLY_REVIEW]")) return "week-in-review"
  return null
}

export interface JourneyInputs {
  contactType: string | null
  buyerStage: string | null
  /** the active transaction's stage, when one exists */
  activeDealStage: string | null
  /** days since this contact's most recent CLOSED deal (null = never closed) */
  closedDaysAgo: number | null
  lastFrontier: FrontierTouch | null
}

export interface JourneySnapshot {
  journey: "transaction" | "post_close" | "seller" | "buyer" | "lead"
  stage: string
  /** the one agent-facing line */
  line: string
}

const NEXT_FRONTIER: Record<JourneySnapshot["journey"], string> = {
  transaction: "weekly deal note",
  post_close: "next care check-in",
  seller: "weekly seller update",
  buyer: "weekly search story",
  lead: "speed-to-lead / nurture touch",
}

/** PURE: which journey is this contact living right now? Precedence mirrors
 *  the business: an active deal outranks everything; a recent close outranks
 *  shopping; then seller/buyer by their live state; else the lead journey. */
export function composeJourneySnapshot(i: JourneyInputs, now: Date = new Date()): JourneySnapshot {
  let journey: JourneySnapshot["journey"]
  let stage: string
  if (i.activeDealStage) {
    journey = "transaction"
    stage = i.activeDealStage.replace(/_/g, " ")
  } else if (i.closedDaysAgo != null && i.closedDaysAgo <= 60) {
    journey = "post_close"
    stage = i.closedDaysAgo <= 7 ? "moving in" : i.closedDaysAgo <= 30 ? "settling in" : "first-month care"
  } else if ((i.contactType ?? "").includes("seller")) {
    journey = "seller"
    stage = "active listing relationship"
  } else if (i.buyerStage || (i.contactType ?? "").includes("buyer")) {
    journey = "buyer"
    stage = (i.buyerStage ?? "searching").replace(/_/g, " ")
  } else {
    journey = "lead"
    stage = "qualifying"
  }

  const journeyName = { transaction: "Transaction", post_close: "Post-Close", seller: "Seller", buyer: "Buyer", lead: "Lead-to-Client" }[journey]
  const parts: string[] = [`${journeyName} journey — ${stage}`]
  if (i.lastFrontier) {
    const days = Math.max(0, Math.floor((now.getTime() - new Date(i.lastFrontier.at).getTime()) / 86_400_000))
    parts.push(`last touch: ${i.lastFrontier.kind} ${days === 0 ? "today" : `${days}d ago`}`)
  }
  parts.push(`next: ${NEXT_FRONTIER[journey]}`)
  return { journey, stage, line: parts.join(" · ") }
}

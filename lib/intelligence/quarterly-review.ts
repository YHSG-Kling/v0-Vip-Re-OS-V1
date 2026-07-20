/**
 * lib/intelligence/quarterly-review.ts
 *
 * THE QUARTERLY BUSINESS REVIEW (tenant concierge list #32) — the weekly
 * Partners' Meeting tells the principal what happened THIS week; the QBR
 * is the retention artifact: once a quarter, "here's what your AI team
 * produced, the trust you earned, what's sitting unused, and the next
 * moves" — outcomes, gaps, and recommendations in one calm read. Every
 * number is a real count from the tenant's own tables (the loader in
 * app/actions/quarterly-review.ts); a zero is SHOWN as a zero with the
 * unblocking step, never dressed up. Consumes the expansion advisor so
 * tier suggestions arrive HERE, grounded, instead of as upsell spam.
 * PURE composer; finance_manager owns business outcomes. NOT server-only.
 */

import type { ExpansionSuggestion } from "@/lib/platform/expansion-advisor"

export interface QuarterFacts {
  /** trailing-90d window label composed by the caller (e.g. "Apr 14 – Jul 13"). */
  windowLabel: string
  planTier: string | null
  closedDeals: number
  closedVolume: number
  activeDeals: number
  newContacts: number
  /** human decisions on AI-staged work (drafts approved etc.) in the window. */
  approvals: number
  /** green auto_* policy rows — acts the team performed under earned grants. */
  autonomousActs: number
  /** standing autonomy grants currently held. */
  grantsHeld: number
  conflictsCaught: number
  giftsOrdered: number
  briefingsOpened: number
  /** honest unused rails, each with its unblocking step. */
  unusedRails: string[]
  /** moments automation needed a human recovery or override (90d, from the
   *  ledgers other rails already write) — the drift review's input. */
  trustIncidents: number
  expansion: ExpansionSuggestion | null
  /** DEAL VELOCITY — the pre-composed decision→execution line (null when the
   *  sample is too thin to claim honestly; see decision-velocity). */
  velocityLine?: string | null
  /** AI-SOURCED VALUE — the provenance rollup line ("the AI pipeline sourced N
   *  relationships that closed M deals worth $X GCI"); null when the pipeline
   *  hasn't produced yet — never fabricated. */
  aiSourcedLine?: string | null
  /** PREDICTION-ACCURACY TRUST CHIP (round 35) — the ONE measured "the system
   *  grades itself" line (lib/analytics/prediction-accuracy); null until a
   *  rail crosses its honest threshold — never fabricated. */
  accuracyTrustLine?: string | null
  /** TEAMWORK (round 35) — pre-composed lines from the cross-referral + deliberation
   *  ledgers (lib/managers/teamwork-metrics composeTeamworkLines): referrals crossed,
   *  pickup speed, deliberations argued, dissents on the record. Empty/omitted when
   *  the managers had nothing cross-managed this quarter — the section is omitted,
   *  never fabricated. */
  teamworkLines?: string[]
}

export interface QuarterlyReview {
  headline: string
  outcomes: string[]
  trust: string[]
  /** How the managers worked TOGETHER (referrals + argued deliberations) — empty
   *  array on a quarter with no cross-management, and the renderer omits it. */
  teamwork: string[]
  gaps: string[]
  nextMoves: string[]
}

const usd = (n: number): string => `$${Math.round(n).toLocaleString("en-US")}`

export function composeQuarterlyReview(f: QuarterFacts): QuarterlyReview {
  const outcomes: string[] = [
    f.closedDeals > 0
      ? `${f.closedDeals} closing${f.closedDeals === 1 ? "" : "s"}${f.closedVolume > 0 ? ` (${usd(f.closedVolume)} in volume)` : ""}, ${f.activeDeals} deal${f.activeDeals === 1 ? "" : "s"} in flight.`
      : `No closings this quarter yet — ${f.activeDeals} deal${f.activeDeals === 1 ? "" : "s"} in flight.`,
    `${f.newContacts} new contact${f.newContacts === 1 ? "" : "s"} entered the book.`,
  ]
  if (f.giftsOrdered > 0) outcomes.push(`${f.giftsOrdered} client gift${f.giftsOrdered === 1 ? "" : "s"} ordered through the Gift Studio.`)
  if (f.aiSourcedLine) outcomes.push(f.aiSourcedLine)

  const trust: string[] = [
    f.approvals > 0
      ? `Your team approved ${f.approvals} AI-prepared item${f.approvals === 1 ? "" : "s"} — every approval builds the earned-autonomy record.`
      : `No AI-prepared items were reviewed this quarter — the approval queue is where the team earns standing autonomy.`,
  ]
  if (f.grantsHeld > 0 || f.autonomousActs > 0) {
    trust.push(`${f.grantsHeld} standing autonomy grant${f.grantsHeld === 1 ? "" : "s"} held; ${f.autonomousActs} act${f.autonomousActs === 1 ? "" : "s"} performed under them — each one on the policy ledger, revocable any time.`)
  }
  if (f.conflictsCaught > 0) {
    trust.push(`${f.conflictsCaught} document/date conflict${f.conflictsCaught === 1 ? "" : "s"} caught before ${f.conflictsCaught === 1 ? "it" : "they"} cost anyone a deadline.`)
  }
  trust.push(f.trustIncidents === 0
    ? `Zero trust incidents — no send failed, no deal was flagged, nothing needed a recovery. The standard held.`
    : `${f.trustIncidents} trust incident${f.trustIncidents === 1 ? "" : "s"} (failed sends, flagged deals, recoveries) — each one is on the ledger with what happened next.`)
  // DEAL VELOCITY — the differentiator stat, only when the sample is honest.
  if (f.velocityLine) trust.push(f.velocityLine)
  // PREDICTION ACCURACY — the self-grading chip, only when a rail earned it.
  if (f.accuracyTrustLine) trust.push(f.accuracyTrustLine)

  const gaps = [...f.unusedRails]
  if (f.briefingsOpened === 0) gaps.push(`The morning briefing went unread — it's where handoffs, client recognition, and wins surface daily.`)

  const nextMoves: string[] = []
  if (gaps.length > 0) nextMoves.push(`Turn on one unused rail this month — the first one on the list is the highest-leverage.`)
  if (f.approvals > 0 && f.grantsHeld === 0) nextMoves.push(`Keep approving consistently — grants unlock automatically once a shape earns a clean record.`)
  if (f.expansion) nextMoves.push(`${f.expansion.reason} (suggested: ${f.expansion.suggestTier.replace(/_/g, " ")} plan — your call, nothing changes automatically.)`)
  if (f.trustIncidents > 3) nextMoves.push(`Hold the service-standard drift review — ${f.trustIncidents} moments needed a recovery or an override this quarter. Walk the incident ledger and ask of each rail: does this still feel like concierge?`)
  if (nextMoves.length === 0) nextMoves.push(`Steady quarter — the next review lands in 90 days.`)

  return {
    headline: `Your quarter, ${f.windowLabel}`,
    outcomes,
    trust,
    teamwork: f.teamworkLines ?? [],
    gaps,
    nextMoves,
  }
}

/**
 * lib/intelligence/qbr-invitation.ts
 *
 * QBR INVITATION — the pull-to-push bridge for the Quarterly Business
 * Review. The review itself is composed by the ONE loader
 * (lib/intelligence/quarterly-review-loader.ts, shared with the dashboard
 * action and the spoken verb — keep-one rule); this file only decides
 * WHEN the standing invitation goes out, WHICH earned facts headline it,
 * and the calm brand-voiced copy. Every function here is PURE — the cron
 * (app/api/cron/qbr-invitations/route.ts) does all reads and writes.
 *
 * HONESTY RULES: headline facts are lines the QBR composer itself only
 * writes when the quarter EARNED them — a zero-quarter line ("No closings
 * this quarter yet…") never becomes a hype hook. When nothing is earned
 * the invitation still goes, shorter, without manufactured wins. Dedupe
 * is per (principal, quarter) against the notifications ledger itself —
 * no new table, no parallel state.
 */

import type { QuarterlyReview } from "@/lib/intelligence/quarterly-review"

/** notifications.type for the invitation (mirrors board_packet_ready's rail). */
export const QBR_INVITATION_TYPE = "qbr_invitation"

/** Where the invitation points: the Command Center, whose QBR card is the
 *  principal's review surface (URL carried in the body — the exact
 *  board_packet_ready idiom; the bell has no route for this entity type). */
export const QBR_DEEP_LINK = "/dashboard/admin/command-center"

/** "2026-Q3" for any date inside Q3 2026 (UTC) — the dedupe tag. */
export function quarterTag(now: Date): string {
  return `${now.getUTCFullYear()}-Q${Math.floor(now.getUTCMonth() / 3) + 1}`
}

/** ISO start of the CURRENT quarter (UTC) — the dedupe window's left edge:
 *  one qbr_invitation notification per principal with created_at past this
 *  line means this quarter's invitation already went. */
export function quarterStartIso(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), Math.floor(now.getUTCMonth() / 3) * 3, 1)).toISOString()
}

/** Early in the first month of a quarter (UTC days 1–10 of Jan/Apr/Jul/Oct).
 *  The route self-gates on this, so even a daily schedule no-ops cleanly
 *  outside the window (the quarterly-tax-concierge idiom). */
export function isQbrInvitationWindow(now: Date): boolean {
  return now.getUTCMonth() % 3 === 0 && now.getUTCDate() <= 10
}

/** Lines the QBR composer writes for EMPTY quarters (or absence-claims) —
 *  never invitation material. Everything else in outcomes/trust exists only
 *  because real ledger rows earned it. */
const UNEARNED = [/^no /i, /^zero /i, /^0 /, /trust incident/i]

/** 2–3 earned headline facts, outcomes first (closings, contacts, AI-sourced
 *  value) then trust (approvals, grants, conflicts caught, deal velocity).
 *  Empty array when the quarter earned nothing — the caller omits, never pads. */
export function pickHeadlineFacts(review: QuarterlyReview, max = 3): string[] {
  const earned = (l: string) => !UNEARNED.some((re) => re.test(l))
  return [...review.outcomes.filter(earned), ...review.trust.filter(earned)].slice(0, Math.max(0, max))
}

/** The invitation itself — calm and concrete, brand voice per the script
 *  charter (confident, never hype). Facts arrive pre-earned from
 *  pickHeadlineFacts; zero facts produces the shorter honest invite. */
export function composeQbrInvitation(input: { facts: string[] }): { title: string; body: string } {
  const title = "Your quarterly business review is ready"
  const body =
    input.facts.length > 0
      ? `The headlines from your last 90 days: ${input.facts.join(" ")} The full review — outcomes, the trust your AI team earned, what's sitting unused, and next moves — is waiting in your Command Center: ${QBR_DEEP_LINK}`
      : `Your AI team's 90-day review — what happened, the trust earned, and the next moves — is waiting in your Command Center: ${QBR_DEEP_LINK}`
  return { title, body }
}

// lib/buyer-search/investor-facing.ts
//
// THE READER-BOUNDARY REDACTOR — wave 68 owner ruling, verbatim: "these investors should
// not get the owners information because we don't want the investor to try and buy directly
// to the owner." investor_offmarket_candidates carries owner_name (and would carry an owner
// phone/email/mailing address if BatchData's owner-contact dataset is ever added to the
// row) because the BROKERAGE'S AGENT needs it to work the off-market deal. An INVESTOR must
// never see it — not in the UI, and not in the wire payload a server action returns, which a
// TypeScript client-side type alone does not stop (the JSON on the wire carries every key the
// select named, whatever the receiving component destructures).
//
// This is the ONE place that boundary is drawn. Every reader that could put a candidate row
// in front of an investor goes through it — lib/buyer-search/investor-offmarket-runner.ts's
// getInvestorDealMatch, app/actions/investor-deals.ts's getInvestorDealMatchAction, and any
// future portal/contact-visible surface — so the redaction can't be forgotten on a new call
// site. The underlying SELECT in the runner KEEPS owner_name (the brokerage-side / agent
// reader still needs it); only the reader boundary strips it, per the audience asked for.

const OWNER_FIELDS = ["owner_name", "owner_phone", "owner_email", "owner_mailing_address"] as const

export type CandidateAudience = "investor" | "brokerage"

export interface OffMarketCandidateRow {
  [key: string]: unknown
  owner_name?: string | null
  owner_phone?: string | null
  owner_email?: string | null
  owner_mailing_address?: string | null
}

export type InvestorFacingCandidate<T extends OffMarketCandidateRow> = Omit<
  T,
  "owner_name" | "owner_phone" | "owner_email" | "owner_mailing_address"
>

/**
 * Strip every owner-identifying field from a candidate row for the given audience.
 * `audience: "brokerage"` is an explicit no-op passthrough — the agent's own
 * contact-intelligence / admin surface is the one place owner_name still has a reader
 * (CLAUDE.md §1: a column with no reader gets one built, not deleted — this keeps it one,
 * on purpose, for the surface allowed to read it).
 *
 * `audience` defaults to "investor" so a caller that forgets to pass it gets the SAFE
 * (redacted) shape rather than a silent leak.
 */
/** @proofSeam the named single-row primitive the wave-68 owner ruling asked for
 *  (`toInvestorFacingCandidate(row)`); production reaches it only THROUGH
 *  toInvestorFacingCandidates below (the runner's actual call site), so this is
 *  unit-tested directly by scripts/buyer-matching-rails-simulator.ts rather than
 *  exercised by a second production caller. */
export function toInvestorFacingCandidate<T extends OffMarketCandidateRow>(
  row: T,
  audience: CandidateAudience = "investor",
): T | InvestorFacingCandidate<T> {
  if (audience === "brokerage") return row
  const clone: Record<string, unknown> = { ...row }
  for (const f of OWNER_FIELDS) delete clone[f]
  return clone as InvestorFacingCandidate<T>
}

/** Same redaction, applied to a whole array — the shape getInvestorDealMatch returns. */
export function toInvestorFacingCandidates<T extends OffMarketCandidateRow>(
  rows: readonly T[],
  audience: CandidateAudience = "investor",
): Array<T | InvestorFacingCandidate<T>> {
  return (rows ?? []).map((r) => toInvestorFacingCandidate(r, audience))
}

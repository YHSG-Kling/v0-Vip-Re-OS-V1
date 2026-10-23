// lib/commission/referral-payout.ts — THE AGENT-TO-AGENT REFERRAL FEE AS A WATERFALL DEDUCTION (wave 143, lane 143C).
//
// PURE (no I/O) — the rule stage 03b (lib/commission/waterfall/03b-referral-deduction.ts) applies and test:agreement-waterfall proves.
//
// Owner (2026-10-23): "CDA payouts include referrals. All financials must be accurate for brokerage, agents and teams."
// and the waterfall order "gross, REFERRAL DEDUCTIONS, brokerage split, agent/team share, team-leader share, fees,
// residual, revenue share, disbursement, net".
//
// WHAT WAS WRONG AT HEAD (measured, 21da8e4e):
//   lib/agents/referral-closer.ts booked the fee as a free-standing commission_distributions row AFTER the close,
//   computed on transactions.commission_amount, with no commission_id and deducted from NOBODY. Step 11's identity
//   (gross == distributed + finals) never saw it, the receiving agent still netted 100% of the split, the economic graph
//   showed a share the deal never funded, and the CDA (cdaWaterfallContext) had no referral line at all — so the
//   referring agent was owed money the deal had not set aside, and title was never told to disburse it.
//
// THE RULE (extends, does not invent): the referral record's own AGREED fee percent (referrals.referral_fee_pct — the
// agreement made when the referral was created, never today's profile) is taken off the top of the ADJUSTED GROSS before
// the brokerage/agent split, paid to the referring agent, funded by the deal (source_of_funds 'brokerage' — the same
// vocabulary stage 03 uses for gross-level movements). One deal consumes one referral: referrals.transaction_id (m812) is
// the link, set compare-and-swap by stage 11, so a referral can never pay on two closings.
//
// NOT BUILT, said plainly (never guessed): an EXTERNAL referral partner / outside brokerage fee. Who may lawfully receive
// a referral fee varies by state and by licensure (RESPA §8 for settlement services; state real-estate licensing laws for
// brokerage referral fees); that needs a counsel-approved recipient rule before any code pays a non-agent. Those referrals
// (partner_id without referring_agent_id) are left untouched — they keep their existing thank-you / lifetime-value loop.

export interface ReferralCandidate {
  id: string
  /** The RECEIVING agent (referrals.agent_id, NOT NULL). */
  agent_id?: string | null
  /** The REFERRING agent — the payee. Null for an external partner / contact referral (not handled here). */
  referring_agent_id?: string | null
  referral_fee_pct?: unknown
  status?: string | null
  /** The deal this referral was consumed by (m812). undefined = the column is not applied yet. */
  transaction_id?: string | null
  created_at?: string | null
}

export interface ReferralPick {
  referral: ReferralCandidate | null
  /** The agreed percent (0 < pct <= 100) when a fee applies. */
  feePct: number | null
  /** True when the referral was already linked to THIS deal (a re-run) — nothing to link. */
  alreadyLinked: boolean
  findings: string[]
}

/** PURE — the agreed fee percent from the referral record, or null when absent / out of range (never fabricated). */
export function agreedReferralPct(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : null
}

/** PURE — cents of the fee on a base, one rounding at the boundary. */
export function referralFeeCents(baseCents: number, pct: number): number {
  if (!Number.isFinite(baseCents) || baseCents <= 0 || !(pct > 0)) return 0
  return Math.round(baseCents * (pct / 100))
}

/**
 * PURE — which referral (if any) pays on this deal.
 * 1. A referral already linked to this transaction (a re-run) wins.
 * 2. Otherwise the newest UNLINKED, non-lost agent-to-agent referral for the deal's contacts.
 * A referral that cannot lawfully/clearly pay is SKIPPED WITH A FINDING — never paid on a guess:
 *   · referring agent == producing agent (nobody pays themselves);
 *   · the referral is assigned to a different receiving agent than the one closing (a human must reassign);
 *   · no agreed fee percent is recorded.
 */
export function pickReferralForDeal(
  rows: ReadonlyArray<ReferralCandidate>,
  ctx: { transactionId: string; producingAgentId: string },
): ReferralPick {
  const findings: string[] = []
  const none = (): ReferralPick => ({ referral: null, feePct: null, alreadyLinked: false, findings })
  const agentToAgent = rows.filter((r) => !!r.referring_agent_id)
  const linked = agentToAgent
    .filter((r) => r.transaction_id === ctx.transactionId)
    .sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")))
  const unlinked = agentToAgent
    .filter((r) => (r.transaction_id ?? null) === null && (r.status ?? "") !== "lost")
    .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))
  if (linked.length > 1) findings.push(`${linked.length} referrals are linked to this deal — the oldest (${linked[0].id}) applies; a finance admin should review the others`)
  const chosen = linked[0] ?? unlinked[0]
  if (!chosen) return none()
  const alreadyLinked = linked.length > 0
  if (chosen.referring_agent_id === ctx.producingAgentId) {
    findings.push(`referral ${chosen.id}: the referring agent is the producing agent — no fee`)
    return none()
  }
  if (chosen.agent_id && chosen.agent_id !== ctx.producingAgentId) {
    findings.push(`referral ${chosen.id}: assigned to a different receiving agent (${chosen.agent_id}) than the one closing (${ctx.producingAgentId}) — no fee booked until a human reassigns it`)
    return none()
  }
  const pct = agreedReferralPct(chosen.referral_fee_pct)
  if (pct === null) {
    findings.push(`referral ${chosen.id}: no agreed fee percent (0–100) is recorded — no fee booked (never fabricated)`)
    return none()
  }
  return { referral: chosen, feePct: pct, alreadyLinked, findings }
}

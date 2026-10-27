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
// WAVE 144 (lane 144D, owner ruling 5, 2026-10-25): "Referral is to another agent — inside the brokerage, or outside it (an
// outside agent/brokerage kept in the canonical PARTNER bucket). Linked to transaction, agreement and waterfall; correct payee
// authorization; no double payment." The recipient rule the 143C note asked for is now the owner's: an OUTSIDE payee is a
// real-estate agent / brokerage in referral_partners (partner_type 'real_estate_agent' — the one licensed-real-estate type in
// lib/referrals/partner-vocabulary.ts). Every other partner type (lender, title, inspector, attorney, contractor, insurance,
// property manager, other) is NEVER paid a referral fee here: a fee for referring settlement-service business is what RESPA
// §8(a) prohibits (12 U.S.C. 2607; the cooperative-brokerage exception, 12 CFR 1024.14(g)(1)(v), covers payments between real
// estate agents and brokers only) — VERIFIED FROM the mortgage-broker-mortgage-lending skill (RESPA: "prohibition on kickbacks
// and referral fees") and the regulation it names. The fee is payable to the partner's BROKERAGE of record (company_name):
// state license laws generally route a licensee's compensation through their own broker — the brokerage is the payee title is
// told, the individual agent is named beside it; a partner with no brokerage of record HOLDS the final calculation (a human
// records it) rather than paying an individual on a guess. State-by-state variation beyond that is a compliance review item
// (lane notes, "Still open"), never invented here.
//
// THE FEE TERMS, in order (never fabricated): the referral record's own agreed percent (referrals.referral_fee_pct — the
// agreement made for this referral), else the partner's standing percent (referral_partners.commission_split_percentage), else
// the partner's standing flat fee (referral_partners.referral_fee_flat). None → no fee, a finding.

export interface ReferralCandidate {
  id: string
  /** The RECEIVING agent (referrals.agent_id, NOT NULL). */
  agent_id?: string | null
  /** The REFERRING agent — the payee of an INSIDE referral. Null for an outside partner / contact referral. */
  referring_agent_id?: string | null
  /** WAVE 144: the OUTSIDE referring party (referrals.partner_id → referral_partners). */
  partner_id?: string | null
  referral_fee_pct?: unknown
  status?: string | null
  /** The deal this referral was consumed by (m812). undefined = the column is not applied yet. */
  transaction_id?: string | null
  created_at?: string | null
  /** WAVE 145 (lane 145C, owner ruling 9; m860): the EXECUTED referral agreement for this referral (documents) and the date it
   *  was fully executed. undefined = m860 not applied yet (read as "not on record" — fail closed). */
  referral_agreement_document_id?: string | null
  referral_agreement_executed_on?: string | null
}

/** A referral_partners row, as the payee rule reads it. */
export interface PartnerCandidate {
  id: string
  partner_type?: string | null
  partner_name?: string | null
  company_name?: string | null
  active?: boolean | null
  agreement_end_date?: string | null
  commission_split_percentage?: unknown
  referral_fee_flat?: unknown
  /** WAVE 145 (m860): the partner's STANDING executed referral agreement (documents) and the window it governs. */
  agreement_document_id?: string | null
  agreement_date?: string | null
}

/**
 * WAVE 145 (lane 145C; owner ruling 9, 2026-10-27, verbatim: "There will be agreed and executed referral agreements if a
 * brokerage needs to pay the referral on a transaction."): PURE — is an EXECUTED referral agreement on record for this payout on
 * `asOf`? The referral's own executed agreement (m860 referrals.referral_agreement_document_id + executed_on, on/before the
 * deal's date), or — for an OUTSIDE partner — the partner's standing executed agreement (m860 referral_partners
 * .agreement_document_id) whose window (agreement_date … agreement_end_date) contains the deal's date. Never a percent typed on
 * a row, never an `informal` partner arrangement, never a date without the paper. Module-private: reached through
 * pickReferralForDeal (a payout owed without it HOLDS a final — the fee is not paid on a guess, and not silently dropped).
 */
function referralAgreementOnRecord(referral: ReferralCandidate, partner: PartnerCandidate | null | undefined, asOf: string): { ok: true; basis: string } | { ok: false; why: string } {
  const own = typeof referral.referral_agreement_document_id === "string" && referral.referral_agreement_document_id.length > 0
  const executedOn = typeof referral.referral_agreement_executed_on === "string" ? referral.referral_agreement_executed_on.slice(0, 10) : null
  if (own && executedOn && executedOn <= asOf) return { ok: true, basis: `the referral's executed agreement (document ${referral.referral_agreement_document_id}, executed ${executedOn})` }
  if (own && executedOn && executedOn > asOf) return { ok: false, why: `its referral agreement was executed ${executedOn}, after the deal's date ${asOf}` }
  if (partner && typeof partner.agreement_document_id === "string" && partner.agreement_document_id.length > 0) {
    const from = typeof partner.agreement_date === "string" ? partner.agreement_date.slice(0, 10) : null
    const end = typeof partner.agreement_end_date === "string" ? partner.agreement_end_date.slice(0, 10) : null
    if ((!from || from <= asOf) && (!end || end >= asOf)) return { ok: true, basis: `partner ${partner.id}'s standing executed referral agreement (document ${partner.agreement_document_id})` }
    return { ok: false, why: `partner ${partner.id}'s standing referral agreement does not cover the deal's date ${asOf}` }
  }
  return { ok: false, why: "no executed referral agreement is on record" }
}

export type ReferralPayee =
  | { kind: "agent"; agentId: string }
  | { kind: "partner"; partnerId: string; brokerageName: string; agentName: string | null }

export interface ReferralPick {
  referral: ReferralCandidate | null
  /** The agreed percent (0 < pct <= 100) when a percent fee applies. */
  feePct: number | null
  /** WAVE 144: the partner's standing FLAT fee in cents, when that is the agreed term (feePct is then null). */
  feeFlatCents?: number | null
  /** WAVE 144: who is paid — an inside agent, or an outside partner's brokerage. */
  payee?: ReferralPayee | null
  /** True when the referral was already linked to THIS deal (a re-run) — nothing to link. */
  alreadyLinked: boolean
  /** WAVE 144: a referral the deal owes but cannot lawfully / clearly pay yet — a FINAL calculation refuses by name. */
  hold?: string | null
  findings: string[]
}

/** PURE — a positive flat fee in cents from a numeric column, or null (never fabricated). */
function agreedFlatCents(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null
}

/**
 * PURE — may this outside partner be paid a referral fee on a deal dated `asOf`, and on what terms?
 * Refusals are SKIPS with a finding (the partner keeps the thank-you / lifetime-value loop); a missing brokerage of record is
 * a HOLD (the fee is owed, the payee is not yet authorizable). Module-private: reached through pickReferralForDeal.
 */
function partnerReferralTerms(
  referral: ReferralCandidate,
  partner: PartnerCandidate | null | undefined,
  asOf: string,
): { ok: true; feePct: number | null; feeFlatCents: number | null; payee: ReferralPayee; basis: string } | { ok: false; skip: string } | { ok: false; hold: string } {
  if (!partner) return { ok: false, skip: `referral ${referral.id}: its partner (${referral.partner_id}) is not a partner of record in this brokerage — no fee` }
  if (partner.active === false) return { ok: false, skip: `referral ${referral.id}: partner ${partner.id} is inactive — no fee` }
  if (partner.partner_type !== "real_estate_agent") {
    return { ok: false, skip: `referral ${referral.id}: partner ${partner.id} is a ${partner.partner_type ?? "partner of unknown type"} — a referral fee is paid only to a real-estate agent / brokerage (RESPA §8 forbids paying for settlement-service referrals); no fee` }
  }
  const end = typeof partner.agreement_end_date === "string" ? partner.agreement_end_date.slice(0, 10) : null
  if (end && end < asOf) return { ok: false, skip: `referral ${referral.id}: partner ${partner.id}'s referral agreement ended ${end}, before the deal's date ${asOf} — no fee` }
  const pct = agreedReferralPct(referral.referral_fee_pct) ?? agreedReferralPct(partner.commission_split_percentage)
  const flat = pct === null ? agreedFlatCents(partner.referral_fee_flat) : null
  if (pct === null && flat === null) {
    return { ok: false, skip: `referral ${referral.id}: no agreed fee (the referral's percent, the partner's percent or flat fee) is recorded for partner ${partner.id} — no fee booked (never fabricated)` }
  }
  const brokerageName = String(partner.company_name ?? "").trim()
  if (!brokerageName) {
    return { ok: false, hold: `referral ${referral.id}: a fee is owed to outside partner ${partner.partner_name ?? partner.id}, but no brokerage of record is on the partner — the fee is payable broker-to-broker; record the partner's brokerage, then recalculate` }
  }
  const basis = agreedReferralPct(referral.referral_fee_pct) !== null ? "the referral's agreed percent" : pct !== null ? "the partner's standing percent" : "the partner's standing flat fee"
  return { ok: true, feePct: pct, feeFlatCents: flat, payee: { kind: "partner", partnerId: partner.id, brokerageName, agentName: partner.partner_name ?? null }, basis }
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
  ctx: {
    transactionId: string
    producingAgentId: string
    /** WAVE 144: the deal's date (partner agreement windows are judged on it). Defaults to today. */
    asOf?: string
    /** WAVE 144: the referral_partners rows behind partner referrals (tenant-pinned by the caller). */
    partners?: ReadonlyMap<string, PartnerCandidate>
  },
): ReferralPick {
  const findings: string[] = []
  const none = (): ReferralPick => ({ referral: null, feePct: null, feeFlatCents: null, payee: null, alreadyLinked: false, hold: null, findings })
  // ONE referral pays on ONE deal, inside or outside (no double payment): both kinds compete for the same slot.
  const payable = rows.filter((r) => !!r.referring_agent_id || !!r.partner_id)
  const linked = payable
    .filter((r) => r.transaction_id === ctx.transactionId)
    .sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")))
  const unlinked = payable
    .filter((r) => (r.transaction_id ?? null) === null && (r.status ?? "") !== "lost")
    .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))
  if (linked.length > 1) findings.push(`${linked.length} referrals are linked to this deal — the oldest (${linked[0].id}) applies; a finance admin should review the others`)
  const chosen = linked[0] ?? unlinked[0]
  if (!chosen) return none()
  const alreadyLinked = linked.length > 0
  if (chosen.agent_id && chosen.agent_id !== ctx.producingAgentId) {
    findings.push(`referral ${chosen.id}: assigned to a different receiving agent (${chosen.agent_id}) than the one closing (${ctx.producingAgentId}) — no fee booked until a human reassigns it`)
    return none()
  }

  // INSIDE: an agent of this brokerage referred it.
  if (chosen.referring_agent_id) {
    if (chosen.referring_agent_id === ctx.producingAgentId) {
      findings.push(`referral ${chosen.id}: the referring agent is the producing agent — no fee`)
      return none()
    }
    const pct = agreedReferralPct(chosen.referral_fee_pct)
    if (pct === null) {
      findings.push(`referral ${chosen.id}: no agreed fee percent (0–100) is recorded — no fee booked (never fabricated)`)
      return none()
    }
    const asOf = ctx.asOf ?? new Date().toISOString().slice(0, 10)
    const paper = referralAgreementOnRecord(chosen, null, asOf)
    if (!paper.ok) {
      const hold = `referral ${chosen.id}: a ${pct}% fee is owed to the referring agent, but ${paper.why} — record the executed referral agreement, then recalculate (owner ruling 9)`
      findings.push(hold)
      return { ...none(), referral: chosen, alreadyLinked, hold }
    }
    findings.push(`referral ${chosen.id}: paid on ${paper.basis}`)
    return { referral: chosen, feePct: pct, feeFlatCents: null, payee: { kind: "agent", agentId: chosen.referring_agent_id }, alreadyLinked, hold: null, findings }
  }

  // OUTSIDE: a partner of record referred it (see the header for the payee rule).
  const partnerAsOf = ctx.asOf ?? new Date().toISOString().slice(0, 10)
  const partner = ctx.partners?.get(String(chosen.partner_id))
  const terms = partnerReferralTerms(chosen, partner, partnerAsOf)
  if (!terms.ok) {
    if ("hold" in terms) {
      findings.push(terms.hold)
      return { ...none(), referral: chosen, alreadyLinked, hold: terms.hold }
    }
    findings.push(terms.skip)
    return none()
  }
  const paper = referralAgreementOnRecord(chosen, partner, partnerAsOf)
  if (!paper.ok) {
    const hold = `referral ${chosen.id}: a fee is owed to outside partner ${partner?.partner_name ?? chosen.partner_id}, but ${paper.why} — record the executed referral agreement, then recalculate (owner ruling 9)`
    findings.push(hold)
    return { ...none(), referral: chosen, alreadyLinked, hold }
  }
  return { referral: chosen, feePct: terms.feePct, feeFlatCents: terms.feeFlatCents, payee: terms.payee, alreadyLinked, hold: null, findings: [...findings, `referral ${chosen.id}: outside partner fee on ${terms.basis}, paid on ${paper.basis}`] }
}

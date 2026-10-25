// lib/transactions/cda-payees.ts — WHO ELSE THE CDA MUST TELL TITLE TO PAY (wave 143, lane 143C).
//
// PURE. Owner (2026-10-23): "CDA payouts include referrals. All financials must be accurate for brokerage, agents and teams."
// The disbursement authorization sendCdaToTitleAction emails to title used to state gross / agent net / brokerage net
// and nothing else: a referral fee the deal funds, or a team share, was a payee title was never told about. Rows are the
// LIVE commission_distributions of the deal (a voided row carries no money; a correction is a signed row, so the sum
// of the live rows is the corrected figure), summed per payee by the live distribution_type vocabulary
// (referral | team_member — see scripts/check-vocabularies.ts commission_distributions).
//
// WAVE 144 (lane 144D, owner ruling 5): a referral to an OUTSIDE agent is payable to the partner's brokerage of record
// (commission_distributions.referral_partner_id → referral_partners, m850) — the payee line names that brokerage and the
// agent beside it, keyed apart from inside agents so a partner and an agent can never be summed into one payee.

export interface CdaPayeeRow {
  distribution_type?: string | null
  calculated_amount?: number | string | null
  status?: string | null
  agent_id?: string | null
  /** WAVE 144: the outside referral payee (m850). Absent before m850 is applied. */
  referral_partner_id?: string | null
}

export interface CdaPayees {
  referralPayouts: Array<{ payee: string; amount: number }>
  teamShare: number | null
}

const cents = (v: number | string | null | undefined): number => {
  const n = typeof v === "string" ? Number(v) : (v ?? 0)
  return Number.isFinite(n) ? Math.round((n as number) * 100) : 0
}

/** PURE — the payees beyond agent / brokerage the authorization must name. Positive amounts only (a netted-to-zero payee is not a payee). */
export function cdaPayeesFromDistributions(
  rows: ReadonlyArray<CdaPayeeRow>,
  nameByAgentId: ReadonlyMap<string, string>,
  /** WAVE 144: referral_partners.id → "Brokerage (Agent)" as the authorization names it. */
  nameByPartnerId: ReadonlyMap<string, string> = new Map(),
): CdaPayees {
  const referral = new Map<string, number>()
  let team = 0
  for (const r of rows) {
    if ((r.status ?? "").toLowerCase() === "voided") continue
    const t = (r.distribution_type ?? "").toLowerCase()
    if (t === "referral") {
      const key = r.referral_partner_id ? `partner:${r.referral_partner_id}` : `agent:${r.agent_id ?? "unknown"}`
      referral.set(key, (referral.get(key) ?? 0) + cents(r.calculated_amount))
    } else if (t === "team_member") team += cents(r.calculated_amount)
  }
  return {
    referralPayouts: Array.from(referral.entries())
      .filter(([, c]) => c > 0)
      .map(([key, c]) => {
        const [kind, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)]
        const payee = kind === "partner"
          ? nameByPartnerId.get(id) ?? "the referring partner brokerage"
          : nameByAgentId.get(id) ?? "the referring agent"
        return { payee, amount: c / 100 }
      }),
    teamShare: team > 0 ? team / 100 : null,
  }
}

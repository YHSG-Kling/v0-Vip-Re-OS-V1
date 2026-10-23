// lib/transactions/cda-payees.ts — WHO ELSE THE CDA MUST TELL TITLE TO PAY (wave 143, lane 143C).
//
// PURE. Owner (2026-10-23): "CDA payouts include referrals. All financials must be accurate for brokerage, agents and teams."
// The disbursement authorization sendCdaToTitleAction emails to title used to state gross / agent net / brokerage net
// and nothing else: a referral fee the deal funds, or a team share, was a payee title was never told about. Rows are the
// LIVE commission_distributions of the deal (a voided row carries no money; a correction is a signed row, so the sum
// of the live rows is the corrected figure), summed per payee by the live distribution_type vocabulary
// (referral | team_member — see scripts/check-vocabularies.ts commission_distributions).

export interface CdaPayeeRow {
  distribution_type?: string | null
  calculated_amount?: number | string | null
  status?: string | null
  agent_id?: string | null
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
export function cdaPayeesFromDistributions(rows: ReadonlyArray<CdaPayeeRow>, nameByAgentId: ReadonlyMap<string, string>): CdaPayees {
  const referral = new Map<string, number>()
  let team = 0
  for (const r of rows) {
    if ((r.status ?? "").toLowerCase() === "voided") continue
    const t = (r.distribution_type ?? "").toLowerCase()
    if (t === "referral") referral.set(r.agent_id ?? "unknown", (referral.get(r.agent_id ?? "unknown") ?? 0) + cents(r.calculated_amount))
    else if (t === "team_member") team += cents(r.calculated_amount)
  }
  return {
    referralPayouts: Array.from(referral.entries())
      .filter(([, c]) => c > 0)
      .map(([agentId, c]) => ({ payee: nameByAgentId.get(agentId) ?? "the referring agent", amount: c / 100 })),
    teamShare: team > 0 ? team / 100 : null,
  }
}

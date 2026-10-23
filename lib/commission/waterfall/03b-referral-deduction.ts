import { createServiceClient } from '@/lib/supabase/service'
import { pickReferralForDeal, referralFeeCents, type ReferralCandidate } from '../referral-payout'
import type { WaterfallContext, DistributionRecord } from '../types'

type Svc = ReturnType<typeof createServiceClient>

/** A column / table this migration (m812) adds that is not applied yet — the one refusal that degrades, SAID. */
function missingColumn(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false
  const m = String(error.message ?? '').toLowerCase()
  return error.code === '42703' || error.code === 'PGRST204' || m.includes('does not exist') || m.includes('schema cache')
}

const REFERRAL_COLUMNS = 'id, agent_id, referring_agent_id, referral_fee_pct, status, created_at'

async function readReferrals(
  supabase: Svc,
  context: WaterfallContext,
  contactIds: string[],
): Promise<{ rows: ReferralCandidate[]; linkAvailable: boolean }> {
  // Linked to THIS deal (a re-run), then unlinked for the deal's contacts. `transaction_id` is the m812 link.
  const linkedRes = await supabase
    .from('referrals')
    .select(`${REFERRAL_COLUMNS}, transaction_id`)
    .eq('brokerage_id', context.brokerageId)
    .eq('transaction_id', context.transactionId)
  if (linkedRes.error && !missingColumn(linkedRes.error)) {
    throw new Error(`[referral-deduction] linked referral read refused: ${linkedRes.error.message}`)
  }
  const linkAvailable = !linkedRes.error
  const rows = new Map<string, ReferralCandidate>()
  for (const r of (linkedRes.data ?? []) as ReferralCandidate[]) rows.set(r.id, r)

  if (contactIds.length > 0) {
    const open = linkAvailable
      ? await supabase.from('referrals').select(`${REFERRAL_COLUMNS}, transaction_id`)
          .eq('brokerage_id', context.brokerageId).in('referred_contact_id', contactIds).is('transaction_id', null)
      : await supabase.from('referrals').select(REFERRAL_COLUMNS)
          .eq('brokerage_id', context.brokerageId).in('referred_contact_id', contactIds)
    // A refused read is not "no referral": an unprovable absence must not silently skip a payout the deal owes.
    if (open.error) throw new Error(`[referral-deduction] referral read refused: ${open.error.message}`)
    for (const r of (open.data ?? []) as ReferralCandidate[]) if (!rows.has(r.id)) rows.set(r.id, r)
  }
  return { rows: Array.from(rows.values()), linkAvailable }
}

/**
 * STEP 3b: Referral deduction (wave 143, lane 143C).
 *
 * The owner's waterfall order: "gross, REFERRAL DEDUCTIONS, brokerage split, …". An agent-to-agent referral's agreed
 * fee percent (referrals.referral_fee_pct) comes off the top of the ADJUSTED GROSS before step 04 splits what is left.
 * The fee is a CONSERVED distribution — it rides step 11's identity (gross == distributed + finals) — paid to the
 * referring agent, funded by the deal ('brokerage', the vocabulary step 03 uses for gross-level movements).
 *
 * It replaces the free-standing row lib/agents/referral-closer.ts used to book after the close (deducted from nobody).
 * Nothing in here invents a number: no agreed percent → a finding and no fee; an external partner → untouched.
 */
export async function applyReferralDeduction(
  context: WaterfallContext
): Promise<WaterfallContext> {
  const supabase = createServiceClient()

  const { data: txn, error: txnError } = await supabase
    .from('transactions')
    .select('contact_id, buyer_contact_id, seller_contact_id')
    .eq('id', context.transactionId)
    .eq('brokerage_id', context.brokerageId)
    .maybeSingle()
  if (txnError) throw new Error(`[referral-deduction] transaction contacts read refused: ${txnError.message}`)
  const t = (txn ?? {}) as { contact_id?: string | null; buyer_contact_id?: string | null; seller_contact_id?: string | null }
  const contactIds = Array.from(new Set([t.contact_id, t.buyer_contact_id, t.seller_contact_id].filter((x): x is string => !!x)))

  const { rows, linkAvailable } = await readReferrals(supabase, context, contactIds)
  const pick = pickReferralForDeal(rows, { transactionId: context.transactionId, producingAgentId: context.agentId })
  const findings = [...pick.findings]
  if (!linkAvailable) findings.push('referrals.transaction_id is unavailable (m812 not applied) — the referral cannot be linked to this deal until it is')
  for (const f of findings) console.warn(`[referral-deduction] ${context.transactionId}: ${f}`)

  if (!pick.referral || pick.feePct === null) {
    return { ...context, referralDistributions: [], referralDeductionCents: 0, referralLink: null, referralFindings: findings }
  }

  const feeCents = referralFeeCents(context.adjustedGrossCents, pick.feePct)
  if (feeCents <= 0) {
    findings.push(`referral ${pick.referral.id}: the fee on a ${context.adjustedGrossCents / 100} commission rounds to nothing — no fee booked`)
    return { ...context, referralDistributions: [], referralDeductionCents: 0, referralLink: null, referralFindings: findings }
  }
  if (feeCents > context.adjustedGrossCents) {
    throw new Error(`[commission-engine:referral] referral ${pick.referral.id} fee exceeds the commission it is taken from`)
  }

  const distribution: DistributionRecord = {
    distribution_type: 'referral',
    agent_id: pick.referral.referring_agent_id as string,
    calculation_type: 'percent',
    calculation_value: pick.feePct,
    calculated_amount: feeCents / 100,
    source_of_funds: 'brokerage',
    notes: `Agent referral fee ${pick.feePct}% of the adjusted gross, taken before the split (referral ${pick.referral.id})`,
  }
  return {
    ...context,
    referralDistributions: [distribution],
    referralDeductionCents: feeCents,
    referralLink: linkAvailable
      ? { referralId: pick.referral.id, referringAgentId: pick.referral.referring_agent_id as string, alreadyLinked: pick.alreadyLinked }
      : null,
    referralFindings: findings,
  }
}

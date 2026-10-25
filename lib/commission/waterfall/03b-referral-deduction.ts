import { createServiceClient } from '@/lib/supabase/service'
import { pickReferralForDeal, referralFeeCents, type ReferralCandidate, type PartnerCandidate } from '../referral-payout'
import type { WaterfallContext, DistributionRecord } from '../types'

type Svc = ReturnType<typeof createServiceClient>

/** A column / table this migration (m812) adds that is not applied yet — the one refusal that degrades, SAID. */
function missingColumn(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false
  const m = String(error.message ?? '').toLowerCase()
  return error.code === '42703' || error.code === 'PGRST204' || m.includes('does not exist') || m.includes('schema cache')
}

const REFERRAL_COLUMNS = 'id, agent_id, referring_agent_id, partner_id, referral_fee_pct, status, created_at'

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

/** WAVE 144 (lane 144D): the partners of record behind partner referrals — TENANT-PINNED; a refusal throws (never "no partner"). */
async function readPartners(supabase: Svc, context: WaterfallContext, rows: ReferralCandidate[]): Promise<Map<string, PartnerCandidate>> {
  const ids = Array.from(new Set(rows.map((r) => r.partner_id).filter((x): x is string => !!x)))
  const out = new Map<string, PartnerCandidate>()
  if (ids.length === 0) return out
  const { data, error } = await supabase
    .from('referral_partners')
    .select('id, partner_type, partner_name, company_name, active, agreement_end_date, commission_split_percentage, referral_fee_flat')
    .eq('brokerage_id', context.brokerageId)
    .in('id', ids)
  if (error) throw new Error(`[referral-deduction] referral partner read refused: ${error.message}`)
  for (const p of (data ?? []) as PartnerCandidate[]) out.set(p.id, p)
  return out
}

/**
 * STEP 3b: Referral deduction (wave 143, lane 143C; outside partners wave 144, lane 144D).
 *
 * The owner's waterfall order: "gross, REFERRAL DEDUCTIONS, brokerage split, …". A referral's agreed fee comes off the top
 * of the ADJUSTED GROSS before step 04 splits what is left. The fee is a CONSERVED distribution — it rides step 11's identity
 * (gross == distributed + finals) — funded by the deal ('brokerage', the vocabulary step 03 uses for gross-level movements).
 *   · INSIDE (referring_agent_id): paid to the referring agent, on the referral's agreed percent.
 *   · OUTSIDE (partner_id, owner ruling 5): paid to the partner's brokerage of record (commission_distributions
 *     .referral_partner_id, m850 — never an agents row), on the referral's percent, else the partner's standing percent,
 *     else its standing flat fee; only a real-estate-agent partner is ever paid (lib/commission/referral-payout.ts).
 * ONE referral pays on ONE deal (referrals.transaction_id, compare-and-swap at stage 11), inside or outside — no double payment.
 * A partner fee that is owed but not yet authorizable (no brokerage of record) HOLDS a FINAL calculation by name.
 *
 * It replaces the free-standing row lib/agents/referral-closer.ts used to book after the close (deducted from nobody).
 * Nothing in here invents a number: no agreed fee → a finding and no fee.
 */
export async function applyReferralDeduction(
  context: WaterfallContext,
  mode: 'preview' | 'final' = 'final',
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
  const partners = await readPartners(supabase, context, rows)
  const pick = pickReferralForDeal(rows, {
    transactionId: context.transactionId,
    producingAgentId: context.agentId,
    asOf: context.agreement?.asOf,
    partners,
  })
  const findings = [...pick.findings]
  if (!linkAvailable) findings.push('referrals.transaction_id is unavailable (m812 not applied) — the referral cannot be linked to this deal until it is')
  for (const f of findings) console.warn(`[referral-deduction] ${context.transactionId}: ${f}`)

  if (pick.hold) {
    if (mode === 'final') throw new Error(`[commission-engine:referral] ${pick.hold}`)
    return { ...context, referralDistributions: [], referralDeductionCents: 0, referralLink: null, referralFindings: findings }
  }

  const payee = pick.payee ?? null
  if (!pick.referral || !payee || (pick.feePct === null && !pick.feeFlatCents)) {
    return { ...context, referralDistributions: [], referralDeductionCents: 0, referralLink: null, referralFindings: findings }
  }

  const feeCents = pick.feePct !== null ? referralFeeCents(context.adjustedGrossCents, pick.feePct) : (pick.feeFlatCents ?? 0)
  if (feeCents <= 0) {
    findings.push(`referral ${pick.referral.id}: the fee on a ${context.adjustedGrossCents / 100} commission rounds to nothing — no fee booked`)
    return { ...context, referralDistributions: [], referralDeductionCents: 0, referralLink: null, referralFindings: findings }
  }
  if (feeCents > context.adjustedGrossCents) {
    throw new Error(`[commission-engine:referral] referral ${pick.referral.id} fee exceeds the commission it is taken from`)
  }

  const terms = pick.feePct !== null ? `${pick.feePct}% of the adjusted gross` : `$${(feeCents / 100).toFixed(2)} flat`
  const distribution: DistributionRecord = payee.kind === 'agent'
    ? {
        distribution_type: 'referral',
        // The INSIDE payee is the referring agent (pickReferralForDeal sets payee.agentId to the same id).
        agent_id: pick.referral.referring_agent_id as string,
        calculation_type: 'percent',
        calculation_value: pick.feePct ?? undefined,
        calculated_amount: feeCents / 100,
        source_of_funds: 'brokerage',
        notes: `Agent referral fee ${terms}, taken before the split (referral ${pick.referral.id})`,
      }
    : {
        distribution_type: 'referral',
        referral_partner_id: payee.partnerId,
        calculation_type: pick.feePct !== null ? 'percent' : 'flat',
        calculation_value: pick.feePct ?? feeCents / 100,
        calculated_amount: feeCents / 100,
        source_of_funds: 'brokerage',
        recipient_type: 'referral_partner',
        notes: `Outside referral fee ${terms}, payable to ${payee.brokerageName}${payee.agentName ? ` (${payee.agentName})` : ''}, taken before the split (referral ${pick.referral.id})`,
      }
  return {
    ...context,
    referralDistributions: [distribution],
    referralDeductionCents: feeCents,
    referralLink: linkAvailable
      ? {
          referralId: pick.referral.id,
          referringAgentId: payee.kind === 'agent' ? payee.agentId : null,
          partnerId: payee.kind === 'partner' ? payee.partnerId : null,
          alreadyLinked: pick.alreadyLinked,
        }
      : null,
    referralFindings: findings,
  }
}

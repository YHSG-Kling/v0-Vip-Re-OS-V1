import { createServiceClient } from '@/lib/supabase/service'
import { resolveCapCycleForDeal, planSplitAgainstCap } from '../cap-resolver'
import type { WaterfallContext } from '../types'

/**
 * STEP 7: Apply Cap (NO DB UPDATES — stage 11 is the only writer)
 * Cap tracks brokerage's cumulative earnings, NOT agent's
 * When capped, brokerage gets $0 and agent gets full brokerage portion as bonus
 *
 * WAVE 144 (lane 144D, owner ruling 9) — THE CYCLE IS THE DEAL'S, NOT TODAY'S. The window used to be the ledger row
 * containing TODAY: a deal that closed before the agent's anniversary and was calculated after it was charged against the
 * new cycle, and once a window expired nothing opened the next one, so a capped agent was silently never capped again.
 * lib/commission/cap-resolver.ts resolveCapCycleForDeal now resolves the cycle containing the DEAL's date (stage 01's
 * agreement as-of date), with the cap amount, anniversary and cap-eligible contributions of the agreement IN FORCE that
 * day; a cycle with no ledger row is a new cycle at $0 that stage 11 opens. planSplitAgainstCap holds the branch order this
 * stage always had (post_cap / pre_cap / hit_cap — a deal crossing the cap mid-transaction pays the brokerage only the
 * remainder). The cap room the split leaves rides context.capCycle so stage 10 can spend it on cap-eligible fees.
 *
 * FAIL CLOSED: the previous read ignored `error`, so a refused ledger read priced the deal as UNCAPPED — the brokerage
 * collecting its full split from an agent who had already capped. A refusal now throws.
 */
export async function applyCap(
  context: WaterfallContext
): Promise<WaterfallContext> {
  const supabase = createServiceClient()
  const asOf = context.agreement?.asOf ?? new Date().toISOString().slice(0, 10)

  const resolution = await resolveCapCycleForDeal(supabase as never, {
    agentId: context.agentId,
    brokerageId: context.brokerageId,
    asOf,
    terms: context.agreement?.terms ?? null,
  })
  if (!resolution.ok) {
    throw new Error(`[commission-engine:cap] ${resolution.error}`)
  }
  for (const f of resolution.findings) console.warn(`[commission-engine:cap] ${context.transactionId}: ${f}`)

  const cycle = resolution.cycle
  const plan = planSplitAgainstCap({ brokeragePortionCents: context.brokeragePortionCents, cycle })

  return {
    ...context,
    agentNetCents: context.agentPortionCents + plan.agentBonusCents,
    brokerageFinalCents: plan.brokerageFinalCents,
    capApplied: plan.capApplied,
    capStatus: plan.capStatus,
    amountTowardsCap: plan.amountTowardsCap,
    capCycle: cycle
      ? {
          trackingId: cycle.trackingId,
          start: cycle.start,
          end: cycle.end,
          capAmountCents: cycle.capAmountCents,
          paidToDateCents: cycle.paidToDateCents,
          paidToDateRaw: cycle.paidToDateRaw,
          capSource: cycle.capSource,
          eligible: [...cycle.eligible],
          asOf: cycle.asOf,
          agreementAnniversaryDate: cycle.agreementAnniversaryDate,
          findings: [...cycle.findings],
          remainingAfterSplitCents: plan.remainingAfterSplitCents,
          contributedByType: plan.amountTowardsCap > 0 ? { brokerage_split: plan.amountTowardsCap } : {},
        }
      : null,
  }
}

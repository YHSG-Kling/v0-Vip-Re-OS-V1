import { createServiceClient } from '@/lib/supabase/service'
import { dollarsToCents } from '../utils'
import type { WaterfallContext } from '../types'

/**
 * STEP 7: Apply Cap (PURE FUNCTION - NO DB UPDATES)
 * Cap tracks brokerage's cumulative earnings, NOT agent's
 * When capped, brokerage gets $0 and agent gets full brokerage portion as bonus
 * NO DATABASE UPDATES - only computation
 */
export async function applyCap(
  context: WaterfallContext
): Promise<WaterfallContext> {
  const supabase = createServiceClient()

  // Get cap tracking record
  // agent_cap_tracking has no is_active — the active row is the one whose anniversary
  // window contains today.
  const nowDate = new Date().toISOString().slice(0, 10)
  const { data: capTracking } = await supabase
    .from('agent_cap_tracking')
    .select('*')
    .eq('agent_id', context.agentId)
    .eq('brokerage_id', context.brokerageId)
    .lte('anniversary_start', nowDate)
    .gte('anniversary_end', nowDate)
    .maybeSingle()

  // No cap configured
  if (!capTracking) {
    return {
      ...context,
      agentNetCents: context.agentPortionCents,
      brokerageFinalCents: context.brokeragePortionCents,
      capApplied: false,
      capStatus: 'n/a',
      amountTowardsCap: 0
    }
  }

  const capAmountCents = dollarsToCents(capTracking.cap_amount)
  const paidToDateCents = dollarsToCents(capTracking.cap_paid_to_date)
  const remainingCapCents = capAmountCents - paidToDateCents

  let brokerageFinalCents: number
  let agentBonusCents: number
  let capApplied: boolean
  let capStatus: 'pre_cap' | 'hit_cap' | 'post_cap'
  let amountTowardsCap: number

  if (remainingCapCents <= 0) {
    // Already capped — brokerage gets $0, agent gets full brokerage portion
    brokerageFinalCents = 0
    agentBonusCents = context.brokeragePortionCents
    capApplied = true
    capStatus = 'post_cap'
    amountTowardsCap = 0
  } else if (context.brokeragePortionCents <= remainingCapCents) {
    // Still under cap — brokerage keeps their portion
    brokerageFinalCents = context.brokeragePortionCents
    agentBonusCents = 0
    capApplied = false
    capStatus = 'pre_cap'
    amountTowardsCap = context.brokeragePortionCents
  } else {
    // This deal hits cap boundary
    brokerageFinalCents = remainingCapCents
    agentBonusCents = context.brokeragePortionCents - remainingCapCents
    capApplied = true
    capStatus = 'hit_cap'
    amountTowardsCap = remainingCapCents
  }

  const agentNetCents = context.agentPortionCents + agentBonusCents

  return {
    ...context,
    agentNetCents,
    brokerageFinalCents,
    capApplied,
    capStatus,
    amountTowardsCap
  }
}

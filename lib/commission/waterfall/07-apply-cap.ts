import { createServiceClient } from '@/lib/supabase/service'
import { dollarsToCents, centsToDollars } from '../utils'
import type { WaterfallContext } from '../types'

/**
 * STEP 7: Apply Cap (CORRECTED - Brokerage-Side Cap)
 * Cap tracks brokerage's cumulative earnings, NOT agent's
 * When capped, brokerage gets $0 and agent gets full brokerage portion as bonus
 */
export async function applyCap(
  agentId: string,
  brokerageId: string,
  agentPortionCents: number,
  brokeragePortionCents: number
): Promise<Pick<WaterfallContext, 'agentNetCents' | 'brokerageFinalCents' | 'agentBonusCents' | 'capApplied' | 'capStatus' | 'amountTowardsCap'>> {
  const supabase = createServiceClient()

  // Get cap tracking record
  const { data: capTracking } = await supabase
    .from('agent_cap_tracking')
    .select('*')
    .eq('agent_id', agentId)
    .eq('brokerage_id', brokerageId)
    .eq('is_active', true)
    .maybeSingle()

  // No cap configured - agent gets their portion, brokerage gets theirs
  if (!capTracking) {
    return {
      agentNetCents: agentPortionCents,
      brokerageFinalCents: brokeragePortionCents,
      agentBonusCents: 0,
      capApplied: false,
      capStatus: 'pre_cap',
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
    agentBonusCents = brokeragePortionCents
    capApplied = true
    capStatus = 'post_cap'
    amountTowardsCap = 0
  } else if (brokeragePortionCents <= remainingCapCents) {
    // Still under cap — brokerage keeps their portion
    brokerageFinalCents = brokeragePortionCents
    agentBonusCents = 0
    capApplied = false
    capStatus = 'pre_cap'
    amountTowardsCap = brokeragePortionCents
  } else {
    // This deal hits cap boundary
    brokerageFinalCents = remainingCapCents
    agentBonusCents = brokeragePortionCents - remainingCapCents
    capApplied = true
    capStatus = 'hit_cap'
    amountTowardsCap = remainingCapCents
  }

  // Update cap tracking (will be persisted in step 11)
  const newPaidToDate = centsToDollars(paidToDateCents + amountTowardsCap)
  const isCapped = newPaidToDate >= capTracking.cap_amount

  await supabase
    .from('agent_cap_tracking')
    .update({
      cap_paid_to_date: newPaidToDate,
      is_capped: isCapped,
      updated_at: new Date().toISOString()
    })
    .eq('id', capTracking.id)

  const agentNetCents = agentPortionCents + agentBonusCents

  return {
    agentNetCents,
    brokerageFinalCents,
    agentBonusCents,
    capApplied,
    capStatus,
    amountTowardsCap
  }
}

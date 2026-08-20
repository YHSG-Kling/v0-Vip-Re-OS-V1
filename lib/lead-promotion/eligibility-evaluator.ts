'use server'

import { getAgentContext } from '@/lib/identity'
import { createServiceClient } from '@/lib/supabase/service'
import { evaluatePromotionEligibilityCore } from './eligibility-core'

/**
 * PUBLIC DOOR — gated. See eligibility-core.ts for why this split exists.
 *
 * Gate first, then the service client — the pattern named at
 * lib/kernel/manager-registry.ts. The tenant comes from the SESSION and is
 * compared against the record's own brokerage_id; it is never accepted from
 * the caller. FAILS CLOSED: no session, or a record belonging to another
 * brokerage, is refused with the SAME message as a missing record, so this
 * cannot be used to probe which ids exist.
 */
export async function evaluatePromotionEligibility(rawRecordId: string) {
  const REFUSAL = { eligible: false as const, reason: 'Raw record not found' }

  let brokerageId: string | null | undefined
  try {
    ({ brokerageId } = await getAgentContext())
  } catch {
    return REFUSAL
  }
  if (!brokerageId) return REFUSAL

  const { data, error } = await createServiceClient()
    .from('raw_scraped_leads')
    .select('brokerage_id')
    .eq('id', rawRecordId)
    .maybeSingle()

  if (error || !data || data.brokerage_id !== brokerageId) return REFUSAL

  return evaluatePromotionEligibilityCore(rawRecordId)
}

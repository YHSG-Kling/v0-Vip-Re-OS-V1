import { getDefaultCommissionStructure } from '@/lib/brokerage/get-default-commission-structure'
import { createServiceClient } from '@/lib/supabase/service'
import type { WaterfallContext } from '../types'

/**
 * STEP 1: Resolve Gross Rate
 * Priority: deal override > agent profile > brokerage default
 */
export async function resolveRate(
  transactionId: string,
  brokerageId: string
): Promise<Pick<WaterfallContext, 'grossRateDecimal' | 'resolvedFrom' | 'agentSplitPercent' | 'agentId'>> {
  const supabase = createServiceClient()

  // Get transaction details
  const { data: transaction } = await supabase
    .from('transactions')
    .select('agent_id, commission_percentage')
    .eq('id', transactionId)
    .eq('brokerage_id', brokerageId)
    .maybeSingle()

  if (!transaction) {
    throw new Error(`[commission-engine] Transaction ${transactionId} not found in brokerage ${brokerageId}`)
  }

  const agentId = transaction.agent_id
  if (!agentId) {
    throw new Error(`[commission-engine] Transaction ${transactionId} has no agent_id`)
  }

  // Use getDefaultCommissionStructure with 3-tier resolution
  const structure = await getDefaultCommissionStructure(
    brokerageId,
    agentId,
    transaction.commission_percentage ?? undefined
  )

  return {
    grossRateDecimal: structure.resolvedGrossRateDecimal,
    resolvedFrom: structure.resolvedFrom,
    agentSplitPercent: structure.splitDecimal * 100,
    agentId
  }
}

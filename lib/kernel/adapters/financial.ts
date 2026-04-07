import { getDefaultCommissionStructure } from "@/lib/brokerage"

export interface CalculateCommissionInput {
  agentId: string
  transactionId: string
  grossCommission: number
  splitPercentage?: number
  brokerageId?: string
  brokerageFee?: number
  franchiseFee?: number
  additionalFees?: Array<{ name: string; amount: number }>
}

export interface ResolvedCommissionStructure {
  splitPercentage: number
  brokerageId?: string
}

export async function resolveCommissionStructure(
  params: CalculateCommissionInput
): Promise<ResolvedCommissionStructure> {
  if (typeof params.splitPercentage === "number") {
    return {
      splitPercentage: params.splitPercentage,
      brokerageId: params.brokerageId,
    }
  }

  if (!params.brokerageId) {
    throw new Error("[kernel/financial-adapter] brokerageId required to resolve commission structure")
  }

  const structure = await getDefaultCommissionStructure(params.brokerageId, params.agentId)

  return {
    splitPercentage: structure.splitDecimal * 100,
    brokerageId: params.brokerageId,
  }
}

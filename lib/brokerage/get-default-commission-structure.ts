import { createServiceClient } from "@/lib/supabase/service"

export interface CommissionStructureResolved {
  grossRateDecimal: number
  resolvedFrom: "deal_override" | "agent_profile" | "brokerage_default"
  resolvedGrossRateDecimal: number

  agentBuyerSideRate: number
  agentListingSideRate: number
  brokerageBuyerSideRate: number
  brokerageListingSideRate: number

  splitDecimal: number
  capAmount: number

  transactionFeeType: "flat" | "percent"
  transactionFeeValue: number

  deskFeeType: "flat" | "percent"
  deskFeeValue: number

  technologyFeeType: "flat" | "percent"
  technologyFeeValue: number

  eoFeeType: "flat" | "percent"
  eoFeeValue: number

  royaltyType: "flat" | "percent"
  royaltyValue: number

  referralType: "flat" | "percent"
  referralValue: number

  residualType: "flat" | "percent"
  residualValue: number
}

export async function getDefaultCommissionStructure(
  brokerageId: string,
  agentId?: string,
  dealCommissionRate?: number
): Promise<CommissionStructureResolved> {

  const supabase = createServiceClient()

  // 1️⃣ Get brokerage default gross commission structure
  const { data: structure, error: structureError } = await supabase
    .from("commission_structures")
    .select("*")
    .eq("brokerage_id", brokerageId)
    .eq("is_default", true)
    .eq("is_active", true)
    .maybeSingle()

  if (structureError || !structure) {
    throw new Error(
      `[commission-resolver] No default commission structure found for brokerage ${brokerageId}. ` +
      `Configure a default commission structure before running commission calculations.`
    )
  }

  // 2️⃣ Get agent commission profile (optional)
  let profile = null

  if (agentId) {
    const { data } = await supabase
      .from("agent_commission_profiles")
      .select("*")
      .eq("agent_id", agentId)
      .eq("brokerage_id", brokerageId)
      .eq("is_active", true)
      .maybeSingle()

    profile = data
  }

  // 3️⃣ Resolve gross rate with priority: deal > agent profile > brokerage default
  let resolvedGrossRateDecimal: number
  let resolvedFrom: "deal_override" | "agent_profile" | "brokerage_default"

  if (dealCommissionRate != null) {
    resolvedGrossRateDecimal = dealCommissionRate / 100
    resolvedFrom = "deal_override"
  } else if (profile?.split_percent != null) {
    resolvedGrossRateDecimal = profile.split_percent / 100
    resolvedFrom = "agent_profile"
  } else if (structure?.base_percentage != null) {
    resolvedGrossRateDecimal = structure.base_percentage / 100
    resolvedFrom = "brokerage_default"
  } else {
    throw new Error(
      `[commission-resolver] No commission rate configured for brokerage ${brokerageId}`
    )
  }

  const splitDecimal = profile ? Number(profile.split_percent) / 100 : 0

  const agentSide = resolvedGrossRateDecimal * splitDecimal
  const brokerageSide = resolvedGrossRateDecimal - agentSide

  return {
    grossRateDecimal: resolvedGrossRateDecimal,
    resolvedFrom,
    resolvedGrossRateDecimal,

    agentBuyerSideRate: agentSide,
    agentListingSideRate: agentSide,
    brokerageBuyerSideRate: brokerageSide,
    brokerageListingSideRate: brokerageSide,

    splitDecimal,
    capAmount: Number(profile.cap_amount ?? 0),

    transactionFeeType: profile.transaction_fee_type ?? "flat",
    transactionFeeValue: Number(profile.transaction_fee_value ?? profile.transaction_fee ?? 0),

    deskFeeType: profile.desk_fee_type ?? "flat",
    deskFeeValue: Number(profile.desk_fee_value ?? 0),

    technologyFeeType: profile.technology_fee_type ?? "flat",
    technologyFeeValue: Number(profile.technology_fee_value ?? 0),

    eoFeeType: profile.eo_fee_type ?? "flat",
    eoFeeValue: Number(profile.eo_fee_value ?? 0),

    royaltyType: profile.royalty_type ?? "flat",
    royaltyValue: Number(profile.royalty_value ?? 0),

    referralType: profile.referral_type ?? "percent",
    referralValue: Number(profile.referral_value ?? 0),

    residualType: profile.residual_type ?? "percent",
    residualValue: Number(profile.residual_value ?? 0),
  }
}

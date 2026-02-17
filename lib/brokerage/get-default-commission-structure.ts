import { createClient } from "@supabase/supabase-js"

export interface CommissionStructureResolved {
  grossRateDecimal: number

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
  agentId: string
): Promise<CommissionStructureResolved> {

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // 1️⃣ Get brokerage default gross commission structure
  const { data: structure, error: structureError } = await supabase
    .from("commission_structures")
    .select("*")
    .eq("brokerage_id", brokerageId)
    .eq("is_default", true)
    .eq("is_active", true)
    .single()

  if (structureError || !structure) {
    throw new Error("Default commission structure not found for brokerage")
  }

  const grossRateDecimal =
    structure.commission_type === "percentage"
      ? Number(structure.base_percentage) / 100
      : 0

  // 2️⃣ Get agent commission profile
  const { data: profile } = await supabase
    .from("agent_commission_profiles")
    .select("*")
    .eq("agent_id", agentId)
    .eq("brokerage_id", brokerageId)
    .eq("is_active", true)
    .single()

  if (!profile) {
    throw new Error("Agent commission profile not found")
  }

  const splitDecimal = Number(profile.split_percent) / 100

  const agentSide = grossRateDecimal * splitDecimal
  const brokerageSide = grossRateDecimal - agentSide

  return {
    grossRateDecimal,

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

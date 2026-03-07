import { createServiceClient } from "@/lib/supabase/service"

export interface CommissionAdjustment {
  id: string
  adjustment_type: string
  value_type: "percent" | "flat"
  value: number
  direction: "credit" | "surcharge"
  recipient_type: string
  recipient_name: string | null
  notes: string | null
  effective_date: string
}

export async function resolveCommissionAdjustments(
  brokerageId: string,
  transactionId: string
): Promise<CommissionAdjustment[]> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from("commission_adjustments")
    .select(`
      id,
      adjustment_type,
      value_type,
      value,
      direction,
      recipient_type,
      recipient_name,
      notes,
      effective_date
    `)
    .eq("brokerage_id", brokerageId)
    .eq("transaction_id", transactionId)
    .eq("is_active", true)
    .order("effective_date", { ascending: true })

  if (error) {
    throw new Error(
      `[resolve-adjustments] Failed to fetch adjustments: ${error.message}`
    )
  }

  return data ?? []
}

import { createServiceClient } from "@/lib/supabase/service"

/**
 * Get required primary state for brokerage
 * THROWS if not configured - no fallbacks allowed
 */
export async function getRequiredPrimaryState(brokerageId: string): Promise<string> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from("global_settings")
    .select("primary_state")
    .eq("brokerage_id", brokerageId)
    .single()

  if (error || !data?.primary_state) {
    throw new Error(`Brokerage ${brokerageId} must configure primary_state in global_settings`)
  }

  return data.primary_state
}

/**
 * Get primary state - returns null if not configured
 * Use this for optional contexts only
 */
export async function getPrimaryState(brokerageId: string): Promise<string | null> {
  const supabase = createServiceClient()

  const { data } = await supabase
    .from("global_settings")
    .select("primary_state")
    .eq("brokerage_id", brokerageId)
    .single()

  return data?.primary_state || null
}

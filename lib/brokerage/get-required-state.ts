import { createServiceClient } from "@/lib/supabase/service"

/**
 * Get required primary state for brokerage
 * THROWS if not configured - no fallbacks allowed
 */
export async function getRequiredPrimaryState(brokerageId: string): Promise<string> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from("brokerages")
    .select("state")
    .eq("id", brokerageId)
    .single()

  if (error || !data?.state) {
    throw new Error(`Brokerage ${brokerageId} must configure state`)
  }

  return data.state
}

/**
 * Get primary state - returns null if not configured
 * Use this for optional contexts only
 */
export async function getPrimaryState(brokerageId: string): Promise<string | null> {
  const supabase = createServiceClient()

  const { data } = await supabase
    .from("brokerages")
    .select("state")
    .eq("id", brokerageId)
    .single()

  return data?.state || null
}

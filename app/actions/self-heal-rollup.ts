"use server"

/**
 * app/actions/self-heal-rollup.ts — the tenant's "the OS repaired itself"
 * view. Broker-scoped read of the self-healing ledger (flow + connector heals).
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { loadSelfHealRollup, loadFlowActionStats, composeRepairAutonomy, type SelfHealRollup, type RepairAutonomyRow } from "@/lib/kernel/self-heal-ledger"

export async function getSelfHealRollup(): Promise<
  { success: true; rollup: SelfHealRollup } | { success: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }
  const { data: profile } = await supabase.from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
  if (!(profile as any)?.brokerage_id) return { success: false, error: "No brokerage on user" }

  // Include platform-scoped (null-brokerage) connector heals in the count by
  // reading both this brokerage's rows and the platform rows.
  const svc = createServiceClient()
  const rollup = await loadSelfHealRollup(svc, (profile as any).brokerage_id)
  return { success: true, rollup }
}

/** The confidence ratchet made visible: each auto-repair with its earned/supervised standing. */
export async function getRepairAutonomy(): Promise<
  { success: true; repairs: RepairAutonomyRow[] } | { success: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }
  const { data: profile } = await supabase.from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
  if (!(profile as any)?.brokerage_id) return { success: false, error: "No brokerage on user" }

  // Autonomy standing is a property of the CODE PATH (platform-wide evidence),
  // so any brokerage admin sees the same honest picture.
  const svc = createServiceClient()
  const stats = await loadFlowActionStats(svc)
  return { success: true, repairs: composeRepairAutonomy(stats) }
}

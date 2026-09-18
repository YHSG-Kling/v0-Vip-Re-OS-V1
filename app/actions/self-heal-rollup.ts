"use server"

/**
 * app/actions/self-heal-rollup.ts — the tenant's "the OS repaired itself"
 * view. Broker-scoped read of the self-healing ledger (flow + connector heals).
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { loadSelfHealRollup, loadFlowActionStats, composeRepairAutonomy, type SelfHealRollup, type RepairAutonomyRow } from "@/lib/kernel/self-heal-ledger"

// PRINCIPAL seats only (owner: not every subscription is a brokerage): the
// broker on brokerage tiers, the solo agent on a solo tier, the team lead on
// a team tier. Overseen seats (team members, brokerage staff agents) don't
// carry the OS-maintenance surfaces — their principal does.
// SCOPE LADDER (kept inline): 'superadmin' removed — dead as users.user_type
// (0 live rows); broker_owner added — storable seat that OWNS the subscription.
const PRINCIPAL_TYPES = new Set(["broker", "broker_owner", "broker_admin", "admin", "solo_agent", "team_lead"])

export async function getSelfHealRollup(): Promise<
  { success: true; rollup: SelfHealRollup } | { success: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }
  const { data: profile } = await supabase.from("users").select("brokerage_id, user_type").eq("id", user.id).maybeSingle()
  if (!(profile as any)?.brokerage_id) return { success: false, error: "No brokerage on user" }
  if (!PRINCIPAL_TYPES.has(String((profile as any).user_type ?? ""))) return { success: false, error: "Principal access required" }

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
  const { data: profile } = await supabase.from("users").select("brokerage_id, user_type").eq("id", user.id).maybeSingle()
  if (!(profile as any)?.brokerage_id) return { success: false, error: "No brokerage on user" }
  if (!PRINCIPAL_TYPES.has(String((profile as any).user_type ?? ""))) return { success: false, error: "Principal access required" }

  // Autonomy standing is a property of the CODE PATH (platform-wide evidence),
  // so any brokerage admin sees the same honest picture.
  const svc = createServiceClient()
  const stats = await loadFlowActionStats(svc)
  return { success: true, repairs: composeRepairAutonomy(stats) }
}

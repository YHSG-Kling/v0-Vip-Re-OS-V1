"use server"

/**
 * app/actions/autonomy-halt.ts — tenant-side read of the per-tenant staff
 * autonomy halt (round-31 lever). The banner previously rendered ONLY inside
 * the Command Center page; this action lets the landing dashboards (broker,
 * agent/solo, team lead) show the honest "your AI is paused" notice wherever
 * the principal actually lands.
 *
 * Read-only. Any signed-in member of the tenancy may see the halt state —
 * a halted AI team is not a secret from the staff it stops working for —
 * but the reason string is staff-authored and already written to be shown
 * to the tenant verbatim (see AutonomyHaltBanner).
 */

import { createClient } from "@/lib/supabase/server"
import { loadTenantAutonomyHalt, type TenantAutonomyHalt } from "@/lib/managers/autonomy-gate"

const NOT_HALTED: TenantAutonomyHalt = { halted: false, reason: null, haltedAt: null }

export async function getTenantAutonomyHaltAction(): Promise<TenantAutonomyHalt> {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NOT_HALTED
    const { data: profile } = await supabase
      .from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
    const brokerageId = (profile as { brokerage_id?: string | null } | null)?.brokerage_id
    if (!brokerageId) return NOT_HALTED
    return await loadTenantAutonomyHalt(brokerageId)
  } catch {
    // Fail open — the banner is informational; never break a dashboard over it.
    return NOT_HALTED
  }
}

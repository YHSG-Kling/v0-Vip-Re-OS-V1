"use server"

/**
 * app/actions/approval-sla.ts — the broker Exception Center's approval-queue SLA
 * telemetry read (round 34, owner-approved recommendation).
 *
 * Read-only: the canonical aggregator's pending rows folded into per-kind aging by
 * lib/kernel/approval-sla.ts (computeApprovalSla). Principal-gated with the same
 * seat set the Exception Center itself uses — whoever OWNS the subscription's
 * operations sees the queue's health, brokerage-wide (the aging question is an
 * operations question, not a per-agent one).
 */

import { createClient } from "@/lib/supabase/server"
import { loadApprovalSla, type ApprovalKindSla } from "@/lib/kernel/approval-sla"

// Mirrors app/actions/exception-center.ts PRINCIPAL_TYPES — the operations owners.
// SCOPE LADDER (kept inline): 'superadmin' removed — dead as users.user_type
// (0 live rows); broker_owner added — storable seat that OWNS the subscription.
const PRINCIPAL_TYPES = new Set(["broker", "broker_owner", "broker_admin", "admin", "solo_agent", "team_lead"])

export async function getApprovalSlaTelemetry(): Promise<
  { success: true; rows: ApprovalKindSla[] } | { success: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthenticated" }
  const { data: profile } = await supabase
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()
  const brokerageId = (profile as { brokerage_id?: string | null } | null)?.brokerage_id ?? null
  const userType = String((profile as { user_type?: string | null } | null)?.user_type ?? "")
  if (!brokerageId || !PRINCIPAL_TYPES.has(userType)) {
    return { success: false, error: "Principal access required" }
  }
  const rows = await loadApprovalSla(brokerageId, null)
  return { success: true, rows }
}

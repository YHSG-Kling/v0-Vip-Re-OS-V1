/**
 * Resolve staff learning context — scoped to internal-brokerage staff roles:
 *   - TC (transaction coordinator)
 *   - compliance_officer
 *   - team_lead
 *
 * NOT for:
 *   - lender (external partner)
 *   - vendor (external partner)
 *   - title agent (handled via vendor model)
 *   - ISA (AI, not a person)
 *
 * The router picks modules tagged with the matching audience_role + the
 * staff member's tenure bucket. Role-specific gaps drive priority:
 *
 *   TC                  → workload spikes (>15 active txns) / closing-prep gaps
 *   compliance_officer  → unresolved compliance_events / tenant safety findings
 *   team_lead           → team-wide brokerage-intelligence pattern gaps
 */

import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"

export type StaffRole = "TC" | "compliance_officer" | "team_lead"

export interface StaffLearningContext {
  userId:              string
  brokerageId:         string
  role:                StaffRole
  /** Tenure bucket: 'new' (<90d) | 'growing' (90–365d) | 'tenured' (>1y) */
  tenureBucket:        "new" | "growing" | "tenured"
  completedModuleIds:  string[]
  /** Role-specific gap tags surfaced to the router. */
  gapTags:             string[]
}

const STAFF_ROLES: ReadonlySet<string> = new Set(["TC", "compliance_officer", "team_lead"])

export async function resolveStaffLearningContext(
  supabase: SupabaseClient,
  userId:   string,
): Promise<StaffLearningContext | null> {
  const { data: profile } = await supabase
    .from("users")
    .select("brokerage_id, user_type, created_at")
    .eq("id", userId)
    .maybeSingle()
  if (!profile?.brokerage_id) return null
  if (!STAFF_ROLES.has(profile.user_type as string)) return null   // not a staff role

  const role = profile.user_type as StaffRole
  const brokerageId = profile.brokerage_id as string

  // Tenure bucket
  let tenureBucket: StaffLearningContext["tenureBucket"] = "growing"
  if (profile.created_at) {
    const days = Math.floor((Date.now() - new Date(profile.created_at as string).getTime()) / 86_400_000)
    if (days < 90)        tenureBucket = "new"
    else if (days <= 365) tenureBucket = "growing"
    else                  tenureBucket = "tenured"
  }

  // Completed modules
  const { data: completedRows } = await supabase
    .from("learning_assignments")
    .select("module_id")
    .eq("staff_user_id", userId)
    .eq("status", "completed")
  const completedModuleIds = (completedRows ?? []).map((r: Record<string, unknown>) => (r as { module_id: string }).module_id)

  // Role-specific gap detection
  const gapTags: string[] = []

  if (role === "TC") {
    // Workload spike — count active transactions where this TC is the
    // primary coordinator (transaction_coordinators table or
    // transaction_participants role='tc').
    const { count: activeTcDeals } = await supabase
      .from("transaction_coordinators")
      .select("transaction_id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId)
      .eq("coordinator_user_id", userId)
    if ((activeTcDeals ?? 0) >= 15) gapTags.push("tc_workload_spike")

    // Open closing-prep checklist items needing TC attention
    const { count: openChecklist } = await supabase
      .from("closing_checklist_items")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId)
      .eq("completed", false)
      .eq("owner", "tc")
    if ((openChecklist ?? 0) >= 10) gapTags.push("tc_closing_backlog")
  }

  if (role === "compliance_officer") {
    // Unresolved compliance events in last 30 days
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
    const { count: unresolvedComp } = await supabase
      .from("compliance_events")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId)
      .gte("created_at", since)
      .neq("status", "resolved")
    if ((unresolvedComp ?? 0) >= 1) gapTags.push("unresolved_compliance_events")

    // Open tenant safety findings
    const { count: openFindings } = await supabase
      .from("tenant_safety_findings")
      .select("id", { count: "exact", head: true })
      .eq("resolved", false)
    if ((openFindings ?? 0) >= 1) gapTags.push("open_tenant_safety_findings")
  }

  if (role === "team_lead") {
    // Brokerage intelligence insights with adoption pattern: any open
    // critical-severity unadopted pattern is a team_lead learning moment.
    const { count: openCritical } = await supabase
      .from("brokerage_intelligence_insights")
      .select("id", { count: "exact", head: true })
      .eq("status", "open")
      .eq("brokerage_id", brokerageId)
      .eq("severity", "critical")
    if ((openCritical ?? 0) >= 1) gapTags.push("team_pattern_adoption_pending")
  }

  // Onboarding-tenure default — newer staff always get role-specific
  // "getting started" modules whether or not they have specific gaps.
  if (tenureBucket === "new") gapTags.push("staff_onboarding")

  return {
    userId,
    brokerageId,
    role,
    tenureBucket,
    completedModuleIds,
    gapTags: Array.from(new Set(gapTags)),
  }
}

"use server"

import { createClient } from "@/lib/supabase/server"
import { isPlatformStaffIdentity } from "@/lib/auth/resolve-user-role"
import { getAgentContext } from "@/lib/identity"
import {
  serviceGetLeads,
  serviceEnrichLead,
  serviceRejectLead,
  serviceImportLeads,
} from "@/lib/application/lead-application-service"
import type { LeadScore, LeadIntent, LeadStatus, LeadSource, Lead } from "@/app/types/lead-management"

// Types are now exported from @/app/types/lead-management

// ACCESS POLICY (owner): LEADS = BROKERAGE + PLATFORM ONLY. Every action in
// this file (list / read / enrich / reject / import) is a lead-desk verb and
// is restricted to brokerage-LEVEL roles (broker / broker_owner / broker_admin
// / admin) + platform staff (superadmin / support). Agents, team leads, TCs and
// compliance officers are deliberately excluded — agents work CONTACTS only
// (post-promotion).
// SCOPE LADDER (kept inline — the policy above deliberately EXCLUDES team_lead,
// so this must not widen to the shared operational roster): 'superadmin' removed
// — dead as users.user_type (0 live rows; platform staff carry platform_role).
const LEAD_DESK_ROLES = ["admin", "broker", "broker_owner", "broker_admin"] as const

/**
 * Session-derived lead-desk gate. Resolves the caller with the cookie-bound
 * server client (the previous implementation asked the SERVICE client for
 * auth.getUser(), which carries no session and could never authenticate).
 */
async function requireLeadDesk(): Promise<
  { ok: true } | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }

  const { data: profile } = await supabase
    .from("users")
    .select("user_type, platform_role")
    .eq("id", user.id)
    .single()

  const role = profile?.user_type ?? "agent"
  const platformStaff = isPlatformStaffIdentity(role, profile?.platform_role)
  if (!platformStaff && !(LEAD_DESK_ROLES as readonly string[]).includes(role)) {
    return { ok: false, error: "Forbidden" }
  }
  return { ok: true }
}

export async function getLeadsAdmin(params?: {
  search?: string
  score?: LeadScore
  intent?: LeadIntent
  status?: LeadStatus
  source?: LeadSource
  page?: number
  limit?: number
  sortBy?: string
  sortOrder?: "asc" | "desc"
  adminView?: boolean
}) {
  try {
    const gate = await requireLeadDesk()
    if (!gate.ok) {
      return { success: false, error: gate.error, leads: [], total: 0, page: 1, limit: 10, totalPages: 0 }
    }

    const { agentId, brokerageId } = await getAgentContext()
    if (!brokerageId) return { success: false, error: "Missing brokerage context", leads: [], total: 0, page: 1, limit: 10, totalPages: 0 }
    const result = await serviceGetLeads((agentId ?? null) as any, brokerageId, params as any)
    return { success: true, ...result }
  } catch (error) {
    return { success: false, error: String(error), leads: [], total: 0, page: 1, limit: 10, totalPages: 0 }
  }
}

// ── DELETED: getLead(id) ────────────────────────────────────────────────────
//
// DUPLICATE, and the broken one of the pair. The survivor is
// app/actions/leads.ts:87 `getLeadById`, which is LIVE —
// app/dashboard/isa/components/isa-lead-queue-panel.tsx:156 reads every lead
// detail through it.
//
// Why the survivor is the survivor, not just the one with a caller:
//   · SCOPE. getLeadById filters `.eq("brokerage_id", …)` only. This one went
//     through serviceGetLead, which additionally filters
//     `.eq("agent_id", agentId)` with agentId from getAgentContext(). The
//     roster this file gates for is admin / broker / broker_owner /
//     broker_admin + platform staff — brokerage-level seats that by policy are
//     NOT agents and generally have no `agents` row. So agentId was null for
//     exactly the people allowed to call it, producing `agent_id=eq.null` on
//     the wire, which matches nothing. It could only ever have returned a lead
//     for a caller who was simultaneously on the lead desk AND the lead's own
//     assigned agent.
//   · FAILURE MODE. serviceGetLead uses `.single()` and THROWS on the empty
//     result, so the miss above surfaced as a caught exception stringified into
//     `error`. getLeadById uses `.maybeSingle()` and returns
//     { success:false, error, lead:null }.
//
// NOT CARRIED FORWARD, deliberately and named rather than silently dropped:
// this wrapper's gate admitted PLATFORM STAFF (isPlatformStaffIdentity over
// users.platform_role) and getLeadById's assertISARole roster does not — it is
// admin / broker / broker_owner / broker_admin / isa. Widening an access roster
// is an owner ruling, not a merge, and the two files encode two deliberately
// different policies (this file's header excludes `isa`; leads.ts includes it).
// The live surface that genuinely needs platform-staff reach, /app/leads, goes
// through `getLeadsAdmin` below, which keeps that admission.

export async function enrichLead(leadId: string) {
  try {
    if (!leadId) return { success: false, error: "Lead ID is required" }
    const gate = await requireLeadDesk()
    if (!gate.ok) return { success: false, error: gate.error }
    const { agentId, brokerageId } = await getAgentContext()
    if (!brokerageId) return { success: false, error: "Missing brokerage context" }
    const lead = await serviceEnrichLead((agentId ?? null) as any, brokerageId, leadId)
    return { success: true, lead }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

export async function rejectLead(leadId: string, reason?: string) {
  try {
    if (!leadId) return { success: false, error: "Lead ID is required" }
    const gate = await requireLeadDesk()
    if (!gate.ok) return { success: false, error: gate.error }
    const { agentId, brokerageId } = await getAgentContext()
    if (!brokerageId) return { success: false, error: "Missing brokerage context" }
    const lead = await serviceRejectLead((agentId ?? null) as any, brokerageId, leadId, reason)
    return { success: true, lead }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

export async function importLeads(leads: Array<Partial<Lead> & { owner_agent_id?: string | null }>) {
  try {
    if (!leads?.length) return { success: false, error: "No leads provided", imported: 0, deduped: 0, unassigned: 0 }
    const gate = await requireLeadDesk()
    if (!gate.ok) return { success: false, error: gate.error, imported: 0, deduped: 0, unassigned: 0 }
    const { agentId, brokerageId } = await getAgentContext()
    if (!brokerageId) return { success: false, error: "Missing brokerage context", imported: 0, deduped: 0, unassigned: 0 }
    const result = await serviceImportLeads((agentId ?? null) as any, brokerageId, leads as any)
    return { success: true, imported: result.imported, deduped: result.deduped, unassigned: result.unassigned }
  } catch (error) {
    return { success: false, error: String(error), imported: 0, deduped: 0, unassigned: 0 }
  }
}

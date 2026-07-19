"use server"

import { createClient } from "@/lib/supabase/server"
import { isPlatformStaff } from "@/lib/auth/resolve-user-role"
import { getAgentContext } from "@/lib/identity"
import {
  serviceGetLeads,
  serviceGetLead,
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
const LEAD_DESK_ROLES = ["admin", "broker", "broker_owner", "broker_admin", "superadmin"] as const

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
  const platformStaff = role === "superadmin" || isPlatformStaff(profile?.platform_role)
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

export async function getLead(id: string) {
  try {
    if (!id) return { success: false, error: "ID is required", lead: null }
    const gate = await requireLeadDesk()
    if (!gate.ok) return { success: false, error: gate.error, lead: null }
    const { agentId, brokerageId } = await getAgentContext()
    if (!brokerageId) return { success: false, error: "Missing brokerage context", lead: null }
    const lead = await serviceGetLead((agentId ?? null) as any, brokerageId, id)
    return { success: true, lead }
  } catch (error) {
    return { success: false, error: String(error), lead: null }
  }
}

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

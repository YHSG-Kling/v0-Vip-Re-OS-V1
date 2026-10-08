"use server"

import { createClient } from "@/lib/supabase/server"
import {
  resolveLeadVisibilityForSession,
  applyLeadRowScope,
  type LeadRowScope,
} from "@/lib/auth/lead-visibility"
import { getAgentContext } from "@/lib/identity"
import {
  serviceGetLeads,
  serviceEnrichLead,
  serviceRejectLead,
  serviceImportLeads,
} from "@/lib/application/lead-application-service"
import type { LeadScore, LeadIntent, LeadStatus, LeadSource, Lead } from "@/app/types/lead-management"

// Types are now exported from @/app/types/lead-management

// TOMBSTONE (lead-visibility consolidation): the inline `LEAD_DESK_ROLES` array
// is DELETED. The survivor is lib/auth/lead-visibility.ts:resolveLeadVisibility
// (session entry point `resolveLeadVisibilityForSession`).
//
// WHAT MOVED, AND WHY THE OLD COMMENT NO LONGER HOLDS. The policy note that
// stood here said team_lead was excluded on purpose and that this roster must
// not widen to the shared operational one. That is superseded by the owner's
// ruling: "if team tier subscriptions, they don't have a broker in the
// subscription so the team lead can see leads." team_lead is admitted — but NOT
// brokerage-wide. The survivor returns a ROW SCOPE alongside the admission, and
// every read in this file now carries it, so a team lead reaches only leads
// worked by their own team's agents. On a tenant whose only team is theirs the
// scope collapses to the whole tenant, which is precisely the owner's case.
//
// ALSO REMOVED FROM THIS SITE, and named rather than dropped silently:
//   · 'broker_admin' — not a storable user_type (canonicalizes to `broker`;
//     users_user_type_check admits fourteen values and that is not one). The
//     comparison here could only ever match nothing. It survives as an INPUT
//     spelling inside the one roster, which is where a caller-supplied value is
//     judged.
//   · 'superadmin'/'support' as user_type comparisons were already gone from this
//     site; platform staff continue to be admitted, now through the survivor's
//     isPlatformStaffIdentity arm rather than a local call.
//
// MERGED ONTO THE SURVIVOR FIRST: this file's platform-staff admission is part
// of LEAD_DESK/​platform handling in lib/auth/lead-visibility.ts, and the 'isa'
// seat that app/actions/leads.ts carried is in the same roster — so folding
// these two files onto one answer neither narrowed this one nor widened it
// beyond the ruling.

/**
 * Session-derived lead-desk gate. Resolves the caller with the cookie-bound
 * server client (an earlier implementation asked the SERVICE client for
 * auth.getUser(), which carries no session and could never authenticate).
 *
 * Returns the ROW SCOPE on success. A caller that ignores it reads
 * brokerage-wide rows for a team lead, which is the failure this consolidation
 * exists to prevent — so the scope is on the success branch, not a side channel.
 */
async function requireLeadDesk(): Promise<
  { ok: true; scope: LeadRowScope } | { ok: false; error: string }
> {
  const supabase = await createClient()
  const vis = await resolveLeadVisibilityForSession(supabase)
  if (!vis.allowed) {
    // 'unresolved' keeps its own words: a gate that could not run must not
    // render as a plain "Forbidden", which reads as a decided refusal.
    return { ok: false, error: vis.status === "forbidden" ? "Forbidden" : vis.reason }
  }
  return { ok: true, scope: vis.scope }
}

/**
 * Prove ONE lead is on this caller's board before a single-lead verb acts on it.
 *
 * enrichLead / rejectLead delegate to the service layer, which pins brokerage_id
 * but knows nothing about teams. Without this, a team lead could enrich or
 * reject any lead in the brokerage by id — admission without row scope, i.e.
 * exactly the brokerage-wide reach the ruling does not grant.
 */
async function leadIsInScope(scope: LeadRowScope, leadId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (scope.kind !== "team") return { ok: true }
  const supabase = await createClient()
  const { data, error } = await applyLeadRowScope(
    supabase.from("leads").select("id").eq("id", leadId),
    scope,
  ).maybeSingle()
  // supabase-js RESOLVES a refusal — a swallowed error here is indistinguishable
  // from "not your lead", and both must refuse.
  if (error) return { ok: false, error: "Could not verify that lead" }
  if (!data) return { ok: false, error: "Lead not found" }
  return { ok: true }
}

/**
 * THE brokerage lead list. Since wave 14 it is the ONLY one: the second
 * spelling, app/actions/leads.ts:getLeads, was a duplicate of this over the same
 * table with the same session-derived tenant and no caller, and was retired onto
 * this one (tombstone at the bottom of app/actions/leads.ts). The six filters
 * that lived only there — lifecycleState / urgencyLevel / assignedAgentId /
 * aiIsaOwner / minimumViableForIsa / activeOnly — were merged onto
 * lib/application/lead-application-service.ts:serviceGetLeads BEFORE that
 * deletion and are passed straight through here.
 */
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
  lifecycleState?: string
  urgencyLevel?: string
  assignedAgentId?: string
  aiIsaOwner?: boolean
  minimumViableForIsa?: boolean
  activeOnly?: boolean
}) {
  try {
    const gate = await requireLeadDesk()
    if (!gate.ok) {
      return { success: false, error: gate.error, leads: [], total: 0, page: 1, limit: 10, totalPages: 0 }
    }

    const { agentId, brokerageId } = await getAgentContext()
    if (!brokerageId) return { success: false, error: "Missing brokerage context", leads: [], total: 0, page: 1, limit: 10, totalPages: 0 }
    // TEAM ROW SCOPE reaches the service layer as `teamAgentIds` — a NARROWING
    // the service applies with `.in("agent_id", …)`. It is passed from the
    // resolved SCOPE, never from `params`: a caller-supplied agent list would be
    // the body-supplied-tenant shape wearing a different hat.
    const teamAgentIds = gate.scope.kind === "team" ? gate.scope.agentIds : undefined
    const result = await serviceGetLeads((agentId ?? null) as any, brokerageId, {
      ...(params as any),
      teamAgentIds,
    })
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
    const inScope = await leadIsInScope(gate.scope, leadId)
    if (!inScope.ok) return { success: false, error: inScope.error }
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
    const inScope = await leadIsInScope(gate.scope, leadId)
    if (!inScope.ok) return { success: false, error: inScope.error }
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

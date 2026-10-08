"use server"

/**
 * app/actions/lead-acquisition.ts — Server Action wrappers for the
 * kernel's lead-acquisition handlers.
 *
 * Client components import from here instead of "@/lib/kernel/lead-
 * acquisition-handlers" directly. The lib module uses createServiceClient
 * + processKernelEvent — server-only — and Turbopack walks its graph
 * into Remotion when a "use client" file imports it.
 *
 * GATED (lane 91D2, CLAUDE.md §4). This wrapper forwarded its whole body —
 * leadId, brokerageId, agentId — to the kernel handler, which converts the lead
 * to a contact and records the assignment on the SERVICE client. As a
 * "use server" export it is a public HTTP endpoint, so any signed-in user could
 * name any tenant's lead and any agent and run the conversion there.
 * test:tenant-scope CHECK 3 reported it once it learned object-carried tenant
 * ids. Its one caller — the admin lead-lineage "Assign & Convert" button
 * (app/dashboard/admin/lead-lineage/lead-lineage-client.tsx) — runs governLead
 * first, which stamps `leads.agent_id` with the governed pick, and then calls
 * this to complete the conversion. So the door now completes exactly THAT and
 * nothing else:
 *   · the tenant is the SESSION's; a body brokerage naming another is refused;
 *   · the caller must be on the lead desk (the same resolver
 *     app/actions/lead-assignment/assign-lead.ts gates on — admin seat or
 *     tenant-pinned grant; a team lead only over their own team's rows);
 *   · the lead must be on the caller's board AND already carry exactly this
 *     `agentId` — a body agent cannot redirect a lead the governance did not
 *     hand to them. A hand-picked agent goes through manualAssignLead
 *     (assign-lead.ts:179), which proves the agent and runs the eligibility gate.
 */
import { handleLeadAssigned as _handleLeadAssigned } from "@/lib/kernel/lead-acquisition-handlers"
import { requireCallerTenant } from "@/lib/auth/require-caller"
import { resolveLeadVisibility, applyLeadRowScope } from "@/lib/auth/lead-visibility"

export async function handleLeadAssigned(params: {
  leadId: string
  brokerageId: string
  agentId: string
  ruleId?: string
  method: string
  scoreAtAssignment: number
}): Promise<void> {
  const tenant = await requireCallerTenant(params.brokerageId)
  if (!tenant.ok) throw new Error(tenant.error)

  const vis = await resolveLeadVisibility(tenant.supabase, {
    userId: tenant.userId,
    userType: tenant.userType,
    platformRole: tenant.platformRole,
    brokerageId: tenant.brokerageId,
  })
  if (!vis.allowed) {
    throw new Error(
      vis.status === "forbidden"
        ? "Forbidden: only a brokerage admin or team lead can assign leads"
        : vis.reason,
    )
  }

  const { data: lead, error: leadError } = await applyLeadRowScope(
    tenant.supabase
      .from("leads")
      .select("id, agent_id")
      .eq("id", params.leadId)
      .eq("brokerage_id", tenant.brokerageId),
    vis.scope,
  ).maybeSingle()
  if (leadError) throw new Error(`Could not read that lead: ${leadError.message}`)
  if (!lead) throw new Error("Lead not found in your brokerage")
  if (!params.agentId || (lead as { agent_id: string | null }).agent_id !== params.agentId) {
    throw new Error("That agent is not the lead's governed assignee")
  }

  params = { ...params, brokerageId: tenant.brokerageId }
  return _handleLeadAssigned(params)
}

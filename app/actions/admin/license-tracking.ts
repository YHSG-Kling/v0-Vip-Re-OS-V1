"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { licenseNeedsManualReview, manualReviewOutcome } from "@/lib/onboarding/license-review"

// All functions in this file are brokerage-admin tooling. Previously every
// one was unauthenticated and trusted caller-supplied brokerageId / agentId.
// Now: session is required, brokerage is resolved from session, and write
// actions require broker / admin / superadmin role.

const ADMIN_ROLES = ["admin", "super_admin", "superadmin", "broker", "broker_owner", "broker_admin"]

async function requireAdminInBrokerage(): Promise<
  | { ok: true; userId: string; brokerageId: string; userType: string; isSuperadmin: boolean }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }
  const { data: u } = await supabase
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()
  if (!u?.brokerage_id) return { ok: false, error: "Unauthorized" }
  if (!ADMIN_ROLES.includes(u.user_type ?? "")) return { ok: false, error: "Forbidden" }
  return {
    ok: true,
    userId: user.id,
    brokerageId: u.brokerage_id,
    userType: u.user_type ?? "",
    isSuperadmin: ["superadmin", "super_admin"].includes(u.user_type ?? ""),
  }
}

export interface AgentLicenseStatus {
  userId: string
  fullName: string
  email: string
  licenseId: string | null
  licenseNumber: string | null
  licenseState: string | null
  expiryDate: string | null
  daysUntilExpiry: number | null
  ethicsCompletedAt: string | null
  daysUntilEthicsExpiry: number | null
  ceHoursCompleted: number
  ceHoursRequired: number
  verificationStatus: string | null
  /** true when auto-verification couldn't clear the license (pending/failed) → needs a human decision. */
  needsManualReview: boolean
}

export async function getBrokerageAgentLicenseStatuses(
  _brokerageId?: string  // ignored — derived from session (superadmins can pass any)
): Promise<{ agents: AgentLicenseStatus[]; error?: string }> {
  const auth = await requireAdminInBrokerage()
  if (!auth.ok) return { agents: [], error: auth.error }

  const service = createServiceClient()

  const brokerageId = auth.isSuperadmin && _brokerageId ? _brokerageId : auth.brokerageId

  const { data: agents, error } = await service
    .from("users")
    .select(`
      id,
      first_name,
      last_name,
      email,
      agents (
        id,
        license_expiry,
        ethics_completed_at,
        ethics_due_date,
        ce_hours_required,
        ce_hours_completed,
        ce_cycle_end_date,
        agent_licenses (
          id,
          license_number,
          license_state,
          expiry_date,
          verification_status
        )
      )
    `)
    .eq("brokerage_id", brokerageId)
    .eq("user_type", "agent")
    .order("last_name")

  if (error) return { agents: [], error: error.message }

  const now = Date.now()

  const statuses: AgentLicenseStatus[] = (agents ?? []).map((a: any) => {
    const agentRow = Array.isArray(a.agents) ? a.agents[0] : a.agents
    // license_expiry + agent_licenses live on the AGENT (agent_licenses FK is agent_id), not users.
    const license = Array.isArray(agentRow?.agent_licenses) ? agentRow.agent_licenses[0] : agentRow?.agent_licenses

    const expiryRaw = license?.expiry_date ?? agentRow?.license_expiry ?? null
    const daysUntilExpiry = expiryRaw
      ? Math.ceil((new Date(expiryRaw).getTime() - now) / 86_400_000)
      : null

    const ethicsDue = agentRow?.ethics_due_date ?? null
    const daysUntilEthicsExpiry = ethicsDue
      ? Math.ceil((new Date(ethicsDue).getTime() - now) / 86_400_000)
      : null

    const verificationStatus = license?.verification_status ?? null
    return {
      userId: a.id,
      fullName: `${a.first_name ?? ""} ${a.last_name ?? ""}`.trim() || a.email || "Unknown Agent",
      email: a.email ?? "",
      licenseId: license?.id ?? null,
      licenseNumber: license?.license_number ?? null,
      licenseState: license?.license_state ?? null,
      expiryDate: expiryRaw,
      daysUntilExpiry,
      ethicsCompletedAt: agentRow?.ethics_completed_at ?? null,
      daysUntilEthicsExpiry,
      ceHoursCompleted: Number(agentRow?.ce_hours_completed ?? 0),
      ceHoursRequired: Number(agentRow?.ce_hours_required ?? 0),
      verificationStatus,
      needsManualReview: licenseNeedsManualReview(verificationStatus, !!license?.license_number),
    }
  })

  return { agents: statuses }
}

// ─── Manual license review (resolves the License Verifier's escalation) ───────

/**
 * A compliance officer / admin clears a license the auto-verifier couldn't (NIPR pending + AI
 * inconclusive / no document). Sets the canonical verification_status, logs a manual
 * license_verifications row for the audit trail, and tells the agent the outcome. This is the
 * human end of the manager hand-off the License Verifier starts on failure.
 */
export async function reviewLicenseManually(input: {
  licenseId: string
  decision: "approve" | "reject"
  notes?: string
}): Promise<{ success: boolean; error?: string }> {
  const auth = await requireAdminInBrokerage()
  if (!auth.ok) return { success: false, error: auth.error }

  const service = createServiceClient()
  const { data: lic } = await service
    .from("agent_licenses")
    .select("id, agent_id, brokerage_id, license_number, license_state")
    .eq("id", input.licenseId)
    .maybeSingle()
  if (!lic) return { success: false, error: "License not found" }
  if (!auth.isSuperadmin && lic.brokerage_id !== auth.brokerageId) {
    return { success: false, error: "Forbidden" }
  }

  const outcome = manualReviewOutcome(input.decision)
  const passed = outcome.verified
  const now = new Date().toISOString()

  await service
    .from("agent_licenses")
    .update({
      verification_status: outcome.verificationStatus,
      verified_at: passed ? now : null,
      updated_at: now,
    })
    .eq("id", lic.id)

  // Audit row — manual method, captures the reviewer + their notes.
  await service.from("license_verifications").insert({
    brokerage_id: lic.brokerage_id,
    license_id: lic.id,
    verification_method: "manual",
    verification_result: outcome.verificationResult,
    failure_reasons: passed ? null : [input.notes?.trim() || "Rejected on manual review"],
    raw_response: { detail: input.notes?.trim() || `Manually ${input.decision}d`, reviewer_user_id: auth.userId },
  })

  // Tell the agent the outcome.
  const { data: agentRow } = await service.from("agents").select("user_id").eq("id", lic.agent_id).maybeSingle()
  if (agentRow?.user_id) {
    await service.from("notifications").insert({
      user_id: agentRow.user_id,
      brokerage_id: lic.brokerage_id,
      type: passed ? "license_verified" : "license_rejected",
      title: passed ? "License verified" : "License review — action needed",
      body: passed
        ? `Your ${lic.license_state ?? ""} license (#${lic.license_number ?? ""}) was verified by your brokerage.`
        : `Your ${lic.license_state ?? ""} license review needs attention${input.notes?.trim() ? `: ${input.notes.trim()}` : ". Please contact your admin."}`,
      entity_type: "agent_license",
      entity_id: lic.id,
      priority: passed ? "normal" : "high",
      channel: "in_app",
    })
  }

  return { success: true }
}

// ─── CE log entries ──────────────────────────────────────────────────────────

export interface CECompletionInput {
  agentId: string
  courseName: string
  provider?: string
  category: "ethics" | "core" | "elective" | "fair_housing" | "other"
  hours: number
  completedOn: string  // YYYY-MM-DD
  certificateUrl?: string
  notes?: string
}

/**
 * Log a CE completion + auto-update agents row totals (and ethics_completed_at
 * when category=ethics).
 */
export async function logCeCompletion(input: CECompletionInput): Promise<{
  success: boolean
  completionId?: string
  error?: string
}> {
  const auth = await requireAdminInBrokerage()
  if (!auth.ok) return { success: false, error: auth.error }

  const service = createServiceClient()

  // Verify the agent belongs to caller's brokerage
  const { data: agent } = await service
    .from("agents")
    .select("id, brokerage_id, ce_hours_completed")
    .eq("id", input.agentId)
    .maybeSingle()

  if (!agent) return { success: false, error: "Agent not found" }
  if (!auth.isSuperadmin && agent.brokerage_id !== auth.brokerageId) {
    return { success: false, error: "Forbidden" }
  }

  const { data: completion, error } = await service
    .from("agent_ce_completions")
    .insert({
      agent_id: input.agentId,
      brokerage_id: agent.brokerage_id,
      course_name: input.courseName,
      provider: input.provider ?? null,
      category: input.category,
      hours: input.hours,
      completed_on: input.completedOn,
      certificate_url: input.certificateUrl ?? null,
      notes: input.notes ?? null,
    })
    .select("id")
    .single()

  if (error || !completion) return { success: false, error: error?.message ?? "Insert failed" }

  // Update the agent's running totals (idempotent — recompute from log)
  const { data: completions } = await service
    .from("agent_ce_completions")
    .select("hours, category, completed_on")
    .eq("agent_id", input.agentId)

  const totalHours = (completions ?? []).reduce((s, c: any) => s + Number(c.hours ?? 0), 0)
  const latestEthics = (completions ?? [])
    .filter((c: any) => c.category === "ethics")
    .map((c: any) => c.completed_on)
    .sort()
    .pop()

  const updates: Record<string, any> = { ce_hours_completed: totalHours }
  if (input.category === "ethics" && latestEthics) {
    updates.ethics_completed_at = new Date(latestEthics).toISOString()
    // NAR ethics: every 3 years
    const due = new Date(latestEthics)
    due.setFullYear(due.getFullYear() + 3)
    updates.ethics_due_date = due.toISOString().slice(0, 10)
  }

  await service.from("agents").update(updates).eq("id", input.agentId)

  return { success: true, completionId: completion.id }
}

export async function listCeCompletions(agentId: string): Promise<Array<{
  id: string
  courseName: string
  provider: string | null
  category: string
  hours: number
  completedOn: string
  certificateUrl: string | null
}>> {
  const auth = await requireAdminInBrokerage()
  if (!auth.ok) return []

  const service = createServiceClient()

  // Verify the agent belongs to caller's brokerage before reading
  const { data: agent } = await service
    .from("agents")
    .select("brokerage_id")
    .eq("id", agentId)
    .maybeSingle()
  if (!agent) return []
  if (!auth.isSuperadmin && agent.brokerage_id !== auth.brokerageId) return []

  const { data } = await service
    .from("agent_ce_completions")
    .select("id, course_name, provider, category, hours, completed_on, certificate_url")
    .eq("agent_id", agentId)
    .order("completed_on", { ascending: false })

  return (data ?? []).map((c: any) => ({
    id: c.id,
    courseName: c.course_name,
    provider: c.provider,
    category: c.category,
    hours: Number(c.hours ?? 0),
    completedOn: c.completed_on,
    certificateUrl: c.certificate_url,
  }))
}

export interface EducationModule {
  id: string
  title: string
  description: string | null
  target_roles: string[]
  required: boolean
  content_body: string | null
  quiz_questions: Array<{ question: string; choices: string[]; correct: number }> | null
  created_at: string
}

export async function getEducationModules(
  _brokerageId?: string  // ignored — derived from session
): Promise<{ modules: EducationModule[]; error?: string }> {
  const auth = await requireAdminInBrokerage()
  if (!auth.ok) return { modules: [], error: auth.error }

  const service = createServiceClient()

  const { data, error } = await service
    .from("learning_modules")
    .select("id, title, description:summary, target_roles:audience_roles, required, content_body:body, quiz_questions, created_at")
    .eq("brokerage_id", auth.brokerageId)
    .order("created_at", { ascending: false })

  if (error) return { modules: [], error: error.message }
  return { modules: (data ?? []) as EducationModule[] }
}

export async function createEducationModule(params: {
  brokerageId?: string  // ignored — derived from session
  title: string
  description: string
  targetRoles: string[]
  required: boolean
  contentBody: string
  quizQuestions: Array<{ question: string; choices: string[]; correct: number }>
}): Promise<{ success: boolean; moduleId?: string; error?: string }> {
  const auth = await requireAdminInBrokerage()
  if (!auth.ok) return { success: false, error: auth.error }

  const service = createServiceClient()

  const { data, error } = await service
    .from("learning_modules")
    .insert({
      brokerage_id: auth.brokerageId,
      title: params.title,
      summary: params.description,
      audience_roles: params.targetRoles,
      required: params.required,
      body: params.contentBody,
      quiz_questions: params.quizQuestions,
      status: "draft",
    })
    .select("id")
    .single()

  if (error) return { success: false, error: error.message }
  return { success: true, moduleId: data.id }
}

export async function deleteEducationModule(moduleId: string): Promise<{ success: boolean; error?: string }> {
  const auth = await requireAdminInBrokerage()
  if (!auth.ok) return { success: false, error: auth.error }

  const service = createServiceClient()

  // Verify the module belongs to caller's brokerage before deleting
  const { data: existing } = await service
    .from("learning_modules")
    .select("brokerage_id")
    .eq("id", moduleId)
    .maybeSingle()
  if (!existing) return { success: false, error: "Module not found" }
  if (!auth.isSuperadmin && existing.brokerage_id !== auth.brokerageId) {
    return { success: false, error: "Forbidden" }
  }

  const { error } = await service
    .from("learning_modules")
    .delete()
    .eq("id", moduleId)
    .eq("brokerage_id", existing.brokerage_id)

  if (error) return { success: false, error: error.message }
  return { success: true }
}

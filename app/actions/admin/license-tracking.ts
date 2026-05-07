"use server"

import { createServiceClient } from "@/lib/supabase/service"

export interface AgentLicenseStatus {
  userId: string
  fullName: string
  email: string
  licenseNumber: string | null
  licenseState: string | null
  expiryDate: string | null
  daysUntilExpiry: number | null
  ethicsCompletedAt: string | null
  daysUntilEthicsExpiry: number | null
  ceHoursCompleted: number
  ceHoursRequired: number
  verificationStatus: string | null
}

export async function getBrokerageAgentLicenseStatuses(
  brokerageId: string
): Promise<{ agents: AgentLicenseStatus[]; error?: string }> {
  const service = createServiceClient()

  // Pull users + their agent row (which holds ethics + CE columns from migration 1009)
  const { data: agents, error } = await service
    .from("users")
    .select(`
      id,
      full_name,
      email,
      license_expiry,
      agent_licenses (
        license_number,
        license_state,
        expiry_date,
        verification_status
      ),
      agents (
        id,
        ethics_completed_at,
        ethics_due_date,
        ce_hours_required,
        ce_hours_completed,
        ce_cycle_end_date
      )
    `)
    .eq("brokerage_id", brokerageId)
    .eq("user_type", "agent")
    .order("full_name")

  if (error) return { agents: [], error: error.message }

  const now = Date.now()

  const statuses: AgentLicenseStatus[] = (agents ?? []).map((a: any) => {
    const license = Array.isArray(a.agent_licenses) ? a.agent_licenses[0] : a.agent_licenses
    const agentRow = Array.isArray(a.agents) ? a.agents[0] : a.agents

    const expiryRaw = license?.expiry_date ?? a.license_expiry ?? null
    const daysUntilExpiry = expiryRaw
      ? Math.ceil((new Date(expiryRaw).getTime() - now) / 86_400_000)
      : null

    const ethicsDue = agentRow?.ethics_due_date ?? null
    const daysUntilEthicsExpiry = ethicsDue
      ? Math.ceil((new Date(ethicsDue).getTime() - now) / 86_400_000)
      : null

    return {
      userId: a.id,
      fullName: a.full_name ?? a.email ?? "Unknown Agent",
      email: a.email ?? "",
      licenseNumber: license?.license_number ?? null,
      licenseState: license?.license_state ?? null,
      expiryDate: expiryRaw,
      daysUntilExpiry,
      ethicsCompletedAt: agentRow?.ethics_completed_at ?? null,
      daysUntilEthicsExpiry,
      ceHoursCompleted: Number(agentRow?.ce_hours_completed ?? 0),
      ceHoursRequired: Number(agentRow?.ce_hours_required ?? 0),
      verificationStatus: license?.verification_status ?? null,
    }
  })

  return { agents: statuses }
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
  const service = createServiceClient()

  // Resolve brokerage from the agent row
  const { data: agent } = await service
    .from("agents")
    .select("id, brokerage_id, ce_hours_completed")
    .eq("id", input.agentId)
    .maybeSingle()

  if (!agent) return { success: false, error: "Agent not found" }

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
  const service = createServiceClient()
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
  brokerageId: string
): Promise<{ modules: EducationModule[]; error?: string }> {
  const service = createServiceClient()

  const { data, error } = await service
    .from("onboarding_quizzes")
    .select("id, title, description, target_roles, required, content_body, quiz_questions, created_at")
    .eq("brokerage_id", brokerageId)
    .order("created_at", { ascending: false })

  if (error) return { modules: [], error: error.message }
  return { modules: (data ?? []) as EducationModule[] }
}

export async function createEducationModule(params: {
  brokerageId: string
  title: string
  description: string
  targetRoles: string[]
  required: boolean
  contentBody: string
  quizQuestions: Array<{ question: string; choices: string[]; correct: number }>
}): Promise<{ success: boolean; moduleId?: string; error?: string }> {
  const service = createServiceClient()

  const { data, error } = await service
    .from("onboarding_quizzes")
    .insert({
      brokerage_id: params.brokerageId,
      title: params.title,
      description: params.description,
      target_roles: params.targetRoles,
      required: params.required,
      content_body: params.contentBody,
      quiz_questions: params.quizQuestions,
      passing_score: 80,
    })
    .select("id")
    .single()

  if (error) return { success: false, error: error.message }
  return { success: true, moduleId: data.id }
}

export async function deleteEducationModule(moduleId: string): Promise<{ success: boolean; error?: string }> {
  const service = createServiceClient()
  const { error } = await service.from("onboarding_quizzes").delete().eq("id", moduleId)
  if (error) return { success: false, error: error.message }
  return { success: true }
}

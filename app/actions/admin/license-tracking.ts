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
      )
    `)
    .eq("brokerage_id", brokerageId)
    .eq("user_type", "agent")
    .order("full_name")

  if (error) return { agents: [], error: error.message }

  const now = Date.now()

  const statuses: AgentLicenseStatus[] = (agents ?? []).map((a: any) => {
    const license = Array.isArray(a.agent_licenses) ? a.agent_licenses[0] : a.agent_licenses
    const expiryRaw = license?.expiry_date ?? a.license_expiry ?? null
    const daysUntilExpiry = expiryRaw
      ? Math.ceil((new Date(expiryRaw).getTime() - now) / 86_400_000)
      : null

    return {
      userId: a.id,
      fullName: a.full_name ?? a.email ?? "Unknown Agent",
      email: a.email ?? "",
      licenseNumber: license?.license_number ?? null,
      licenseState: license?.license_state ?? null,
      expiryDate: expiryRaw,
      daysUntilExpiry,
      ethicsCompletedAt: null,
      daysUntilEthicsExpiry: null,
      ceHoursCompleted: 0,
      ceHoursRequired: 45,
      verificationStatus: license?.verification_status ?? null,
    }
  })

  return { agents: statuses }
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

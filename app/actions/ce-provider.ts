"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  isCeProviderConnected,
  availableCourses,
  ceProgress,
  buildLaunchUrl,
  normalizeCeCompletion,
  sumCeHours,
  type CeProviderConfig,
  type CeCourse,
  type CeCompletionPayload,
  type CeProgress,
} from "@/lib/education/ce-provider"

async function ceProviderConfigFor(svc: ReturnType<typeof createServiceClient>, brokerageId: string): Promise<CeProviderConfig | null> {
  const { data } = await svc.from("brokerage_settings").select("settings").eq("brokerage_id", brokerageId).maybeSingle()
  const cfg = (((data as { settings?: Record<string, unknown> } | null)?.settings ?? {}) as any).ce_provider
  return cfg && typeof cfg === "object" ? (cfg as CeProviderConfig) : null
}

export interface CeCenter {
  connected: boolean
  providerName: string | null
  courses: CeCourse[]
  progress: CeProgress
  completions: Array<{ course_name: string; provider: string; category: string; hours: number; completed_on: string; certificate_url: string | null }>
}

/** Load the agent's CE center — connected provider status, in-app accredited courses, progress + history. */
export async function getCeCenter(): Promise<CeCenter> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")
  const svc = createServiceClient()
  const { data: agent } = await svc.from("agents").select("id, brokerage_id, license_state, ce_hours_required, ce_hours_completed").eq("user_id", user.id).maybeSingle()
  if (!agent) throw new Error("Agent profile not found")
  const a = agent as any

  const config = a.brokerage_id ? await ceProviderConfigFor(svc, a.brokerage_id) : null
  const { data: comps } = await svc.from("agent_ce_completions").select("course_name, provider, category, hours, completed_on, certificate_url").eq("agent_id", a.id).order("completed_on", { ascending: false }).limit(50)

  return {
    connected: isCeProviderConnected(config),
    providerName: config?.name ?? null,
    courses: availableCourses(config, a.license_state),
    progress: ceProgress(a.ce_hours_required, a.ce_hours_completed),
    completions: (comps ?? []) as any[],
  }
}

/** Launch an accredited CE course in-app (deep-link into the connected provider). */
export async function launchCeCourse(courseId: string): Promise<{ url: string } | { connected: false }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")
  const svc = createServiceClient()
  const { data: agent } = await svc.from("agents").select("id, brokerage_id").eq("user_id", user.id).maybeSingle()
  if (!agent) throw new Error("Agent profile not found")
  const a = agent as any
  const config = a.brokerage_id ? await ceProviderConfigFor(svc, a.brokerage_id) : null
  if (!config || !isCeProviderConnected(config)) return { connected: false }
  const url = buildLaunchUrl(config, courseId, a.id)
  if (!url) return { connected: false }
  return { url }
}

/** Admin connects/updates the brokerage's accredited CE provider (name, launch URL, course catalog). */
export async function connectCeProvider(config: CeProviderConfig): Promise<{ ok: true }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")
  const svc = createServiceClient()
  const { data: profile } = await svc.from("users").select("brokerage_id, user_type, role").eq("id", user.id).maybeSingle()
  const brokerageId = (profile as any)?.brokerage_id
  const isAdmin = ["broker", "admin", "broker_admin", "superadmin"].includes(String((profile as any)?.user_type)) || ["broker", "admin", "owner"].includes(String((profile as any)?.role))
  if (!brokerageId || !isAdmin) throw new Error("Not authorized — CE provider setup is broker/admin only")

  const { data: row } = await svc.from("brokerage_settings").select("settings").eq("brokerage_id", brokerageId).maybeSingle()
  const settings = (row as { settings?: Record<string, unknown> } | null)?.settings ?? {}
  const next = { ...settings, ce_provider: { name: config.name, connected: !!config.connected, launchBaseUrl: config.launchBaseUrl ?? null, catalog: config.catalog ?? [] } }
  const { error } = await svc.from("brokerage_settings").upsert({ brokerage_id: brokerageId, settings: next, updated_at: new Date().toISOString() }, { onConflict: "brokerage_id" })
  if (error) throw new Error(`Failed to connect provider: ${error.message}`)
  return { ok: true }
}

/**
 * Record a verified CE completion the accredited provider reported (called by the webhook). Inserts into
 * agent_ce_completions, then recomputes agents.ce_hours_completed from the full ledger (idempotent) so the
 * license-readiness engine sees the new credit. Never fabricates — only writes what the provider reported.
 */
export async function recordCeCompletionFromProvider(
  payload: CeCompletionPayload,
  ctx: { agentId: string; brokerageId: string | null; providerName: string },
): Promise<{ recorded: boolean; ceHoursCompleted: number }> {
  const svc = createServiceClient()
  const row = normalizeCeCompletion(payload, ctx)

  // Idempotency: one completion per (agent, course, completed_on).
  const { data: existing } = await svc.from("agent_ce_completions").select("id").eq("agent_id", ctx.agentId).eq("course_name", row.course_name).eq("completed_on", row.completed_on).limit(1).maybeSingle()
  if (!existing) {
    const { error } = await svc.from("agent_ce_completions").insert(row)
    if (error) return { recorded: false, ceHoursCompleted: 0 }
  }

  const { data: all } = await svc.from("agent_ce_completions").select("hours").eq("agent_id", ctx.agentId).limit(500)
  const total = sumCeHours((all ?? []) as Array<{ hours: number | null }>)
  await svc.from("agents").update({ ce_hours_completed: total }).eq("id", ctx.agentId)
  return { recorded: true, ceHoursCompleted: total }
}

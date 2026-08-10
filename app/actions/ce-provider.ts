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

/**
 * The user_types allowed to configure the brokerage's CE provider.
 *
 * LIVE VOCABULARY (verified against `users_user_type_check`): the constraint admits
 * exactly admin, agent, broker, broker_owner, compliance_officer, contact, isa,
 * lender, superadmin, support, system, tc, team_lead, vendor.
 *
 * The previous allowlist listed `broker_admin`, which the CHECK **cannot store** —
 * a dead branch — and omitted `broker_owner`, which it can, so **the owner of a
 * brokerage was locked out of connecting their own CE provider**. It also fell back
 * to `users.role`, which is RETIRED (mostly NULL, the rest title-cased), i.e. a
 * second door keyed on a column that no longer carries the answer.
 */
const CE_ADMIN_USER_TYPES = new Set(["broker", "broker_owner", "admin", "superadmin"])

/** Admin connects/updates the brokerage's accredited CE provider (name, launch URL, course catalog). */
export async function connectCeProvider(config: CeProviderConfig): Promise<{ ok: true }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")
  const svc = createServiceClient()
  // `error` destructured: supabase-js resolves a refused read, and reading that as
  // "no profile" would have surfaced an authorization failure as an authorization
  // *decision*. Both still fail closed, but for the stated reason.
  const { data: profile, error: profileError } = await svc
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()
  if (profileError) throw new Error("Could not verify your account")
  const brokerageId = (profile as { brokerage_id?: string | null } | null)?.brokerage_id ?? null
  const userType = String((profile as { user_type?: string | null } | null)?.user_type ?? "")
  if (!brokerageId || !CE_ADMIN_USER_TYPES.has(userType)) {
    throw new Error("Not authorized — CE provider setup is broker/admin only")
  }

  // Refuse a configuration that cannot work rather than storing a broken one:
  // `isCeProviderConnected` requires a non-empty name, and `buildLaunchUrl`
  // needs a base URL, so "connected" without either is a provider that shows as
  // live and then fails on every course launch.
  const name = String(config?.name ?? "").trim()
  if (!name) throw new Error("A provider name is required")
  const launchBaseUrl = config?.launchBaseUrl ? String(config.launchBaseUrl).trim() : null
  if (config?.connected && !launchBaseUrl) {
    throw new Error("A launch URL is required to mark the provider connected")
  }
  if (launchBaseUrl && !/^https:\/\//i.test(launchBaseUrl)) {
    throw new Error("The launch URL must be https")
  }

  const { data: row, error: readError } = await svc
    .from("brokerage_settings")
    .select("settings")
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  // Fail closed: a refused read here would be treated as "no settings yet" and the
  // upsert would then REPLACE every other setting this brokerage has with `{}`.
  if (readError) throw new Error(`Could not read brokerage settings: ${readError.message}`)

  const settings = (row as { settings?: Record<string, unknown> } | null)?.settings ?? {}
  const next = {
    ...settings,
    ce_provider: {
      name,
      connected: !!config.connected,
      launchBaseUrl,
      catalog: Array.isArray(config.catalog) ? config.catalog : [],
    },
  }
  const { data: saved, error } = await svc
    .from("brokerage_settings")
    .upsert(
      { brokerage_id: brokerageId, settings: next, updated_at: new Date().toISOString() },
      { onConflict: "brokerage_id" },
    )
    .select("brokerage_id")
  if (error) throw new Error(`Failed to connect provider: ${error.message}`)
  // PROVEN, not assumed — an upsert that matched nothing must not report success.
  if (!saved || saved.length === 0) throw new Error("The provider settings were not saved")
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

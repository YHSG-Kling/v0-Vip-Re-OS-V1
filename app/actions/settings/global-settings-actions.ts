'use server'

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  getGlobalSettings,
  updateGlobalSettings,
  type GlobalSettingsRow,
} from "@/lib/kernel"

export interface WidgetScope {
  owner_type: "brokerage" | "team" | "agent"
  owner_id: string
  display_name: string
}

export async function fetchGlobalSettings(): Promise<GlobalSettingsRow> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user?.id) {
    throw new Error("Unauthorized")
  }

  return await getGlobalSettings({ userId: user.id })
}

export async function updateSettings(
  updates: Partial<
    Pick<
      GlobalSettingsRow,
      | "app_name"
      | "app_logo_url"
      | "primary_color"
      | "secondary_color"
      | "font_family"
      | "fiscal_year_start"
      | "timezone"
      | "date_format"
      | "currency_symbol"
      | "email_notifications_enabled"
      | "sms_notifications_enabled"
      | "push_notifications_enabled"
    >
  >
): Promise<void> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user?.id) {
    throw new Error("Unauthorized")
  }

  await updateGlobalSettings({ userId: user.id, updates })
}

export async function getPlatformVideoProvider(): Promise<"did" | "heygen"> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.id) return "did"

  const { data: userRow } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!userRow?.brokerage_id) return "did"

  const serviceClient = createServiceClient()
  const { data: gs } = await serviceClient
    .from("global_settings")
    .select("additional_settings")
    .eq("brokerage_id", userRow.brokerage_id)
    .maybeSingle()

  return (gs?.additional_settings as any)?.platform_video_provider ?? "did"
}

export async function setPlatformVideoProvider(provider: "did" | "heygen"): Promise<void> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.id) throw new Error("Unauthorized")

  const { data: userRow } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!userRow?.brokerage_id) throw new Error("Brokerage not found")

  const serviceClient = createServiceClient()
  const { data: gs } = await serviceClient
    .from("global_settings")
    .select("id, additional_settings")
    .eq("brokerage_id", userRow.brokerage_id)
    .maybeSingle()
  if (!gs) throw new Error("Global settings not found")

  const existing = (gs.additional_settings as Record<string, unknown>) ?? {}
  await serviceClient
    .from("global_settings")
    .update({ additional_settings: { ...existing, platform_video_provider: provider } })
    .eq("id", gs.id)
}

export interface VideoCostFallbackConfig {
  enabled:          boolean
  didCostPerMin:    number
  heygenCostPerMin: number
}

/** Read the cost-fallback config (D-ID stays default; HeyGen used only when cheaper + enabled). */
export async function getVideoCostFallbackConfig(): Promise<VideoCostFallbackConfig> {
  const { DEFAULT_DID_COST_PER_MIN, DEFAULT_HEYGEN_COST_PER_MIN } = await import("@/lib/marketing/video-provider-cost")
  const fallback: VideoCostFallbackConfig = { enabled: false, didCostPerMin: DEFAULT_DID_COST_PER_MIN, heygenCostPerMin: DEFAULT_HEYGEN_COST_PER_MIN }
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.id) return fallback
  const { data: userRow } = await supabase.from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
  if (!userRow?.brokerage_id) return fallback
  const serviceClient = createServiceClient()
  const { data: gs } = await serviceClient.from("global_settings").select("additional_settings").eq("brokerage_id", userRow.brokerage_id).maybeSingle()
  const a = (gs?.additional_settings ?? {}) as Record<string, unknown>
  return {
    enabled: a.video_cost_fallback_enabled === true,
    didCostPerMin: typeof a.did_cost_per_min === "number" ? (a.did_cost_per_min as number) : DEFAULT_DID_COST_PER_MIN,
    heygenCostPerMin: typeof a.heygen_cost_per_min === "number" ? (a.heygen_cost_per_min as number) : DEFAULT_HEYGEN_COST_PER_MIN,
  }
}

/** Persist the cost-fallback config (superadmin). Negative prices are clamped to 0. */
export async function setVideoCostFallbackConfig(cfg: VideoCostFallbackConfig): Promise<void> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.id) throw new Error("Unauthorized")
  const { data: userRow } = await supabase.from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
  if (!userRow?.brokerage_id) throw new Error("Brokerage not found")
  const serviceClient = createServiceClient()
  const { data: gs } = await serviceClient.from("global_settings").select("id, additional_settings").eq("brokerage_id", userRow.brokerage_id).maybeSingle()
  if (!gs) throw new Error("Global settings not found")
  const existing = (gs.additional_settings as Record<string, unknown>) ?? {}
  await serviceClient.from("global_settings").update({
    additional_settings: {
      ...existing,
      video_cost_fallback_enabled: cfg.enabled === true,
      did_cost_per_min: Math.max(0, Number(cfg.didCostPerMin) || 0),
      heygen_cost_per_min: Math.max(0, Number(cfg.heygenCostPerMin) || 0),
    },
  }).eq("id", gs.id)
}

export async function fetchWidgetScope(): Promise<WidgetScope | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.id) throw new Error("Unauthorized")

  const { data: userRow } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!userRow?.brokerage_id) return null

  const serviceClient = createServiceClient()
  const { data: gs } = await serviceClient
    .from("global_settings")
    .select("additional_settings")
    .eq("brokerage_id", userRow.brokerage_id)
    .maybeSingle()

  return (gs?.additional_settings as any)?.widget_scope ?? null
}

export async function updateWidgetScope(scope: WidgetScope): Promise<void> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.id) throw new Error("Unauthorized")

  const { data: userRow } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!userRow?.brokerage_id) throw new Error("Brokerage not found")

  const serviceClient = createServiceClient()
  const { data: gs } = await serviceClient
    .from("global_settings")
    .select("id, additional_settings")
    .eq("brokerage_id", userRow.brokerage_id)
    .maybeSingle()
  if (!gs) throw new Error("Global settings not found")

  const existing = (gs.additional_settings as Record<string, unknown>) ?? {}
  await serviceClient
    .from("global_settings")
    .update({ additional_settings: { ...existing, widget_scope: scope } })
    .eq("id", gs.id)
}

export async function fetchWidgetAgentsAndTeams(): Promise<{
  agents: Array<{ id: string; name: string }>
  teams: Array<{ id: string; name: string }>
}> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.id) throw new Error("Unauthorized")

  const { data: userRow } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!userRow?.brokerage_id) return { agents: [], teams: [] }

  const serviceClient = createServiceClient()
  const [agentsRes, teamsRes] = await Promise.all([
    serviceClient
      .from("users")
      .select("id, first_name, last_name")
      .eq("brokerage_id", userRow.brokerage_id)
      .eq("user_type", "agent")
      .order("first_name"),
    serviceClient
      .from("teams")
      .select("id, name")
      .eq("brokerage_id", userRow.brokerage_id)
      .order("name"),
  ])

  return {
    agents: (agentsRes.data ?? []).map((a) => ({
      id: a.id,
      name: `${a.first_name ?? ""} ${a.last_name ?? ""}`.trim(),
    })),
    teams: (teamsRes.data ?? []).map((t) => ({ id: t.id, name: t.name ?? t.id })),
  }
}

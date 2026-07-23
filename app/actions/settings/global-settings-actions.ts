'use server'

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"
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

// BUSINESS RULE (platform-locked): the avatar/explainer video engine is D-ID +
// ElevenLabs ONLY. HeyGen is not selectable — this always resolves to "did".
export async function getPlatformVideoProvider(): Promise<"did"> {
  return "did"
}

// HeyGen is not a selectable provider. The setter is a no-op kept for call-site
// compatibility; the platform video engine is permanently D-ID.
export async function setPlatformVideoProvider(_provider: "did"): Promise<void> {
  return
}

export async function fetchWidgetScope(): Promise<WidgetScope | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.id) throw new Error("Unauthorized")

  const { data: userRow } = await supabase
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()
  if (!userRow?.brokerage_id) return null
  // Widget scope is brokerage-wide admin config — gate the RLS-bypassing read.
  if (!isAdminOrBroker(userRow)) return null

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
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()
  if (!userRow?.brokerage_id) throw new Error("Brokerage not found")
  // Only broker/admin may change brokerage-wide widget scope.
  if (!isAdminOrBroker(userRow)) throw new Error("Forbidden: insufficient permissions")

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
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()
  if (!userRow?.brokerage_id) return { agents: [], teams: [] }
  // The full brokerage roster is admin config for the widget scope picker —
  // gate the RLS-bypassing read to broker/admin.
  if (!isAdminOrBroker(userRow)) return { agents: [], teams: [] }

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

// ─── BYO-CARRIER POLICY ──────────────────────────────────────────────────────
// Whether the subscriber lets their MANAGED agents bring their own phone/SMS
// carrier. Stored on global_settings.additional_settings.allow_user_byo_carrier.
// Default OFF: the platform provisions + bills the number until the broker opts in.
// (Tenancy principals — solo agents, team leads, brokers — may always BYO for
// themselves regardless; this policy only governs managed agents.)

/** Read the brokerage's BYO-carrier policy. Any brokerage member may read it (the
 *  value is not sensitive — an agent needs to know whether they can BYO). */
export async function getByoCarrierPolicy(): Promise<{ allowUserByo: boolean }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.id) return { allowUserByo: false }

  const { data: userRow } = await supabase
    .from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
  if (!userRow?.brokerage_id) return { allowUserByo: false }

  const serviceClient = createServiceClient()
  const { data: gs } = await serviceClient
    .from("global_settings").select("additional_settings").eq("brokerage_id", userRow.brokerage_id).maybeSingle()
  return { allowUserByo: !!((gs?.additional_settings as Record<string, unknown> | null)?.allow_user_byo_carrier) }
}

/** Set the brokerage's BYO-carrier policy. Broker/admin only (the subscriber's choice). */
export async function setByoCarrierPolicy(allowUserByo: boolean): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.id) return { ok: false, error: "Unauthorized" }

  const { data: userRow } = await supabase
    .from("users").select("brokerage_id, user_type").eq("id", user.id).maybeSingle()
  if (!userRow?.brokerage_id) return { ok: false, error: "Brokerage not found" }
  if (!isAdminOrBroker(userRow)) return { ok: false, error: "Forbidden" }

  const serviceClient = createServiceClient()
  const { data: gs } = await serviceClient
    .from("global_settings").select("id, additional_settings").eq("brokerage_id", userRow.brokerage_id).maybeSingle()
  if (!gs) return { ok: false, error: "Global settings not found" }

  const existing = (gs.additional_settings as Record<string, unknown>) ?? {}
  const { error } = await serviceClient
    .from("global_settings")
    .update({ additional_settings: { ...existing, allow_user_byo_carrier: allowUserByo } })
    .eq("id", gs.id)
  if (error) return { ok: false, error: "Failed to save" }
  return { ok: true }
}

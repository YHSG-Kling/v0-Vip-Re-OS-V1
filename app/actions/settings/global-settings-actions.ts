'use server'

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveTenantAdmin } from "@/lib/auth/resolve-user-role"
import {
  getGlobalSettings,
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

// ─── REMOVED in the orphan burn-down (w2s3) ─────────────────────────────────
//
// `updateSettings(updates)` — MERGED-THEN-DELETED.
// SURVIVOR: app/actions/settings/update-global-settings.ts:updateGlobalSettings
// — the action the settings UI actually calls (BrandingForm,
// GeneralSettingsForm, NotificationChannelsCard).
//
// Nothing needed merging: the survivor writes the same twelve fields, delegates
// to the same kernel function, returns `{ error }` instead of throwing, and
// translates the kernel's "Forbidden" into a real sentence.
//
// It was deleted rather than left because it was a MASS-ASSIGNMENT hole. Its
// only restriction on which columns could be written was the TypeScript
// `Partial<Pick<GlobalSettingsRow, …>>` signature — and types are erased at
// runtime. A `"use server"` export receives whatever the caller POSTs, and this
// function passed that object straight through to
// `updateGlobalSettings({ updates })`, which spreads it into
// `.update({ ...params.updates })`. So any column on `global_settings` was
// writable, including the secrets the kernel's own comment says must never be
// written here — verified live on hrvaqgvukzxfskkcrwbt: `smtp_host`,
// `smtp_username`, `smtp_password`, `airtable_api_key`, `ghl_api_key`,
// `zapier_api_key`. Pointing a brokerage's SMTP credentials at another relay is
// a mail-interception primitive.
//
// The survivor is safe from the same input because it copies field-by-field out
// of a runtime `ALLOWED_FIELDS` const. That allow-list is the actual control;
// the type never was.
//
// `getPlatformVideoProvider()` / `setPlatformVideoProvider()` — DELETED.
// BUSINESS RULE (unchanged, platform-locked): the avatar/explainer video engine
// is D-ID + ElevenLabs ONLY; HeyGen is not selectable. The getter was a public
// HTTP endpoint whose entire body was `return "did"` — a network round-trip to
// learn a compile-time constant — and the setter was a public no-op that
// accepted a provider argument and silently discarded it, which is precisely
// the "reports success, changes nothing" class this audit exists to remove.
// `getPlatformVideoProvider` had no caller — its only mentions in the tree are
// prose in `lib/kernel/video.ts` and `lib/video/intro-video-reactor.ts` restating
// the rule, and both files already hard-code D-ID structurally.
//
// `setPlatformVideoProvider` DID have one live caller, and it is the reason the
// no-op mattered: `app/settings/providers/page.tsx` called it from a
// "Save Provider Settings" button and then rendered "Saved". A superadmin was
// told a platform setting had been persisted when the function had discarded its
// argument and written nothing. That button and its handler were removed with
// this deletion — the card is platform-locked and offers no vendor choice, so
// there was never anything for it to save.
//
// Platform video config that IS settable — channel enablement platform-wide —
// lives at `lib/platform/platform-providers.ts:setPlatformProviderOverride`,
// which writes real `provider_overrides` rows at scope_type='superadmin'. The
// VENDOR remains locked to D-ID + ElevenLabs there as well.
//
// The rule is unchanged; two dead endpoints and one lying button are gone.

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
  // Widget scope is brokerage-wide admin config, and the read below uses a SERVICE
  // client — so THIS gate is the only gate. resolveTenantAdmin, not the sync
  // predicate: it also honours a role GRANT, which is what public.is_brokerage_admin()
  // has done since m466. The session client is passed deliberately (RLS still
  // applies underneath, and user_role_assignments_select_own lets a caller read
  // their own grants).
  const scopeAdmin = await resolveTenantAdmin(supabase, user.id, userRow)
  // A refused grant read is NOT "you are not an admin" — say which it was rather
  // than returning null, which this surface renders as "no widget scope configured".
  if (!scopeAdmin.ok) throw new Error(`Could not resolve your permissions: ${scopeAdmin.error}`)
  if (!scopeAdmin.isTenantAdmin) return null

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
  // Only a brokerage administrator may change brokerage-wide widget scope — by
  // user_type OR by a tenant role grant, the same two ways RLS decides it.
  const writeAdmin = await resolveTenantAdmin(supabase, user.id, userRow)
  if (!writeAdmin.ok) throw new Error(`Could not resolve your permissions: ${writeAdmin.error}`)
  if (!writeAdmin.isTenantAdmin) throw new Error("Forbidden: insufficient permissions")

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
  // The full brokerage roster is admin config for the widget scope picker, read
  // through a SERVICE client — so this gate is the only gate, and it must admit
  // the grant-held admin that RLS already admits.
  const rosterAdmin = await resolveTenantAdmin(supabase, user.id, userRow)
  // An empty roster is what this surface shows for "not an admin"; a REFUSED read
  // must not be dressed up as that.
  if (!rosterAdmin.ok) throw new Error(`Could not resolve your permissions: ${rosterAdmin.error}`)
  if (!rosterAdmin.isTenantAdmin) return { agents: [], teams: [] }

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
  const byoAdmin = await resolveTenantAdmin(supabase, user.id, userRow)
  // "Forbidden" and "we could not tell" are different answers to the subscriber.
  if (!byoAdmin.ok) return { ok: false, error: `Could not resolve your permissions: ${byoAdmin.error}` }
  if (!byoAdmin.isTenantAdmin) return { ok: false, error: "Forbidden" }

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

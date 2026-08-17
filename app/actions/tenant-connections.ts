"use server"

// app/actions/tenant-connections.ts — TENANT-FINISHED vendor connections.
// The brokerage holds the vendor relationship (their MLS board, their ListHub
// account, their ShowingTime subscription, their portal lead sources); the
// platform provides the rail: a credential slot per vendor + the portal-lead
// forwarding address + honest status per connection (including "wired,
// awaiting vendor partner verification" where that's the truth).

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveWriteContext } from "@/lib/kernel/identity"

// TENANT ADMIN GATE (kept inline, tenant credentials — deliberately no team_lead):
// 'superadmin' removed — dead as users.user_type (0 live rows); broker_owner
// added — storable seat that owns the brokerage.
const ADMIN_TYPES = new Set(["broker", "broker_owner", "broker_admin", "admin"])

import { TENANT_CONNECTION_SLOTS } from "@/lib/settings/tenant-connection-slots"

async function requireAdmin() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return null
  if (!ADMIN_TYPES.has(ctx.userType ?? "")) return null
  return ctx
}

export async function saveTenantConnectionAction(input: {
  platform: string
  apiKey?: string
  apiUrl?: string
  accountId?: string
}): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireAdmin()
  if (!ctx) return { ok: false, error: "Unauthorized" }
  const slot = TENANT_CONNECTION_SLOTS.find((s) => s.key === input.platform)
  if (!slot) return { ok: false, error: "Unknown connection" }
  const apiKey = input.apiKey?.trim()
  if (!apiKey || apiKey.length < 6) return { ok: false, error: "A valid key/credential is required" }

  const svc = createServiceClient()
  const { data: existing } = await svc.from("platform_credentials").select("id")
    .eq("brokerage_id", ctx.brokerageId).eq("platform", input.platform).maybeSingle()
  const row = {
    brokerage_id: ctx.brokerageId, platform: input.platform,
    api_key: apiKey, api_url: input.apiUrl?.trim() || null, account_id: input.accountId?.trim() || null,
    owner_type: "brokerage", owner_id: ctx.brokerageId, is_active: true,
  }
  const { error } = existing
    ? await svc.from("platform_credentials").update(row).eq("id", (existing as any).id)
    : await svc.from("platform_credentials").insert(row)
  return error ? { ok: false, error: error.message } : { ok: true }
}

export interface TenantConnectionStatus {
  key: string
  label: string
  note: string
  fields: readonly string[]
  connected: boolean
}

export async function getTenantConnectionsAction(): Promise<{
  ok: boolean
  connections: TenantConnectionStatus[]
  /** Portal-lead intake: recent counts per portal (proof the forwarding works). */
  portalLeads: Array<{ portal: string; last30d: number }>
}> {
  const ctx = await requireAdmin()
  if (!ctx) return { ok: false, connections: [], portalLeads: [] }
  const svc = createServiceClient()
  const { data: creds } = await svc.from("platform_credentials").select("platform")
    .eq("brokerage_id", ctx.brokerageId)
    .in("platform", TENANT_CONNECTION_SLOTS.map((s) => s.key)).eq("is_active", true)
  const connectedSet = new Set(((creds ?? []) as any[]).map((c) => c.platform))

  // Portal leads land as CONTACTS assigned to the receiving agent (owner's
  // rule) — count by consent provenance (portal_inquiry:<portal>).
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const { data: portalContacts } = await svc.from("contacts").select("tcpa_consent_source")
    .eq("brokerage_id", ctx.brokerageId).like("tcpa_consent_source", "portal_inquiry:%")
    .gte("created_at", since).limit(1000)
  const counts = new Map<string, number>()
  for (const r of (portalContacts ?? []) as any[]) {
    const p = String(r.tcpa_consent_source ?? "").split(":")[1] || "unknown"
    counts.set(p, (counts.get(p) ?? 0) + 1)
  }

  return {
    ok: true,
    connections: TENANT_CONNECTION_SLOTS.map((s) => ({
      key: s.key, label: s.label, note: s.note, fields: s.fields, connected: connectedSet.has(s.key),
    })),
    portalLeads: [...counts.entries()].map(([portal, last30d]) => ({ portal, last30d })),
  }
}

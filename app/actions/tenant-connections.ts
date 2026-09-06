"use server"

// app/actions/tenant-connections.ts — TENANT-FINISHED vendor connections.
// The brokerage holds the vendor relationship (their MLS board, their ListHub
// account, their ShowingTime subscription, their portal lead sources); the
// platform provides the rail: a credential slot per vendor + the portal-lead
// forwarding address + honest status per connection (including "wired,
// awaiting vendor partner verification" where that's the truth).

import { createServiceClient } from "@/lib/supabase/service"
// ★ ACT-AS SEAM — TWO ENTRY POINTS, ONE GATE ★ resolveActingContext for the
// read, resolveWriteContext for the credential write. See requireAdmin below.
import { resolveActingContext, resolveWriteContext } from "@/lib/platform/acting-context"

// TENANT ADMIN GATE (kept inline, tenant credentials — deliberately no team_lead):
// 'superadmin' removed — dead as users.user_type (0 live rows); broker_owner
// added — storable seat that owns the brokerage.
const ADMIN_TYPES = new Set(["broker", "broker_owner", "broker_admin", "admin"])

import { TENANT_CONNECTION_SLOTS } from "@/lib/settings/tenant-connection-slots"

/**
 * ONE gate, TWO channels (§6).
 *
 * WHY `mode` EXISTS. The act-as merge routed BOTH exports through the WRITE
 * entry point, which refuses a 'read_only' impersonation grant. That is right for
 * saveTenantConnectionAction (it stores a tenant's vendor credential) and wrong
 * for getTenantConnectionsAction, which only reports which slots are filled and
 * how many portal leads arrived. §5: a grant walks the account and never exceeds
 * it — a read-only support session that cannot SEE the connection status is not
 * walking the account.
 *
 * NOTHING IS WIDENED: resolveActingContext hands back the same service client
 * under an active grant, and ADMIN_TYPES is evaluated on the same impersonated
 * identity. The read path admits exactly one extra caller class (read_only) and
 * no extra tenant, table or column.
 *
 * TOMBSTONE (§1.3) — the `createClient()` + `auth.getUser()` pre-check that
 * stood at the top of this gate is removed, not lost: both entry points resolve
 * through getAgentContext and return ok:false for an unauthenticated caller
 * (lib/platform/acting-context.ts:141 and :212), so the extra cookie-client
 * round trip asked a question the seam had already answered — and asked it about
 * the STAFF user rather than the acting identity.
 */
async function requireAdmin(
  mode: "read" | "write",
): Promise<{ brokerageId: string; userId: string } | null> {
  const ctx = mode === "write" ? await resolveWriteContext() : await resolveActingContext()
  if (!ctx.ok) return null
  if (!ctx.brokerageId) return null
  if (!ADMIN_TYPES.has(ctx.userType ?? "")) return null
  return { brokerageId: ctx.brokerageId, userId: ctx.userId }
}

export async function saveTenantConnectionAction(input: {
  platform: string
  apiKey?: string
  apiUrl?: string
  accountId?: string
}): Promise<{ ok: boolean; error?: string }> {
  // WRITE — stores a tenant vendor credential. read_only refused in the gate.
  const ctx = await requireAdmin("write")
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
  // READ — slot status + portal-lead counts. A read_only grant may see them (§5).
  const ctx = await requireAdmin("read")
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

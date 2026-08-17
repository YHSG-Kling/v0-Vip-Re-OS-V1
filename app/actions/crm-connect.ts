"use server"

// CRM connect + manual "Sync now" for the user-connected CRM sync-OUT providers
// (GoHighLevel, Lofty, Follow Up Boss). SYNC-OUT ONLY — the app pushes contact updates
// out; no CRM syncs back IN.
//
// ALL TIERS may connect their own stack: a solo agent (even inside a brokerage/team) can
// wire their PERSONAL CRM (stored agent-scoped in agent_api_credentials), while a
// broker/owner/admin wires the BROKERAGE-wide CRM (integration_credentials +
// brokerage_integrations). The sync layer (lib/crm/sync.ts) prefers the agent's own CRM
// when present, else the brokerage default.

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { getAgentContext } from "@/lib/identity"
import { syncContactToCRM } from "@/lib/crm/sync"
import { INTEGRATION_STATUS_CONNECTED, INTEGRATION_STATUS_NOT_CONFIGURED } from "@/lib/integrations/integration-status"

export type CrmProvider = "gohighlevel" | "lofty" | "followupboss"
const CRM_PROVIDERS: CrmProvider[] = ["gohighlevel", "lofty", "followupboss"]

// Roles that manage the BROKERAGE-wide CRM. Everyone else (agents) manages their OWN.
// SCOPE LADDER (kept inline — this array decides WHERE credentials are scoped,
// so widening it moves seats across scopes): 'superadmin' removed — dead as
// users.user_type (0 live rows store it).
const BROKERAGE_ROLES = ["admin", "broker", "broker_owner"]

interface Member {
  userId: string
  agentId: string | null
  brokerageId: string
  userType: string
  /** true → store/resolve creds agent-scoped (solo agent's own stack). */
  agentScoped: boolean
}

async function requireMember(): Promise<{ ok: true; member: Member } | { ok: false; error: string }> {
  const ctx = await getAgentContext().catch(() => null)
  if (!ctx?.isAuthenticated) return { ok: false, error: "Unauthenticated" }
  if (!ctx.brokerageId) return { ok: false, error: "No brokerage" }
  const agentScoped = !BROKERAGE_ROLES.includes(ctx.userType) && !!ctx.agentId
  return {
    ok: true,
    member: { userId: ctx.userId, agentId: ctx.agentId, brokerageId: ctx.brokerageId, userType: ctx.userType, agentScoped },
  }
}

/** Connect (or update) a CRM by API key, and make it the active CRM for the caller's scope. */
export async function connectCrmAction(params: {
  provider: CrmProvider
  apiKey: string
  apiUrl?: string
}): Promise<{ ok: true; scope: "agent" | "brokerage" } | { ok: false; error: string }> {
  if (!CRM_PROVIDERS.includes(params.provider)) return { ok: false, error: "Unknown CRM provider" }
  if (!params.apiKey?.trim()) return { ok: false, error: "API key is required" }
  const gate = await requireMember()
  if (!gate.ok) return gate
  const { member } = gate
  const supabase = await createClient()

  if (member.agentScoped) {
    // Agent's OWN CRM — agent-scoped credential. resolveConnection reads this first.
    const { error } = await supabase
      .from("agent_api_credentials")
      .upsert(
        {
          agent_id: member.agentId,
          brokerage_id: member.brokerageId,
          service_name: params.provider,
          service_type: "crm_sync",
          api_key: params.apiKey.trim(),
          config: params.apiUrl?.trim() ? { apiUrl: params.apiUrl.trim() } : {},
          is_active: true,
        },
        { onConflict: "agent_id,service_name" },
      )
    if (error) return { ok: false, error: error.message }
    revalidatePath("/settings/crm")
    return { ok: true, scope: "agent" }
  }

  // Brokerage-wide CRM (broker/owner/admin).
  const { error: credErr } = await supabase
    .from("integration_credentials")
    .upsert(
      {
        brokerage_id: member.brokerageId,
        provider_name: params.provider,
        api_key: params.apiKey.trim(),
        webhook_url: params.apiUrl?.trim() || null,
        is_active: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "brokerage_id,provider_name" },
    )
  if (credErr) return { ok: false, error: credErr.message }

  const { error: intErr } = await supabase
    .from("brokerage_integrations")
    .upsert(
      // brokerage_integrations.status ∈ (connected, error, not_configured).
      // This wrote 'active', which the CHECK rejects — so the credential landed
      // and the integration row did not, and the caller saw a failed connect.
      { brokerage_id: member.brokerageId, provider_type: "crm", provider_name: params.provider, status: INTEGRATION_STATUS_CONNECTED, metadata: { configured_by: member.userId } },
      { onConflict: "brokerage_id,provider_name" },
    )
  if (intErr) return { ok: false, error: intErr.message }

  revalidatePath("/settings/crm")
  return { ok: true, scope: "brokerage" }
}

/** Disconnect a CRM in the caller's scope (deactivate its credential). */
export async function disconnectCrmAction(provider: CrmProvider): Promise<{ ok: true } | { ok: false; error: string }> {
  const gate = await requireMember()
  if (!gate.ok) return gate
  const { member } = gate
  const supabase = await createClient()

  if (member.agentScoped) {
    await supabase.from("agent_api_credentials").update({ is_active: false }).eq("agent_id", member.agentId).eq("service_name", provider)
  } else {
    await supabase.from("integration_credentials").update({ is_active: false }).eq("brokerage_id", member.brokerageId).eq("provider_name", provider)
    await supabase.from("brokerage_integrations").update({ status: INTEGRATION_STATUS_NOT_CONFIGURED }).eq("brokerage_id", member.brokerageId).eq("provider_name", provider)
  }
  revalidatePath("/settings/crm")
  return { ok: true }
}

/** Manually sync a single contact OUT to the resolved CRM (the "Sync now" button). */
export async function syncContactNowAction(contactId: string): Promise<
  { ok: true; providerKey: string; action?: string; contactId?: string } | { ok: false; error: string }
> {
  const gate = await requireMember()
  if (!gate.ok) return gate
  const { member } = gate
  const supabase = await createClient()
  const { data: contact, error } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, email, phone, brokerage_id")
    .eq("id", contactId)
    .eq("brokerage_id", member.brokerageId)
    .maybeSingle()
  if (error || !contact) return { ok: false, error: "Contact not found in your brokerage" }

  const result = await syncContactToCRM({
    firstName: contact.first_name ?? "",
    lastName: contact.last_name ?? "",
    email: contact.email ?? undefined,
    phone: contact.phone ?? undefined,
    source: "manual-sync",
    brokerageId: member.brokerageId,
    agentId: member.agentId ?? undefined,
  })
  if (!result.success) {
    return { ok: false, error: result.requiresConfiguration ? `${result.providerKey} is not connected` : (result.error ?? "Sync failed") }
  }

  // Manager ownership: the manual push is a DATA STEWARD operation (CRM/identity
  // stewardship). Announce it on the bus to the Sphere Manager (lifetime-relationship
  // owner) so the Command Center feed shows the record was mirrored — feed-only,
  // idempotent per contact. Best-effort: a bus hiccup never fails the sync itself.
  // (Only the MANUAL sync surfaces here; the autonomous per-update sync stays silent.)
  try {
    const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
    const name = [contact.first_name, contact.last_name].filter(Boolean).join(" ").trim() || "a contact"
    await publishManagerSignal({
      brokerageId: member.brokerageId,
      fromManager: "data_steward",
      toManager: "sphere_of_influence",
      signalType: "contact_crm_synced",
      message: `Data Steward mirrored ${name} to ${result.providerKey} (manual sync-out).`,
      entityType: "contact",
      entityId: contact.id,
      contactId: contact.id,
      payload: { providerKey: result.providerKey, action: result.action ?? null, trigger: "manual-sync" },
    })
  } catch { /* the CRM push already succeeded — the feed announcement is best-effort */ }

  return { ok: true, providerKey: result.providerKey, action: result.action, contactId: result.contactId }
}

/** Which CRM is connected/active in the caller's scope. */
export async function getCrmStatusAction(): Promise<
  { ok: true; scope: "agent" | "brokerage"; active: string | null; connected: CrmProvider[] } | { ok: false; error: string }
> {
  const gate = await requireMember()
  if (!gate.ok) return gate
  const { member } = gate
  const supabase = await createClient()

  if (member.agentScoped) {
    const { data } = await supabase
      .from("agent_api_credentials")
      .select("service_name, is_active")
      .eq("agent_id", member.agentId)
      .eq("service_type", "crm_sync")
      .in("service_name", CRM_PROVIDERS)
    const connected = (data ?? []).filter((c) => c.is_active).map((c) => c.service_name as CrmProvider)
    return { ok: true, scope: "agent", active: connected[0] ?? null, connected }
  }

  const { data: creds } = await supabase
    .from("integration_credentials")
    .select("provider_name, is_active")
    .eq("brokerage_id", member.brokerageId)
    .in("provider_name", CRM_PROVIDERS)
  const { data: active } = await supabase
    .from("brokerage_integrations")
    .select("provider_name, status")
    .eq("brokerage_id", member.brokerageId)
    .eq("provider_type", "crm")
    .eq("status", INTEGRATION_STATUS_CONNECTED)
    .maybeSingle()
  const connected = (creds ?? []).filter((c) => c.is_active).map((c) => c.provider_name as CrmProvider)
  return { ok: true, scope: "brokerage", active: active?.provider_name ?? null, connected }
}

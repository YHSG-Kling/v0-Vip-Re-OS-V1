/**
 * CRM SYNC LAYER
 * lib/crm/sync.ts
 *
 * Single entry point for syncing a contact to the configured CRM provider.
 * Provider cascade: brokerage_integrations (provider_type = 'crm') → system default (ghl).
 * Call this in contacts.ts and lead-lifecycle.ts; never call goHighLevelService directly
 * from feature code outside this module.
 */

import { createClient } from "@/lib/supabase/server"
import { syncContactToGHL } from "@/services/goHighLevelService"
import { resolveScopedConnection } from "@/lib/connections/resolve-scoped"
import { syncContactToFollowUpBoss } from "@/lib/crm/providers/followupboss"
import { syncContactToLofty } from "@/lib/crm/providers/lofty"
import { syncContactToHubSpot } from "@/lib/crm/providers/hubspot"

export interface CRMContactPayload {
  firstName: string
  lastName: string
  email?: string
  phone?: string
  tags?: string[]
  source?: string
  brokerageId: string
  agentId?: string
}

export interface CRMSyncResult {
  success: boolean
  contactId?: string
  action?: "created" | "updated" | "skipped"
  providerKey: string
  error?: string
  requiresConfiguration?: boolean
}

/**
 * Resolves the active CRM provider for a brokerage, then syncs the contact.
 * Falls through gracefully if no CRM is configured — never throws.
 */
export async function syncContactToCRM(
  payload: CRMContactPayload,
): Promise<CRMSyncResult> {
  const { brokerageId } = payload

  // ── EGRESS GATE (good data out): a contact with no name or no reachable
  // identifier is junk in a third party's system — the send is REFUSED and
  // ledgered, never pushed. The OS's outbound maps stay clean by CI, not hope.
  try {
    const { validateEgress, CRM_CONTACT_EGRESS_CONTRACT } = await import("@/lib/kernel/schema-adaptation")
    const verdict = validateEgress(CRM_CONTACT_EGRESS_CONTRACT, payload, [["email", "phone"]])
    if (!verdict.ok) {
      const { createServiceClient } = await import("@/lib/supabase/service")
      const { recordSelfHeal } = await import("@/lib/kernel/self-heal-ledger")
      await recordSelfHeal(createServiceClient() as any, {
        brokerageId, domain: "data_flow",
        subject: `crm:${payload.email ?? payload.phone ?? payload.lastName ?? "unknown"}`,
        action: "none", outcome: "escalated",
        detail: { flow: "egress_rejected", connector: "crm", missing: verdict.missing, reason: "outbound CRM push refused — the payload is missing the identity a third-party map needs" },
      })
      return { success: false, providerKey: "egress_gate", error: `Push refused — missing: ${verdict.missing.join(", ")}` }
    }
  } catch { /* the gate is best-effort; a gate error never blocks a valid sync */ }

  // ── Resolve active CRM provider: the AGENT's own CRM first (per-agent stack), then the
  //    brokerage default (brokerage_integrations), then the system default. ───────────────
  let providerKey = "ghl" // system default

  try {
    const supabase = await createClient()

    if (payload.agentId) {
      const { data: agentCrm } = await supabase
        .from("agent_api_credentials")
        .select("service_name")
        .eq("agent_id", payload.agentId)
        .eq("service_type", "crm_sync")
        .eq("is_active", true)
        .limit(1)
        .maybeSingle()
      if (agentCrm?.service_name) providerKey = agentCrm.service_name
    }

    if (providerKey === "ghl") {
      const { data: integration } = await supabase
        .from("brokerage_integrations")
        .select("provider_name, status")
        .eq("brokerage_id", brokerageId)
        .eq("provider_type", "crm")
        .eq("status", "active")
        .maybeSingle()
      if (integration?.provider_name) {
        providerKey = integration.provider_name
      }
    }

    // Owner-scoped connection (the per-tier Connection Center writes CRM creds to
    // platform_credentials by owner scope). Detect a CRM provider connected at the AGENT's own
    // scope first, then the brokerage's, so a Connection-Center CRM selection is honored. Only
    // applies when nothing more specific was selected above.
    if (providerKey === "ghl") {
      const crmPlatforms = ["gohighlevel", "ghl", "followupboss", "lofty", "hubspot"]
      let userId: string | null = null
      if (payload.agentId) {
        const { data: agentRow } = await supabase.from("agents").select("user_id").eq("id", payload.agentId).maybeSingle()
        userId = (agentRow?.user_id as string | null) ?? null
      }
      const owners: Array<{ ownerType: string; ownerId: string }> = []
      if (userId) owners.push({ ownerType: "agent", ownerId: userId })
      owners.push({ ownerType: "brokerage", ownerId: brokerageId })
      for (const owner of owners) {
        const { data: scopedCrm } = await supabase
          .from("platform_credentials")
          .select("platform")
          .eq("owner_type", owner.ownerType)
          .eq("owner_id", owner.ownerId)
          .in("platform", crmPlatforms)
          .eq("is_active", true)
          .limit(1)
          .maybeSingle()
        if (scopedCrm?.platform) {
          providerKey = scopedCrm.platform === "gohighlevel" ? "ghl" : scopedCrm.platform
          break
        }
      }
    }
  } catch {
    // Non-blocking — fall through to system default
  }

  // Normalize the GoHighLevel alias so a brokerage_integrations.provider_name of "gohighlevel"
  // (vs the literal "ghl") still dispatches to the GHL path instead of "unsupported".
  if (providerKey === "gohighlevel") providerKey = "ghl"

  // ── Dispatch to the resolved provider ────────────────────────────────────────
  if (providerKey === "ghl") {
    try {
      // Resolve the TENANT's own GHL credential through the unified cascade
      // (agent → team → brokerage → platform_credentials, legacy fallback), so a
      // GHL connected via the Connection Center or /settings/crm dispatches with
      // the tenant's key + locationId instead of only the platform env credential.
      let ghlOverride: { apiKey: string; locationId: string } | undefined
      try {
        let agentUserId: string | null = null
        if (payload.agentId) {
          const supabase = await createClient()
          const { data: agentRow } = await supabase.from("agents").select("user_id").eq("id", payload.agentId).maybeSingle()
          agentUserId = (agentRow?.user_id as string | null) ?? null
        }
        const conn = await resolveScopedConnection("ghl", { agentUserId, brokerageId, agentId: payload.agentId }).catch(() => null)
        const locationId =
          conn?.accountId ??
          (conn?.config?.locationId as string | undefined) ??
          (conn?.config?.location_id as string | undefined) ??
          null
        if (conn?.apiKey && locationId) {
          ghlOverride = { apiKey: conn.apiKey, locationId }
        }
      } catch { /* fall back to the platform env credential */ }

      const result = await syncContactToGHL({
        firstName: payload.firstName,
        lastName: payload.lastName,
        email: payload.email,
        phone: payload.phone,
        tags: payload.tags ?? [],
        source: payload.source ?? "kernel",
      }, ghlOverride)

      if (result.requiresConfiguration) {
        // GHL not configured — soft failure, do not block the caller
        return { success: false, providerKey, requiresConfiguration: true, error: result.error }
      }

      return {
        success: result.success,
        contactId: result.contactId,
        action: result.action as "created" | "updated" | undefined,
        providerKey,
        error: result.error,
      }
    } catch (err: any) {
      return { success: false, providerKey, error: err?.message ?? "GHL sync failed" }
    }
  }

  // ── Follow Up Boss + Lofty + HubSpot — sync-OUT via the connector-gateway ─────
  if (providerKey === "followupboss" || providerKey === "lofty" || providerKey === "hubspot") {
    // Credential via the unified owner cascade (agent → team → brokerage → platform, legacy
    // fallback preserved) so a Connection-Center CRM connection at any scope is honored.
    let agentUserId: string | null = null
    if (payload.agentId) {
      const supabase = await createClient()
      const { data: agentRow } = await supabase.from("agents").select("user_id").eq("id", payload.agentId).maybeSingle()
      agentUserId = (agentRow?.user_id as string | null) ?? null
    }
    const conn = await resolveScopedConnection(providerKey, { agentUserId, brokerageId, agentId: payload.agentId }).catch(() => null)
    const contact = {
      firstName: payload.firstName,
      lastName: payload.lastName,
      email: payload.email,
      phone: payload.phone,
      source: payload.source ?? "kernel",
      tags: payload.tags ?? [],
    }
    const result =
      providerKey === "followupboss"
        ? await syncContactToFollowUpBoss(contact, conn?.apiKey ?? null)
        : providerKey === "hubspot"
          ? await syncContactToHubSpot(contact, conn?.apiKey ?? null)
          : await syncContactToLofty(contact, conn?.apiKey ?? null, conn?.apiUrl ?? null)
    return {
      success: result.success,
      contactId: result.contactId,
      action: result.action,
      providerKey,
      error: result.error,
      requiresConfiguration: result.requiresConfiguration,
    }
  }

  // Future CRM providers (Salesforce, etc.) go here
  return {
    success: false,
    providerKey,
    error: `CRM provider "${providerKey}" is not yet supported in the sync layer.`,
  }
}

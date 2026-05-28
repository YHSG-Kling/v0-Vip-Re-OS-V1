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
      const crmPlatforms = ["gohighlevel", "ghl", "followupboss", "lofty"]
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

  // ── Dispatch to the resolved provider ────────────────────────────────────────
  if (providerKey === "ghl") {
    try {
      const result = await syncContactToGHL({
        firstName: payload.firstName,
        lastName: payload.lastName,
        email: payload.email,
        phone: payload.phone,
        tags: payload.tags ?? [],
        source: payload.source ?? "kernel",
      })

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

  // ── Lofty + Follow Up Boss — sync-OUT via the connector-gateway ──────────────
  if (providerKey === "followupboss" || providerKey === "lofty") {
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

  // Future CRM providers (HubSpot, Salesforce, etc.) go here
  return {
    success: false,
    providerKey,
    error: `CRM provider "${providerKey}" is not yet supported in the sync layer.`,
  }
}

// lib/connections/resolve-scoped.ts
// THE unified connection resolver. Walks the ownership cascade (agent → team → brokerage →
// platform, or vendor/contact → platform) and returns the first active credential, reading
// platform_credentials by the new (owner_type, owner_id) scope. Falls back to the legacy
// connection-manager (agent_api_credentials / integration_credentials / agent+brokerage
// platform_credentials) so it works BEFORE and AFTER the m102 owner-scope migration.
//
// Migration-safe: the owner_type/owner_id read is wrapped — if those columns don't exist yet
// (migration not applied) the error is swallowed and resolution falls through to the legacy
// path, so nothing breaks pre-migration.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { canonicalProvider, aliasesFor, resolveConnection, type ResolvedConnection } from "@/lib/integrations/connection-manager"
import { scopeCascade, type ScopeContext, type ConnectionScope } from "./scope"

export interface ScopedConnection extends ResolvedConnection {
  ownerType: ConnectionScope
  ownerId: string
}

/** Read one owner's active credential for a provider from platform_credentials by owner scope.
 *  Returns null on no row OR if the owner_type column doesn't exist yet (pre-migration). */
async function readOwnerCredential(
  ownerType: ConnectionScope,
  ownerId: string,
  provider: string,
): Promise<ScopedConnection | null> {
  try {
    const svc = createServiceClient()
    const { data, error } = await svc
      .from("platform_credentials")
      .select("id, platform, api_key, access_token, refresh_token, account_id, account_name, api_url, config, is_active")
      .eq("owner_type", ownerType)
      .eq("owner_id", ownerId)
      .in("platform", aliasesFor(provider))
      .eq("is_active", true)
      .order("last_tested_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle()
    if (error || !data) return null
    return {
      provider: canonicalProvider(data.platform),
      source: "platform_credentials",
      scope: ownerType === "agent" ? "agent" : "brokerage",
      credentialId: data.id,
      apiKey: data.api_key ?? null,
      apiSecret: null,
      accessToken: data.access_token ?? null,
      refreshToken: data.refresh_token ?? null,
      accountId: data.account_id ?? null,
      accountName: data.account_name ?? null,
      apiUrl: data.api_url ?? null,
      config: (data.config as Record<string, unknown>) ?? {},
      isActive: true,
      ownerType,
      ownerId,
    }
  } catch {
    return null // column missing (pre-migration) or transient — fall through to legacy
  }
}

/**
 * Resolve a provider connection for an actor across the full ownership cascade. Most-specific
 * owner wins. Never throws — returns null when nothing is connected at any scope.
 */
export async function resolveScopedConnection(
  provider: string,
  ctx: ScopeContext & { agentId?: string | null },
): Promise<ScopedConnection | null> {
  // 1. New owner-scope cascade (agent → team → brokerage → platform, or vendor/contact → platform).
  for (const owner of scopeCascade(ctx)) {
    const hit = await readOwnerCredential(owner.ownerType, owner.ownerId, provider)
    if (hit) return hit
  }

  // 2. Legacy fallback — connection-manager (agent_api_credentials + brokerage stores). This
  //    keeps every existing connection working until m102 backfill + writes are in place.
  if (ctx.brokerageId) {
    const legacy = await resolveConnection({
      brokerageId: ctx.brokerageId,
      provider,
      agentUserId: ctx.agentUserId ?? undefined,
      agentId: ctx.agentId ?? undefined,
    }).catch(() => null)
    if (legacy) {
      const ownerType: ConnectionScope = legacy.scope === "agent" ? "agent" : "brokerage"
      const ownerId = ownerType === "agent" ? (ctx.agentUserId ?? "") : ctx.brokerageId
      return { ...legacy, ownerType, ownerId }
    }
  }

  return null
}

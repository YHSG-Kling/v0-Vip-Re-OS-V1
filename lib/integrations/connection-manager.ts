/**
 * Connection Manager — read-layer unifier for external provider connections.
 *
 * The platform stores third-party credentials across THREE tables that grew
 * independently and disagree on provider naming:
 *
 *   - platform_credentials   (brokerage/agent scope; OAuth + api_key; canonical
 *                             names like "idxbroker", "docusign", "gmail")
 *   - integration_credentials(brokerage scope; provider_name like "idx_broker",
 *                             "rentcast", "gohighlevel")
 *   - agent_api_credentials  (per-agent; service_name like "idx_broker", socials)
 *
 * This module does NOT migrate data. It provides one canonical naming scheme and
 * a single resolver that reads across all three tables in a defined precedence,
 * returning one normalized shape so dispatch-time callers (crons, webhooks,
 * server actions, provider clients) stop guessing which table/name to use.
 *
 * Precedence (most specific → least): agent_api_credentials → platform_credentials
 * (agent scope) → platform_credentials (brokerage scope) → integration_credentials.
 */

import { createServiceClient } from "@/lib/supabase/service"

/** canonical name → every alias that appears in any table for the same provider. */
const PROVIDER_ALIASES: Record<string, string[]> = {
  idxbroker:      ["idxbroker", "idx_broker", "idx"],
  gmail:          ["gmail", "google"],
  outlook:        ["outlook", "microsoft"],
  formsimplicity: ["formsimplicity", "form_simplicity"],
  brokermint:     ["brokermint", "broker_mint"],
  gohighlevel:    ["gohighlevel", "ghl"],
  realtor_com:    ["realtor_com", "realtorcom", "realtor.com"],
}

/** Normalize any provider string (from any table or UI) to its canonical name. */
export function canonicalProvider(name: string): string {
  const lc = (name ?? "").trim().toLowerCase()
  for (const [canon, aliases] of Object.entries(PROVIDER_ALIASES)) {
    if (aliases.includes(lc)) return canon
  }
  return lc
}

/** Every name a provider may be stored under, for cross-table `.in()` matching. */
export function aliasesFor(name: string): string[] {
  const canon = canonicalProvider(name)
  return PROVIDER_ALIASES[canon] ?? [canon]
}

export type ConnectionSource = "platform_credentials" | "integration_credentials" | "agent_api_credentials"

export interface ResolvedConnection {
  /** Canonical provider name. */
  provider: string
  source: ConnectionSource
  scope: "agent" | "brokerage"
  credentialId: string
  apiKey: string | null
  apiSecret: string | null
  accessToken: string | null
  refreshToken: string | null
  accountId: string | null
  accountName: string | null
  apiUrl: string | null
  config: Record<string, unknown>
  isActive: boolean
  /**
   * OAuth token expiry (ISO-8601) when the store carries one, else null.
   *
   * Selected so a CALLER can ask the connectivity agent whether a live
   * connection is about to lapse (deriveConnectivityStatus). Without it every
   * consumer saw only "connected / not connected" and an expiring token was
   * indistinguishable from a healthy one until the day it stopped working.
   */
  tokenExpiresAt: string | null
}

export interface ResolveConnectionInput {
  brokerageId: string
  provider: string
  /** users.id — used for platform_credentials agent-scoped rows. */
  agentUserId?: string
  /** agents.id — used for agent_api_credentials rows. */
  agentId?: string
}

/**
 * Resolve a single provider connection for a brokerage (optionally agent-scoped),
 * reading across all three credential tables. Returns null if none is active.
 */
export async function resolveConnection(
  input: ResolveConnectionInput
): Promise<ResolvedConnection | null> {
  const svc = createServiceClient()
  const canon = canonicalProvider(input.provider)
  const aliases = aliasesFor(canon)

  // 1. agent_api_credentials (per-agent, most specific)
  if (input.agentId) {
    const { data } = await svc
      .from("agent_api_credentials")
      .select("id, api_key, api_secret, access_token, refresh_token, config, is_active, token_expires_at")
      .eq("agent_id", input.agentId)
      .in("service_name", aliases)
      .eq("is_active", true)
      .limit(1)
      .maybeSingle()
    if (data) {
      return {
        provider: canon, source: "agent_api_credentials", scope: "agent", credentialId: data.id,
        apiKey: data.api_key ?? null, apiSecret: data.api_secret ?? null,
        accessToken: data.access_token ?? null, refreshToken: data.refresh_token ?? null,
        accountId: null, accountName: null, apiUrl: null,
        config: (data.config as Record<string, unknown>) ?? {}, isActive: true,
        tokenExpiresAt: data.token_expires_at ?? null,
      }
    }
  }

  // 2 + 3. platform_credentials — agent scope first, then brokerage scope.
  for (const scope of ["agent", "brokerage"] as const) {
    if (scope === "agent" && !input.agentUserId) continue
    let q = svc
      .from("platform_credentials")
      .select("id, api_key, access_token, refresh_token, account_id, account_name, api_url, config, is_active, token_expires_at")
      .eq("brokerage_id", input.brokerageId)
      .in("platform", aliases)
      .eq("scope", scope)
      .eq("is_active", true)
    if (scope === "agent") q = q.eq("agent_user_id", input.agentUserId!)
    const { data } = await q.limit(1).maybeSingle()
    if (data) {
      return {
        provider: canon, source: "platform_credentials", scope, credentialId: data.id,
        apiKey: data.api_key ?? null, apiSecret: null,
        accessToken: data.access_token ?? null, refreshToken: data.refresh_token ?? null,
        accountId: data.account_id ?? null, accountName: data.account_name ?? null,
        apiUrl: data.api_url ?? null,
        config: (data.config as Record<string, unknown>) ?? {}, isActive: true,
        tokenExpiresAt: data.token_expires_at ?? null,
      }
    }
  }

  // 4. integration_credentials (brokerage-wide, simplest shape)
  const { data } = await svc
    .from("integration_credentials")
    .select("id, api_key, api_secret, webhook_url, is_active")
    .eq("brokerage_id", input.brokerageId)
    .in("provider_name", aliases)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle()
  if (data) {
    return {
      provider: canon, source: "integration_credentials", scope: "brokerage", credentialId: data.id,
      apiKey: data.api_key ?? null, apiSecret: data.api_secret ?? null,
      accessToken: null, refreshToken: null, accountId: null, accountName: null,
      apiUrl: data.webhook_url ?? null,
      config: {}, isActive: true,
      // integration_credentials carries no expiry column — a static key store.
      tokenExpiresAt: null,
    }
  }

  return null
}

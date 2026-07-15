// lib/agentic-os/resolve-connectivity.ts
// Server side of the Connectivity API Agent. Reads the three credential stores the app
// grew (agent_api_credentials, platform_credentials, integration_credentials), canonicalizes
// provider names (connection-manager), and produces a live connectivity report for a
// brokerage: per-connector health (api_key/oauth, expiry-aware), per-capability coverage
// (which user-connected capabilities are usable vs blocked on a missing connection), and
// the platform-managed vendor surface (the platform's keys, always up from the brokerage's
// view). The pure derivation/summarization lives in connectivity-agent.ts.

import { createServiceClient } from "@/lib/supabase/service"
import { canonicalProvider } from "@/lib/integrations/connection-manager"
import { CONNECTED_CAPABILITY_REGISTRY, type ConnectedCapability } from "./connected-vendor-registry"
import { PLATFORM_VENDORS } from "./vendor-ownership"
import {
  deriveConnectivityStatus,
  needsAttention,
  summarizeConnectivity,
  transportFor,
  type ConnectorHealth,
  type ConnectivitySummary,
} from "./connectivity-agent"

interface CredRow {
  isActive: boolean
  tokenExpiresAt: string | null
  source: "agent_api_credentials" | "platform_credentials" | "integration_credentials"
}

export interface CapabilityCoverage {
  capability: ConnectedCapability
  connected: boolean
  connectedProvider: string | null
  missing: string[]
}

export interface ConnectivityReport {
  brokerageId: string | null
  generatedAt: string
  /** User-connected providers the brokerage wires up — each with live health. */
  connectors: ConnectorHealth[]
  /** Which user-connected capabilities are usable right now vs blocked on a connection. */
  capabilities: CapabilityCoverage[]
  /** Platform-owned vendors (platform holds the key) — informational, always up. */
  platformManaged: ConnectorHealth[]
  summary: ConnectivitySummary
}

/** Every distinct canonical provider any user-connected capability can route to. */
function allConnectedProviders(): string[] {
  return [...new Set(Object.values(CONNECTED_CAPABILITY_REGISTRY).flatMap((d) => d.connections))]
}

/**
 * Scan a brokerage's live connector fleet. Reads across the three credential stores with
 * agent → platform → integration precedence (most specific wins). Never throws — a store
 * read failure simply leaves those connectors reading as disconnected.
 */
export async function scanConnectivity(ctx: {
  brokerageId: string | null
  /** OWNER FIX: connections exist at brokerage/team/agent scope. When set, the
   *  AGENT-owned credential store (agent_api_credentials) is filtered to THIS
   *  agent — so an agent sees THEIR own connections, not the brokerage pool.
   *  Omit for the broker/brokerage-wide view (agent pool + platform + integration). */
  agentId?: string | null
  now?: Date
}): Promise<ConnectivityReport> {
  const now = ctx.now ?? new Date()
  const map = new Map<string, CredRow>()

  if (ctx.brokerageId) {
    const svc = createServiceClient()
    // Precedence: insert agent first, then platform, then integration — keep the first seen.
    const setOnce = (provider: string, row: CredRow) => {
      const canon = canonicalProvider(provider)
      if (!map.has(canon)) map.set(canon, row)
    }
    try {
      let q = svc
        .from("agent_api_credentials")
        .select("service_name, token_expires_at, is_active")
        .eq("brokerage_id", ctx.brokerageId)
      // Agent scope: only THIS agent's own connections (owner fix).
      if (ctx.agentId) q = q.eq("agent_id", ctx.agentId)
      const { data } = await q
      for (const r of data ?? []) {
        setOnce(r.service_name, { isActive: !!r.is_active, tokenExpiresAt: r.token_expires_at ?? null, source: "agent_api_credentials" })
      }
    } catch { /* leave unset → disconnected */ }
    try {
      const { data } = await svc
        .from("platform_credentials")
        .select("platform, token_expires_at, is_active")
        .eq("brokerage_id", ctx.brokerageId)
      for (const r of data ?? []) {
        setOnce(r.platform, { isActive: !!r.is_active, tokenExpiresAt: r.token_expires_at ?? null, source: "platform_credentials" })
      }
    } catch { /* leave unset */ }
    try {
      const { data } = await svc
        .from("integration_credentials")
        .select("provider_name, is_active")
        .eq("brokerage_id", ctx.brokerageId)
      for (const r of data ?? []) {
        setOnce(r.provider_name, { isActive: !!r.is_active, tokenExpiresAt: null, source: "integration_credentials" })
      }
    } catch { /* leave unset */ }
  }

  // Per-connector health for every provider the capabilities can route to.
  const connectors: ConnectorHealth[] = allConnectedProviders().map((provider) => {
    const row = map.get(provider)
    const transport = row?.tokenExpiresAt ? "oauth" : transportFor(provider)
    const connected = !!row && row.isActive
    const status = deriveConnectivityStatus(
      { connected, transport, isActive: row?.isActive, tokenExpiresAt: row?.tokenExpiresAt ?? null },
      now,
    )
    return {
      provider,
      transport,
      status,
      expiresAt: row?.tokenExpiresAt ?? null,
      source: row?.source ?? null,
      actionRequired: needsAttention(status),
    }
  })

  // Per-capability coverage — usable when ANY of its providers is live.
  const capabilities: CapabilityCoverage[] = (Object.keys(CONNECTED_CAPABILITY_REGISTRY) as ConnectedCapability[]).map((cap) => {
    const def = CONNECTED_CAPABILITY_REGISTRY[cap]
    const connectedProvider = def.connections.find((p) => map.get(canonicalProvider(p))?.isActive) ?? null
    return {
      capability: cap,
      connected: !!connectedProvider,
      connectedProvider,
      missing: connectedProvider ? [] : def.connections,
    }
  })

  // Platform-owned vendors — the platform holds the key; up from the brokerage's view.
  const platformManaged: ConnectorHealth[] = [...PLATFORM_VENDORS].sort().map((provider) => ({
    provider,
    transport: "platform_managed" as const,
    status: "platform_managed" as const,
    expiresAt: null,
    source: null,
    actionRequired: false,
  }))

  return {
    brokerageId: ctx.brokerageId,
    generatedAt: now.toISOString(),
    connectors,
    capabilities,
    platformManaged,
    summary: summarizeConnectivity([...connectors, ...platformManaged]),
  }
}

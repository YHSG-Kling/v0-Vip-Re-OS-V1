// lib/did/platform-live-agent.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE PLATFORM'S OWN D-ID LIVE AGENT (lane 77B, owner verbatim: "the platform
// should also offer the same ai agents like the live agent using d-id because
// the platform can use those ai agents as a demo'd product").
//
// The tenant live agent (wave 58/59) runs D-ID Express v4 on website / widget
// / portal through app/api/did/custom-llm, keyed to a TENANT by the marker the
// widget prefixes (embedSessionId / contactId). This module gives the PLATFORM
// the same agent on its own /get-started and /demo pages, on the SAME
// machinery and nothing else:
//   · the SAME D-ID Agent create/patch path and body builder (lib/did/agents.ts
//     ensureDIDAgent / syncDIDAgent, deployment "platform") over the SAME
//     gateway (lib/did/gateway.ts didRequest — the platform's own DID_API_KEY,
//     PLATFORM_PROVIDER_KEYS.did) and the SAME client-key issuance
//   · the SAME presenter-family detector (presenterTypeForTwin) — a D-ID stock
//     Expressive presenter (`name@avt_…`) resolves to the V4 family exactly
//     like a tenant twin, so the widget offers microphone + live modes honestly
//   · the SAME metering row (live_agent_sessions via lib/did/live-session-
//     metering.ts) — booked under the PLATFORM-OWNED, never-billed showcase
//     tenant (brokerages.is_demo = true, lib/platform/demo-tenant.ts), the only
//     brokerage row the platform holds, so platform D-ID minutes land on the
//     platform's own ledger and never on a real tenant's vendor cost
//   · the SAME custom-LLM route, branched on a third marker
//     ([[CTX:platformLiveSessionId=…]]) that resolves to that metering row
//
// WHAT IS DELIBERATELY DIFFERENT — the identity:
//   · the presenter is the PLATFORM's (platform_settings.product_brand.liveAgent
//     — lib/platform/product-brand.ts), NEVER a tenant's twin row. A tenant's
//     likeness and cloned voice are not the platform's to borrow, and a stock
//     D-ID presenter is not a real person's likeness — so the consent gate
//     (app/api/did/create-avatar + lib/did/consent.ts) is never involved and
//     never weakened; this module does not import it, does not write
//     agent_avatar_assets or agent_voice_profiles, and does not mint avatars.
//   · the brain is the PLATFORM branch: buildPlatformReceptionPrompt +
//     platformReceptionTools (the prospect funnel bundle) + the platform
//     playbook — the same brain the phone line and the web chat already run.
//
// FAIL CLOSED: no presenter configured → not available (the page falls back to
// the text prospect chat, never a dead avatar bubble); no showcase tenant →
// not available with an operator hint; a marker that does not resolve to an
// ACTIVE platform metering row → the turn is refused (never served uncapped).

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { ensureDIDAgent, type DIDAgentCache, type DidPresenterType } from "./agents"
import { loadProductBrand, resolveProductBrand, type ProductLiveAgent } from "@/lib/platform/product-brand"
import { findDemoBrokerage } from "@/lib/platform/demo-tenant"

type Svc = ReturnType<typeof createServiceClient>

/** The marker the platform widget prefixes on its first turn — the ONLY
 *  platform handle in a D-ID payload (D-ID passes no metadata of its own). */
export const PLATFORM_LIVE_CTX_RE = /\[\[CTX:platformLiveSessionId=([0-9a-f-]{36})\]\]\s*/gi

export function platformLiveSessionMarker(liveSessionId: string): string {
  return `[[CTX:platformLiveSessionId=${liveSessionId}]]`
}

/** The configured platform agent, or null when no presenter is set. */
export async function loadPlatformLiveAgentConfig(svc: Svc = createServiceClient()): Promise<ProductLiveAgent | null> {
  const brand = await loadProductBrand(svc)
  return brand.liveAgent.presenterId ? brand.liveAgent : null
}

/** The platform's own brokerage for metering — the showcase tenant
 *  (is_demo = true). Null = not seeded yet (the superadmin demo page seeds it). */
export async function resolvePlatformLiveAgentBrokerageId(svc: Svc = createServiceClient()): Promise<string | null> {
  const demo = await findDemoBrokerage(svc)
  return demo?.id ?? null
}

/** The D-ID Agent id cache for the platform deployment — a MERGE onto the
 *  product_brand jsonb (the brand editor's own merge-write keeps it), never a
 *  tenant row. */
export function platformDidAgentCache(svc: Svc): DIDAgentCache {
  return {
    async read() {
      const brand = await loadProductBrand(svc)
      return brand.liveAgent.didAgentId
    },
    async write(didAgentId: string) {
      const { data: row, error: readErr } = await svc.from("platform_settings").select("id, product_brand").limit(1).maybeSingle()
      if (readErr) { console.error("[platform-live-agent] platform_settings read refused:", readErr.message); return }
      const current = resolveProductBrand((row as { product_brand?: unknown } | null)?.product_brand)
      const next = { ...current, liveAgent: { ...current.liveAgent, didAgentId } }
      const write = row
        ? await svc.from("platform_settings").update({ product_brand: next, updated_at: new Date().toISOString() }).eq("id", (row as { id: string }).id)
        : await svc.from("platform_settings").insert({ product_brand: next })
      if (write.error) console.error("[platform-live-agent] D-ID agent id cache write refused:", write.error.message)
    },
  }
}

export type EnsurePlatformDIDAgentResult =
  | { ok: true; didAgentId: string; presenterType: DidPresenterType; created: boolean; agent: ProductLiveAgent }
  | { ok: false; error: string; operatorHint: string }

/** The platform's D-ID Agent — created once through the ONE create path,
 *  cached on the brand kit, patched by the did-agent-sync cron. */
export async function ensurePlatformDIDAgent(svc: Svc = createServiceClient()): Promise<EnsurePlatformDIDAgentResult> {
  const agent = await loadPlatformLiveAgentConfig(svc)
  if (!agent) {
    return {
      ok: false, error: "The platform live agent is not configured.",
      operatorHint: "Set a D-ID Expressive presenter id on the platform brand kit (Growth → Platform brand kit → Live agent) — a D-ID stock presenter (name@avt_…) or one trained under the platform's own account.",
    }
  }
  const ensured = await ensureDIDAgent({
    deployment: "platform",
    presenterId: agent.presenterId as string,
    elevenLabsVoiceId: agent.voiceId,
    agentName: agent.name,
    personality: agent.personality,
    greeting: agent.greeting,
    cache: platformDidAgentCache(svc),
  })
  if (!ensured.ok) return { ok: false, error: ensured.error, operatorHint: "D-ID refused the agent create — check DID_API_KEY / DID_CUSTOM_LLM_KEY and the presenter id." }
  return { ok: true, didAgentId: ensured.didAgentId, presenterType: ensured.presenterType, created: ensured.created, agent }
}

export interface PlatformLiveSession {
  liveSessionId: string
  /** The platform's own (showcase) brokerage — the metering key, never a tenant a visitor named. */
  brokerageId: string
}

/**
 * Resolve the marker to an ACTIVE platform metering row. Refuses (null) a
 * missing/ended row and — the load-bearing half — a row that belongs to any
 * brokerage other than the platform's own, so a tenant's embed session id
 * can never be replayed as a platform turn.
 */
export async function resolvePlatformLiveSession(svc: Svc, liveSessionId: string): Promise<PlatformLiveSession | null> {
  const platformBrokerageId = await resolvePlatformLiveAgentBrokerageId(svc)
  if (!platformBrokerageId) return null
  const { data, error } = await svc.from("live_agent_sessions")
    .select("id, brokerage_id, status")
    .eq("id", liveSessionId)
    .maybeSingle()
  if (error) { console.error("[platform-live-agent] live_agent_sessions read refused:", error.message); return null }
  const row = data as { id: string; brokerage_id: string; status: string } | null
  if (!row || row.status !== "active" || row.brokerage_id !== platformBrokerageId) return null
  return { liveSessionId: row.id, brokerageId: row.brokerage_id }
}

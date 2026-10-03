/**
 * lib/external/rentcast-ai-tools.ts
 *
 * AI-SDK tool surface over RentCast's public MCP server (lib/external/rentcast-mcp.ts) — wave
 * 69, owner: "we are trying to keep the cost down for tenant subscription... try to use an sdk
 * or mcp if it is provided but keeping pricing in mind." Mirrors lib/external/
 * batchdata-ai-tools.ts exactly: dynamic tool-catalogue discovery (no hardcoded RentCast tool
 * names — the account's MCP tool set is RentCast's to define), every returned tool keyed
 * `rentcast_<mcp tool name>`, each call meters its own spend before returning.
 *
 * AGENT-COPILOT ONLY, NEVER A PRODUCTION PULL PATH — see lib/external/rentcast-mcp.ts's header
 * for why (RentCast bills an MCP call at the same per-request rate as REST, plus LLM token
 * overhead). Scheduled/bulk pulls (buyer search, CMA comps, AVM, market stats) stay on
 * lib/property/rentcast.ts. This file exists so the in-app agent copilot
 * (app/api/internal/ai-chat/route.ts, spread in beside batchDataMcpTools) can answer an ad-hoc
 * "what's this address worth" / "pull comps for this listing" question without a bespoke tool
 * per RentCast endpoint.
 *
 * GATING: rentCastMcpTools() returns `{}` when RENTCAST_API_KEY is unset — an agent surface that
 * spreads this into its tool registry gets nothing extra when RentCast is unconfigured, never a
 * tool that errors on every call.
 *
 * METERING: every tool call is recorded into the vendor cost ledger
 * (lib/vendor-governance/meter-vendor.ts::meterVendorSpend), usageType `mcp_<tool name>`, cost
 * RENTCAST_USD_PER_REQUEST per call — the SAME constant the REST client uses (RentCast bills MCP
 * and REST at the identical per-request rate). TENANT: brokerageId/userId come from the
 * CALLER's already-resolved session context (CLAUDE.md §4 — never a request body), passed in as
 * `ctx`.
 */

import { tool, jsonSchema, type Tool } from "ai"
import { listRentcastMcpTools, callRentcastMcp } from "@/lib/external/rentcast-mcp"
import { meterVendorSpend } from "@/lib/vendor-governance/meter-vendor"
import { RENTCAST_USD_PER_REQUEST } from "@/lib/property/rentcast"

export interface RentcastAiToolsContext {
  brokerageId: string
  userId?: string | null
}

// Tool catalogue discovery is a network round-trip (client.listTools()) — cached briefly so a
// burst of chat turns in the same warm process doesn't re-discover the catalogue on every turn.
let cachedTools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }> | null = null
let cachedAt = 0
const CATALOGUE_TTL_MS = 5 * 60 * 1000

async function discoverTools() {
  const now = Date.now()
  if (cachedTools && now - cachedAt < CATALOGUE_TTL_MS) return cachedTools
  const r = await listRentcastMcpTools()
  if (r.ok) {
    cachedTools = r.tools
    cachedAt = now
    return cachedTools
  }
  // Discovery failed (network, or genuinely unconfigured) — serve the last known-good catalogue
  // rather than going dark on a transient blip; empty on a true cold start.
  return cachedTools ?? []
}

/**
 * rentCastMcpTools — the AI-SDK tool map to spread into an agent's tool registry:
 *
 *   tools: { ...agentTools, ...batchDataTools, ...(await rentCastMcpTools({ brokerageId, userId })) }
 *
 * Returns `{}` when RentCast's MCP is not configured (no RENTCAST_API_KEY) or when discovery
 * finds no tools and no cached catalogue exists. Every returned tool's `execute` meters its own
 * spend before returning — the caller's tool registry needs no RentCast-specific glue.
 */
export async function rentCastMcpTools(ctx: RentcastAiToolsContext): Promise<Record<string, Tool>> {
  if (!process.env.RENTCAST_API_KEY) return {}
  if (!ctx.brokerageId) return {} // §4: never build a tenant-less tool surface

  const catalogue = await discoverTools()
  if (!catalogue.length) return {}

  const registry: Record<string, Tool> = {}
  for (const t of catalogue) {
    registry[`rentcast_${t.name}`] = tool({
      description: t.description || `RentCast MCP tool: ${t.name}`,
      inputSchema: jsonSchema(t.inputSchema as any),
      execute: async (args: Record<string, unknown>) => {
        const result = await callRentcastMcp(t.name, args ?? {})
        // Never let metering failure mask the tool's own result — fire-and-forget, same
        // posture as every other meterVendorSpend call site in this repo.
        void meterVendorSpend({
          vendorName: "rentcast",
          usageType: `mcp_${t.name}`,
          cost: RENTCAST_USD_PER_REQUEST,
          brokerageId: ctx.brokerageId,
          systemSource: "ai_agent_tool",
          metadata: { userId: ctx.userId ?? null, mcpTool: t.name },
        }).catch(() => null)

        if (!result.ok) return { success: false, error: result.error ?? "RentCast MCP call failed" }
        return { success: true, data: result.data }
      },
    })
  }
  return registry
}

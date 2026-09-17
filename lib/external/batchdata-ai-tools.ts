/**
 * lib/external/batchdata-ai-tools.ts
 *
 * AI-SDK tool surface over BatchData's official MCP server (lib/external/
 * batchdata-mcp.ts) — wave 67, owner-directed research: "AI SDK path
 * experimental_createMCPClient from @ai-sdk/mcp (transport:{type:'http',url,headers}
 * → mcpClient.tools() into generateText/streamText)."
 *
 * PACKAGE CHECK (do this before adding a dependency): `@ai-sdk/mcp` on the npm
 * registry tops out at 2.0.x, which targets the AI SDK 4/5 tool-calling shape
 * (`experimental_createMCPClient` lived on the `ai` package itself in that era).
 * This repo is pinned to `ai@6.0.16` (lib/ai/models.ts, wave-59 ruling), whose
 * exports were checked directly (`Object.keys(require('ai'))`) and carry NO
 * `experimental_createMCPClient` / MCP export at all — `@ai-sdk/mcp@2.x` was not
 * installed here because nothing confirms it is compatible with `ai@6`, and adding
 * an unverified major-version-mismatched dependency risks a broken build across
 * every AI-SDK surface, not just this one. Per the lane's own fallback instruction,
 * this file instead wraps the OFFICIAL `@modelcontextprotocol/sdk` client's
 * `listTools()` / `callTool()` (already rebuilt in batchdata-mcp.ts) into AI-SDK
 * `tool({inputSchema: jsonSchema(...), execute})` objects from the `ai` package that
 * IS installed — same external capability (BatchData's MCP tool catalogue exposed to
 * an agent's tool-calling loop), no unverified dependency.
 *
 * GATING: `batchDataMcpTools()` returns `{}` (no tools) when no "mcp" purpose token
 * is resolvable (lib/external/batchdata-tokens.ts) — an agent surface that spreads
 * this into its tool registry gets nothing extra when BatchData is unconfigured,
 * never a tool that errors on every call.
 *
 * METERING: every tool call is recorded into the vendor cost ledger
 * (lib/vendor-governance/meter-vendor.ts::meterVendorSpend), usageType
 * `mcp_<tool name>` per tool — mirrors the existing batchdata usageType conventions
 * (property_lookup_hydrate, active_listing_discovery, investor_buybox_match, …) in
 * lib/kernel/listings-batchdata-feed.ts / app/api/webhooks/batchdata-smart-search.
 * TENANT: brokerageId/userId come from the CALLER's already-resolved session context
 * (CLAUDE.md §4 — never a request body), passed in as `ctx`.
 */

import { tool, jsonSchema, type Tool } from "ai"
import { listBatchDataMcpTools, callBatchDataMcp } from "@/lib/external/batchdata-mcp"
import { resolveBatchDataToken } from "@/lib/external/batchdata-tokens"
import { meterVendorSpend } from "@/lib/vendor-governance/meter-vendor"

export interface BatchDataAiToolsContext {
  brokerageId: string
  userId?: string | null
}

// No confirmed per-MCP-call price exists (the MCP server bills the same underlying
// per-record datasets as REST, per the account's token provisioning) — priced the
// same as the property-enrichment / comps dataset pull elsewhere in this repo
// (BATCHDATA_COMPS_COST_CENTS in batchdata-client.ts) rather than inventing a
// different number for the same class of call.
//
// EXPORTED (wave 71) so lib/ai-isa/batchdata-isa-tools.ts's hand-authored ISA/investor
// tool set prices its own full "page"/lookup/scrub calls at the SAME estimate rather
// than inventing a second number for the same class of call (CLAUDE.md §6).
export const MCP_TOOL_CALL_COST_USD = 0.05

// Tool catalogue discovery is a network round-trip (client.listTools()) — cached
// briefly so a burst of chat turns in the same warm process doesn't re-discover the
// catalogue on every turn. A cold start (or a catalogue change on BatchData's side,
// e.g. the account's MCP OAuth dataset config was widened) picks up the fresh list
// after the TTL expires.
let cachedTools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }> | null = null
let cachedAt = 0
const CATALOGUE_TTL_MS = 5 * 60 * 1000

async function discoverTools() {
  const now = Date.now()
  if (cachedTools && now - cachedAt < CATALOGUE_TTL_MS) return cachedTools
  const r = await listBatchDataMcpTools()
  if (r.ok) {
    cachedTools = r.tools
    cachedAt = now
    return cachedTools
  }
  // Discovery failed (network, or genuinely unconfigured) — serve the last known-good
  // catalogue rather than going dark on a transient blip; empty on a true cold start.
  return cachedTools ?? []
}

/**
 * batchDataMcpTools — the AI-SDK tool map to spread into an agent's tool registry:
 *
 *   tools: { ...agentTools, ...(await batchDataMcpTools({ brokerageId, userId })) }
 *
 * Returns `{}` when BatchData's MCP is not configured for this deployment, or when
 * the account's server currently exposes no tools (discovery failure with no cached
 * catalogue). Every returned tool is keyed `batchdata_<mcp tool name>` so it never
 * collides with an existing agent-tool name, and its `execute` meters its own spend
 * before returning — the caller's tool registry needs no BatchData-specific glue.
 */
export async function batchDataMcpTools(ctx: BatchDataAiToolsContext): Promise<Record<string, Tool>> {
  if (!resolveBatchDataToken("mcp")) return {}
  if (!ctx.brokerageId) return {} // §4: never build a tenant-less tool surface

  const catalogue = await discoverTools()
  if (!catalogue.length) return {}

  const registry: Record<string, Tool> = {}
  for (const t of catalogue) {
    registry[`batchdata_${t.name}`] = tool({
      description: t.description || `BatchData MCP tool: ${t.name}`,
      inputSchema: jsonSchema(t.inputSchema as any),
      execute: async (args: Record<string, unknown>) => {
        const result = await callBatchDataMcp(t.name, args ?? {})
        // Never let metering failure mask the tool's own result — fire-and-forget,
        // same posture as every other meterVendorSpend call site in this repo.
        void meterVendorSpend({
          vendorName: "batchdata",
          usageType: `mcp_${t.name}`,
          cost: MCP_TOOL_CALL_COST_USD,
          brokerageId: ctx.brokerageId,
          systemSource: "ai_agent_tool",
          metadata: { userId: ctx.userId ?? null, mcpTool: t.name },
        }).catch(() => null)

        if (!result.ok) return { success: false, error: result.error ?? "BatchData MCP call failed" }
        return { success: true, data: result.data }
      },
    })
  }
  return registry
}

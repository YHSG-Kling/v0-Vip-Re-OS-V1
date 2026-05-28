// app/api/agentic-os/mcp/route.ts
// MCP server wrapper (Streamable-HTTP / JSON-RPC 2.0) over the unified Agentic API manifest.
// Any MCP-speaking agent points here and gets the WHOLE app surface as tools:
//   • initialize           → server info + tools capability
//   • tools/list           → buildFullActionManifest mapped to MCP tools (vendor + app + connected)
//   • tools/call           → scope-gated: runs the read executors, returns the gated plan otherwise
// Auth: agent bearer token (or session) via resolveAgenticCaller — the caller's scopes gate
// every tools/call exactly like the REST invoke route. Every call is audit-logged.
import { NextResponse } from "next/server"
import { buildFullActionManifest } from "@/lib/agentic-os/app-capability-registry"
import { manifestToMcpTools } from "@/lib/agentic-os/mcp-tools"
import { hasScope } from "@/lib/agentic-os/agent-scopes"
import { resolveAgenticCaller } from "@/lib/agentic-os/agent-credentials"
import { recordInvocation } from "@/lib/agentic-os/invocation-log"

const PROTOCOL_VERSION = "2025-06-18"
const SERVER_INFO = { name: "vip-re-os-agentic", version: "1.0.0" }

function rpcResult(id: unknown, result: unknown) {
  return NextResponse.json({ jsonrpc: "2.0", id, result })
}
function rpcError(id: unknown, code: number, message: string, status = 200) {
  return NextResponse.json({ jsonrpc: "2.0", id, error: { code, message } }, { status })
}

// The only auto-executable read tools (same set as the REST invoke route). Everything else
// is returned as a gated plan — side-effecting actions never auto-fire over MCP.
const READ_EXECUTORS: Record<string, (args: any, ctx: { brokerageId: string }) => Promise<unknown>> = {
  web_research: async (args) => {
    const { webSearch } = await import("@/lib/ai/web-search")
    return webSearch({ query: String(args.query ?? ""), maxResults: 6 })
  },
  property_valuation: async (args, ctx) => {
    const { getCurrentAvm } = await import("@/lib/avm/provider-chain")
    return getCurrentAvm({ address: String(args.address ?? ""), zipCode: args.zipCode ?? null, brokerageId: ctx.brokerageId, usePaidProviders: false })
  },
}

export async function POST(req: Request) {
  const caller = await resolveAgenticCaller(req)
  if (caller.via === "none") {
    return rpcError(null, -32001, "Unauthenticated — supply an agent bearer token or sign in", 401)
  }

  let msg: { id?: unknown; method?: string; params?: any }
  try {
    msg = await req.json()
  } catch {
    return rpcError(null, -32700, "Parse error")
  }
  const { id, method, params } = msg

  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      })

    case "notifications/initialized":
    case "ping":
      return rpcResult(id ?? null, {})

    case "tools/list": {
      const tools = manifestToMcpTools(buildFullActionManifest())
      return rpcResult(id, { tools })
    }

    case "tools/call": {
      const name = params?.name as string | undefined
      const args = (params?.arguments ?? {}) as Record<string, unknown>
      if (!name) return rpcError(id, -32602, "Missing tool name")

      const manifest = buildFullActionManifest()
      const action = manifest.find((a) => a.capability === name)
      if (!action) return rpcError(id, -32602, `Unknown tool: ${name}`)

      const authorized = hasScope(caller.scopes, action.scope)
      if (!authorized) {
        void recordInvocation({
          capability: action.capability, kind: action.kind as any, verb: action.verb,
          decision: "unauthorized", brokerageId: caller.brokerageId ?? null, callerVia: caller.via,
          authorized: false, detail: { via: "mcp" },
        })
        return rpcResult(id, { isError: true, content: [{ type: "text", text: `Unauthorized: missing scope "${action.scope}"` }] })
      }

      // Auto-executable read tools run for real; everything else returns a gated plan.
      const executor = READ_EXECUTORS[action.capability]
      if (executor) {
        const startedAt = Date.now()
        try {
          const result = await executor(args, { brokerageId: caller.brokerageId ?? "" })
          void recordInvocation({ capability: action.capability, kind: action.kind as any, verb: action.verb, decision: "executed", brokerageId: caller.brokerageId ?? null, callerVia: caller.via, authorized: true, durationMs: Date.now() - startedAt, detail: { via: "mcp" } })
          return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(result) }] })
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err)
          void recordInvocation({ capability: action.capability, kind: action.kind as any, verb: action.verb, decision: "error", brokerageId: caller.brokerageId ?? null, callerVia: caller.via, authorized: true, durationMs: Date.now() - startedAt, error: m, detail: { via: "mcp" } })
          return rpcResult(id, { isError: true, content: [{ type: "text", text: `Execution error: ${m}` }] })
        }
      }

      // Side-effecting / dedicated-route capability — authorized but planned, not auto-fired.
      void recordInvocation({ capability: action.capability, kind: action.kind as any, verb: action.verb, decision: action.mutates ? "requires_confirmation" : "no_executor", brokerageId: caller.brokerageId ?? null, callerVia: caller.via, authorized: true, detail: { via: "mcp" } })
      return rpcResult(id, {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: action.mutates ? "requires_confirmation" : "no_executor",
            message: `Authorized. ${action.mutates ? "This action mutates state and is executed via its guarded endpoint after confirmation." : "Served by its dedicated endpoint."}`,
            invoke: { method: "POST", path: `/api/agentic-os/actions/${action.capability}/invoke` },
          }),
        }],
      })
    }

    default:
      return rpcError(id ?? null, -32601, `Method not found: ${method ?? "(none)"}`)
  }
}

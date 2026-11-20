// app/api/agentic-os/mcp/route.ts
// MCP server wrapper (Streamable-HTTP / JSON-RPC 2.0) over the unified Agentic API manifest.
// Any MCP-speaking agent points here and gets the WHOLE app surface as tools:
//   • initialize           → server info + tools capability
//   • tools/list           → buildFullActionManifest mapped to MCP tools (vendor + app + connected)
//   • tools/call           → scope-gated: runs the read executors, or files a capability REQUEST through the manager
//                            delegation service for a capability whose survivor has a worker (see CALLABLE below)
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
// is returned as a gated plan — side-effecting actions never auto-fire over MCP. Each is still
// scope-gated by the caller's token below, and every call audit-logs. All vendor egress here goes
// through the connector-gateway (web search, RentCast, PeopleData) — never a bespoke fetch.
const READ_EXECUTORS: Record<string, (args: any, ctx: { brokerageId: string }) => Promise<unknown>> = {
  web_research: async (args, ctx) => {
    const { webSearch } = await import("@/lib/ai/web-search")
    // Wave 139 (139C): the search's spend books under the CALLER's tenant (was unbooked).
    return webSearch({ query: String(args.query ?? ""), maxResults: 6, spend: { brokerageId: ctx.brokerageId || null, systemSource: "agentic_mcp" } })
  },
  property_valuation: async (args, ctx) => {
    const { getCurrentAvm } = await import("@/lib/avm/provider-chain")
    // Wave 93 (lane 93B): an AI AGENT tool surface — RentCast yes, the BatchData backup NO (owner:
    // no BatchData tools on AI agent surfaces; only the server-side chain falls back).
    return getCurrentAvm({ address: String(args.address ?? ""), zipCode: args.zipCode ?? null, brokerageId: ctx.brokerageId, skipProviders: ["batchdata"] })
  },
  comparable_sales: async (args, ctx) => {
    const { getRentcastComps } = await import("@/lib/property/rentcast")
    return getRentcastComps({ brokerageId: ctx.brokerageId, address: String(args.address ?? ""), limit: args.limit != null ? Number(args.limit) : undefined })
  },
  market_stats: async (args, ctx) => {
    const { getRentcastMarketStats } = await import("@/lib/property/rentcast")
    return getRentcastMarketStats({ brokerageId: ctx.brokerageId, zipCode: String(args.zipCode ?? "") })
  },
  lead_skip_trace: async (args) => {
    const { skipTraceWithPeopleData } = await import("@/lib/external/peopledata-client")
    return skipTraceWithPeopleData({
      name: args.name != null ? String(args.name) : undefined,
      phone: args.phone != null ? String(args.phone) : undefined,
      email: args.email != null ? String(args.email) : undefined,
      address: args.address != null ? String(args.address) : undefined,
    })
  },
  connectivity_scan: async (_args, ctx) => {
    const { scanConnectivity } = await import("@/lib/agentic-os/resolve-connectivity")
    return scanConnectivity({ brokerageId: ctx.brokerageId })
  },
}

// ── CALLABLE OVER THIS API (wave 154, lane 154A3 — coverage-ledger gap row 9) ──────────────────────────────────────
// tools/list used to advertise EVERY manifest entry, and a mutating one answered `requires_confirmation` pointing at
// /api/agentic-os/actions/<cap>/invoke — which 404s for an app capability and 501s (`no_executor`) for the rest. 26 mutating
// capabilities (transaction_advance, listing_publish, payment_transfer, …) were offered to an agent as available while nothing
// on this surface could run them. Now a tool is LISTED only when it can actually be served here:
//   · a read executor above (READ_EXECUTORS), or
//   · an APP capability whose survivor has a worker in the manager delegation runtime (lib/kernel/manager-delegation.ts
//     DELEGATION_WORKERS): tools/call files the request through requestDelegation — the SAME door the versioned domain API
//     uses (lib/kernel/domain-api.ts step 5a): tenant from the credential, scope, entitlement (mayUseAndAfford), the
//     capability's registered manager (CAPABILITY_MANAGER), a person accepts it on that manager's rail, then the worker runs.
// Everything else stays DISCOVERABLE as catalog-only (tools/list `_meta.catalogOnly`, with the reason) and a direct tools/call
// is refused naming where it runs — never "requires_confirmation" through a path that cannot run it.
async function delegationWorkers(): Promise<Readonly<Record<string, unknown>>> {
  const { DELEGATION_WORKERS } = await import("@/lib/kernel/manager-delegation")
  return DELEGATION_WORKERS as Readonly<Record<string, unknown>>
}
function callableHere(a: { capability: string; kind: string }, workers: Readonly<Record<string, unknown>>): "read" | "delegate" | null {
  if (Object.prototype.hasOwnProperty.call(READ_EXECUTORS, a.capability)) return "read"
  if (a.kind === "app" && Object.prototype.hasOwnProperty.call(workers, a.capability)) return "delegate"
  return null
}
const CATALOG_ONLY_REASON = "Not callable over the agentic API: no executor on this surface. It runs on its own guarded rail (its screen, or its manager's own runtime) with the confirmation that rail requires."

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
      const manifest = buildFullActionManifest()
      const workers = await delegationWorkers()
      const tools = manifestToMcpTools(manifest.filter((a) => callableHere(a, workers) !== null))
      const catalogOnly = manifest.filter((a) => callableHere(a, workers) === null).map((a) => ({ capability: a.capability, kind: a.kind, mutates: a.mutates }))
      return rpcResult(id, { tools, _meta: { catalogOnly, catalogOnlyReason: CATALOG_ONLY_REASON } })
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
        // WAVE 155 (lane 155R29): THE READ EXECUTORS SPEND (web search, RentCast, PeopleData), so they take the same three
        // checks the delegate branch below and the versioned domain API (lib/kernel/domain-api.ts steps 1, 2 and 4) already
        // run, BEFORE any provider is reached. Each was missing here: (1) a caller with NO tenant ran them with
        // brokerageId "" — spend booked to nobody; now refused, fail closed. (2) No per-caller ceiling: a token could fan out
        // paid lookups unbounded; now the domain API's per-credential window (120 / minute, its DEFAULT_RATE) applies per
        // credential, or per tenant for a session. (3) No entitlement: a lapsed subscription still ran paid tools; now the one
        // resolver (mayUseAndAfford, app.access) decides. Every refusal leaves its evidence row like every other outcome.
        if (!caller.brokerageId) {
          void recordInvocation({ capability: action.capability, kind: action.kind as any, verb: action.verb, decision: "unauthorized", brokerageId: null, callerVia: caller.via, authorized: false, detail: { via: "mcp", why: "no_tenant" } })
          return rpcResult(id, { isError: true, content: [{ type: "text", text: "This credential is not bound to an account, so it cannot run paid tools." }] })
        }
        const { checkPublicRateLimit } = await import("@/lib/security/public-rate-limit")
        const ceiling = checkPublicRateLimit("agentic-mcp", caller.credentialId ?? `session:${caller.brokerageId}`, { limit: 120, windowMs: 60_000 })
        if (!ceiling.allowed) {
          void recordInvocation({ capability: action.capability, kind: action.kind as any, verb: action.verb, decision: "rate_limited", brokerageId: caller.brokerageId, callerVia: caller.via, authorized: true, detail: { via: "mcp", retry_after_seconds: ceiling.retryAfterSeconds } })
          return rpcError(id, -32029, `Rate limit exceeded — retry after ${ceiling.retryAfterSeconds}s`, 429)
        }
        const { mayUseAndAfford: mayRun } = await import("@/lib/billing/billing-access")
        const runEntitlement = await mayRun({ brokerageId: caller.brokerageId, capability: "app.access" })
        if (!runEntitlement.allowed) {
          void recordInvocation({ capability: action.capability, kind: action.kind as any, verb: action.verb, decision: "blocked", brokerageId: caller.brokerageId, callerVia: caller.via, authorized: true, detail: { via: "mcp", why: "entitlement", reason: runEntitlement.reason } })
          return rpcResult(id, { isError: true, content: [{ type: "text", text: "The account's subscription does not currently allow running tools through the API." }] })
        }
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

      const mode = callableHere(action, await delegationWorkers())
      if (mode !== "delegate") {
        // Catalog-only: said as a refusal the agent can act on — never a plan through a path that cannot run it.
        void recordInvocation({ capability: action.capability, kind: action.kind as any, verb: action.verb, decision: "no_executor", brokerageId: caller.brokerageId ?? null, callerVia: caller.via, authorized: true, detail: { via: "mcp", catalog_only: true } })
        return rpcResult(id, { isError: true, content: [{ type: "text", text: JSON.stringify({ status: "not_callable", capability: action.capability, message: CATALOG_ONLY_REASON }) }] })
      }

      // DELEGATE — a capability REQUEST through the manager delegation service (the domain API's door, step 5a). The tenant is
      // the caller's (never an argument); the arguments are DATA on the request (a `brokerageId` in them is dropped).
      if (!caller.brokerageId) {
        void recordInvocation({ capability: action.capability, kind: action.kind as any, verb: action.verb, decision: "unauthorized", brokerageId: null, callerVia: caller.via, authorized: false, detail: { via: "mcp", why: "no_tenant" } })
        return rpcResult(id, { isError: true, content: [{ type: "text", text: "This credential is not bound to an account, so it cannot request work." }] })
      }
      const { mayUseAndAfford } = await import("@/lib/billing/billing-access")
      const ent = await mayUseAndAfford({ brokerageId: caller.brokerageId, capability: "app.access" })
      if (!ent.allowed) {
        void recordInvocation({ capability: action.capability, kind: action.kind as any, verb: action.verb, decision: "blocked", brokerageId: caller.brokerageId, callerVia: caller.via, authorized: true, detail: { via: "mcp", why: "entitlement", reason: ent.reason } })
        return rpcResult(id, { isError: true, content: [{ type: "text", text: "The account's subscription does not currently allow requests through the API." }] })
      }
      const { CAPABILITY_MANAGER } = await import("@/lib/agentic-os/capability-ownership")
      const { requestDelegation } = await import("@/lib/kernel/manager-delegation")
      const { brokerageId: _ignoredTenantHint, objective, ...entities } = args as Record<string, unknown>
      const r = await requestDelegation({
        brokerageId: caller.brokerageId, requestingManager: "data_steward",
        assignedManager: CAPABILITY_MANAGER[action.capability as keyof typeof CAPABILITY_MANAGER],
        capability: action.capability as keyof typeof CAPABILITY_MANAGER, objective: String(objective ?? `Requested over MCP: ${action.capability}`),
        inputEntities: { ...entities, requested_via: "mcp", api_credential_id: caller.credentialId ?? null },
        authority: 0 as never, actor: { type: "system", id: caller.credentialId ?? `mcp:${caller.via}` },
      })
      if (!r.ok) {
        void recordInvocation({ capability: action.capability, kind: action.kind as any, verb: action.verb, decision: "refused", brokerageId: caller.brokerageId, callerVia: caller.via, authorized: true, detail: { via: "mcp", reason: r.reason } })
        return rpcResult(id, { isError: true, content: [{ type: "text", text: JSON.stringify({ status: "refused", reason: r.reason }) }] })
      }
      void recordInvocation({ capability: action.capability, kind: action.kind as any, verb: action.verb, decision: "requested", brokerageId: caller.brokerageId, callerVia: caller.via, authorized: true, detail: { via: "mcp", delegation_id: r.delegation.id, duplicate: r.duplicate === true } })
      return rpcResult(id, {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "requested",
            delegation: { id: r.delegation.id, status: r.delegation.status, assigned_manager: r.delegation.assigned_manager },
            message: "Requested. The capability's manager rail accepts it (a person confirms) before its worker runs; the result is returned on the delegation.",
          }),
        }],
      })
    }

    default:
      return rpcError(id ?? null, -32601, `Method not found: ${method ?? "(none)"}`)
  }
}

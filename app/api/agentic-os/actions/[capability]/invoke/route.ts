// app/api/agentic-os/actions/[capability]/invoke/route.ts
// Agentic-API INVOKE endpoint (agenticapi.com). Closes the discover→describe→INVOKE
// loop. The pure planInvocation() gates the call (scope → required inputs → budget /
// downgrade ladder → confirmation). Decisions other than "execute" return the plan
// (403 unauthorized / 400 invalid_input / 402 blocked / 200 requires_confirmation).
// For "execute" (read/analyze actions), a registered handler runs the REAL capability.
// Side-effecting actions (RENDER/NOTIFY) are never auto-fired here — they carry their
// own guarded, context-rich dedicated routes.
import { NextResponse } from "next/server"
import { VENDOR_CAPABILITY_REGISTRY, type VendorCapability } from "@/lib/agentic-os/vendor-capability-registry"
import { planInvocation, planConnectedInvocation } from "@/lib/agentic-os/invoke-planner"
import { checkVendorBudget } from "@/lib/vendor-governance/budget-gate"
import { resolveAgenticCaller } from "@/lib/agentic-os/agent-credentials"
import { isConnectedCapability } from "@/lib/agentic-os/connected-vendor-registry"
import { resolveConnectedCapability } from "@/lib/agentic-os/resolve-connected-capability"

// Executors for read/analyze actions. Side-effecting capabilities intentionally have
// no executor here — they run through their dedicated guarded routes after confirmation.
const EXECUTORS: Partial<Record<VendorCapability, (inputs: any, ctx: { brokerageId: string }) => Promise<unknown>>> = {
  web_research: async (inputs) => {
    const { webSearch } = await import("@/lib/ai/web-search")
    return webSearch({ query: String(inputs.query), maxResults: 6 })
  },
  property_valuation: async (inputs, ctx) => {
    const { getCurrentAvm } = await import("@/lib/avm/provider-chain")
    // Generic agent invoke uses the FREE tier (Perplexity/OSINT) — no surprise spend.
    return getCurrentAvm({ address: String(inputs.address), zipCode: inputs.zipCode ?? null, brokerageId: ctx.brokerageId, usePaidProviders: false })
  },
}

const STATUS: Record<string, number> = {
  unauthorized: 403,
  invalid_input: 400,
  blocked: 402,
  not_connected: 409, // brokerage has not connected a provider for this capability
  requires_confirmation: 200,
  execute: 200,
}

export async function POST(req: Request, ctx: { params: Promise<{ capability: string }> }) {
  const caller = await resolveAgenticCaller(req)
  if (caller.via === "none") {
    return NextResponse.json({ error: "Unauthenticated — supply an agent bearer token or sign in" }, { status: 401 })
  }

  const { capability } = await ctx.params

  let body: { inputs?: Record<string, unknown> }
  try {
    body = await req.json()
  } catch {
    body = { inputs: {} }
  }
  const inputs = body.inputs ?? {}

  // ── User-connected vendor capability — connection-gated (NOT platform budget). ──
  if (isConnectedCapability(capability)) {
    const resolution = caller.brokerageId
      ? await resolveConnectedCapability(capability, { brokerageId: caller.brokerageId })
      : null
    const plan = planConnectedInvocation(capability, {
      inputs,
      grantedScopes: caller.scopes,
      connected: resolution?.connected ?? false,
    })
    if (plan.decision !== "execute") {
      return NextResponse.json({ status: plan.decision, plan }, { status: STATUS[plan.decision] ?? 200 })
    }
    // Authorized + connected read action. User-connected writes run through their own
    // guarded dedicated routes after confirmation; reads have no generic executor here.
    return NextResponse.json(
      { status: "no_executor", plan, connectedProvider: resolution?.provider ?? null, message: `Use the dedicated endpoint for ${capability}` },
      { status: 501 },
    )
  }

  if (!(capability in VENDOR_CAPABILITY_REGISTRY)) {
    return NextResponse.json({ error: "Unknown capability" }, { status: 404 })
  }
  const cap = capability as VendorCapability

  const grantedScopes = caller.scopes
  let overBudget = false
  if (caller.brokerageId) {
    try {
      const budget = await checkVendorBudget({ brokerageId: caller.brokerageId })
      overBudget = !budget.allowed
    } catch { /* fail open */ }
  }

  const plan = planInvocation(cap, { inputs, grantedScopes, overBudget })

  if (plan.decision !== "execute") {
    return NextResponse.json({ status: plan.decision, plan }, { status: STATUS[plan.decision] ?? 200 })
  }

  const executor = EXECUTORS[cap]
  if (!executor) {
    // Authorized + within budget, but this read action has no generic executor — it is
    // served by its own dedicated route. Honest 501, not a fabricated result.
    return NextResponse.json(
      { status: "no_executor", plan, message: `Use the dedicated endpoint for ${cap}` },
      { status: 501 },
    )
  }

  try {
    const result = await executor(inputs, { brokerageId: caller.brokerageId ?? "" })
    return NextResponse.json({ status: "executed", plan, result })
  } catch (err) {
    return NextResponse.json(
      { status: "error", plan, error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    )
  }
}

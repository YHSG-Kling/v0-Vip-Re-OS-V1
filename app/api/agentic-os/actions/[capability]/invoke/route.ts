// app/api/agentic-os/actions/[capability]/invoke/route.ts
// Agentic-API INVOKE endpoint (agenticapi.com). Closes the discover→describe→INVOKE
// loop. The pure planInvocation() gates the call (scope → required inputs → budget /
// downgrade ladder → confirmation). Decisions other than "execute" return the plan
// (403 unauthorized / 400 invalid_input / 402 blocked / 200 requires_confirmation).
// For "execute" (read/analyze actions), a registered handler runs the REAL capability.
// Side-effecting actions (RENDER/NOTIFY) are never auto-fired here — they carry their
// own guarded, context-rich dedicated routes.
import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import { isPlatformStaff } from "@/lib/auth/resolve-user-role"
import { VENDOR_CAPABILITY_REGISTRY, type VendorCapability } from "@/lib/agentic-os/vendor-capability-registry"
import { planInvocation } from "@/lib/agentic-os/invoke-planner"
import { checkVendorBudget } from "@/lib/vendor-governance/budget-gate"
import { ALL_SCOPES } from "@/lib/agentic-os/agent-scopes"

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
  requires_confirmation: 200,
  execute: 200,
}

export async function POST(req: Request, ctx: { params: Promise<{ capability: string }> }) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  const { capability } = await ctx.params
  if (!(capability in VENDOR_CAPABILITY_REGISTRY)) {
    return NextResponse.json({ error: "Unknown capability" }, { status: 404 })
  }
  const cap = capability as VendorCapability

  let body: { inputs?: Record<string, unknown> }
  try {
    body = await req.json()
  } catch {
    body = { inputs: {} }
  }
  const inputs = body.inputs ?? {}

  const grantedScopes = isPlatformStaff(auth.userType) ? [ALL_SCOPES] : []
  let overBudget = false
  try {
    const budget = await checkVendorBudget({ brokerageId: auth.brokerageId })
    overBudget = !budget.allowed
  } catch { /* fail open */ }

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
    const result = await executor(inputs, { brokerageId: auth.brokerageId })
    return NextResponse.json({ status: "executed", plan, result })
  } catch (err) {
    return NextResponse.json(
      { status: "error", plan, error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    )
  }
}

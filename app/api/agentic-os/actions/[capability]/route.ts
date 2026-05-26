// app/api/agentic-os/actions/[capability]/route.ts
// Agentic-API DESCRIBE endpoint (agenticapi.com). Returns the full descriptor for one
// action: AGIS verb, required scope, intent weight, business purpose, and the typed
// input spec (required vs optional) an agent must satisfy to INVOKE it. VENDOR-ANONYMOUS.
import { NextResponse } from "next/server"
import { VENDOR_CAPABILITY_REGISTRY, CAPABILITY_AGIS, type VendorCapability } from "@/lib/agentic-os/vendor-capability-registry"
import { parseInputSpec, SIDE_EFFECTING_VERBS, CONFIRMATION_THRESHOLD } from "@/lib/agentic-os/invoke-planner"
import { hasScope } from "@/lib/agentic-os/agent-scopes"
import { resolveAgenticCaller } from "@/lib/agentic-os/agent-credentials"

export async function GET(req: Request, ctx: { params: Promise<{ capability: string }> }) {
  const caller = await resolveAgenticCaller(req)
  if (caller.via === "none") {
    return NextResponse.json({ error: "Unauthenticated — supply an agent bearer token or sign in" }, { status: 401 })
  }

  const { capability } = await ctx.params
  if (!(capability in VENDOR_CAPABILITY_REGISTRY)) {
    return NextResponse.json(
      { error: "Unknown capability", available: Object.keys(VENDOR_CAPABILITY_REGISTRY) },
      { status: 404 },
    )
  }
  const cap = capability as VendorCapability
  const def = VENDOR_CAPABILITY_REGISTRY[cap]
  const agis = CAPABILITY_AGIS[cap]
  const granted = caller.scopes
  const requiresConfirmation = SIDE_EFFECTING_VERBS.has(agis.verb) || agis.intentWeight >= CONFIRMATION_THRESHOLD

  return NextResponse.json({
    action: `${agis.verb} ${cap}`,
    verb: agis.verb,
    capability: cap,
    category: def.domain,
    scope: agis.scope,
    intentWeight: agis.intentWeight,
    purpose: def.purpose,
    inputSpec: parseInputSpec(def.inputs),
    requiresConfirmation,
    callerAuthorized: hasScope(granted, agis.scope),
    invoke: { method: "POST", path: `/api/agentic-os/actions/${cap}/invoke` },
  })
}

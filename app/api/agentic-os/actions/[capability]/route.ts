// app/api/agentic-os/actions/[capability]/route.ts
// Agentic-API DESCRIBE endpoint (agenticapi.com). Returns the full descriptor for one
// action: AGIS verb, required scope, intent weight, business purpose, and the typed
// input spec (required vs optional) an agent must satisfy to INVOKE it. VENDOR-ANONYMOUS.
import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import { isPlatformStaff } from "@/lib/auth/resolve-user-role"
import { VENDOR_CAPABILITY_REGISTRY, CAPABILITY_AGIS, type VendorCapability } from "@/lib/agentic-os/vendor-capability-registry"
import { parseInputSpec, SIDE_EFFECTING_VERBS, CONFIRMATION_THRESHOLD } from "@/lib/agentic-os/invoke-planner"
import { hasScope, ALL_SCOPES } from "@/lib/agentic-os/agent-scopes"

export async function GET(_req: Request, ctx: { params: Promise<{ capability: string }> }) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

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
  const granted = isPlatformStaff(auth.userType) ? [ALL_SCOPES] : []
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

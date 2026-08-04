// app/api/admin/domain-coherence/routes/enumerate/route.ts
// Input contract:  GET with optional ?includePersonaRoutes=true
// Output contract: EnumerateRoutesOutput | { error: string }
// Access:          platform staff with the 'sentinel' capability
// Tables read:     none (filesystem/registry)
// Tables written:  none

import { NextRequest, NextResponse } from "next/server"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import {
  enumerateDomainRoutes,
  type EnumerateRoutesOutput,
} from "@/lib/kernel/routes"

export async function GET(req: NextRequest): Promise<NextResponse<EnumerateRoutesOutput | { error: string }>> {
  // PLATFORM GOVERNANCE, NOT TENANT DATA. The route registry describes every
  // surface in the product across ALL tenants and carries no brokerage_id, so
  // it cannot be tenant-filtered. The previous guard here accepted
  // users.user_type in {superadmin, admin, broker} — but 'admin' and 'broker'
  // are TENANT roles in this schema, so any brokerage broker could GET the full
  // report. It also ignored users.platform_role entirely.
  //
  // These routes are the HTTP path around app/actions/admin/domain-coherence.ts.
  // Gating only the actions would have closed the front door and left this one
  // open, so both now delegate to the same canonical platform gate.
  const gate = await requirePlatformCapability("sentinel")
  if (!gate.ok) {
    return NextResponse.json(
      { error: gate.error ?? "Forbidden" },
      { status: gate.userId ? 403 : 401 },
    )
  }

  const includePersona = req.nextUrl.searchParams.get("includePersonaRoutes") === "true"

  const output = enumerateDomainRoutes({ includePersonaRoutes: includePersona })
  return NextResponse.json(output)
}

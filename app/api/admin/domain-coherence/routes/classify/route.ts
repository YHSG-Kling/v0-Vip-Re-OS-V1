// app/api/admin/domain-coherence/routes/classify/route.ts
// Input contract:  GET — no body, works against full registry
// Output contract: { canonical, redirects, toRemove, children, unclassified }
// Access:          platform staff with the 'sentinel' capability
// Tables read:     none (registry)
// Tables written:  none

import { NextResponse } from "next/server"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import {
  enumerateDomainRoutes,
  classifyRouteOwnership,
  detectDuplicateManagerSurfaces,
  type ClassifyOwnershipOutput,
  type DetectDuplicatesOutput,
} from "@/lib/kernel/routes"

interface ClassifyResponse {
  classification: ClassifyOwnershipOutput
  duplicates: DetectDuplicatesOutput
}

export async function GET(): Promise<NextResponse<ClassifyResponse | { error: string }>> {
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

  const { routes } = enumerateDomainRoutes({ includePersonaRoutes: true })
  const classification = classifyRouteOwnership({ routes })
  const duplicates = detectDuplicateManagerSurfaces({ routes })

  return NextResponse.json({ classification, duplicates })
}

// app/api/agentic-os/connectivity/route.ts
// Connectivity API Agent endpoint (agenticapi.com model). Returns the live connectivity
// report for the caller's brokerage — every user-connected connector's health (api_key/
// oauth, expiry-aware), per-capability coverage, and the platform-managed vendor surface.
// An external agent reads this BEFORE planning so it never invokes a capability whose
// connector is dark or whose OAuth token has lapsed. Gated by the connectivity:read scope.
import { NextResponse } from "next/server"
import { resolveAgenticCaller } from "@/lib/agentic-os/agent-credentials"
import { hasScope } from "@/lib/agentic-os/agent-scopes"
import { scanConnectivity } from "@/lib/agentic-os/resolve-connectivity"

const REQUIRED_SCOPE = "connectivity:read"

export async function GET(req: Request) {
  const caller = await resolveAgenticCaller(req)
  if (caller.via === "none") {
    return NextResponse.json({ error: "Unauthenticated — supply an agent bearer token or sign in" }, { status: 401 })
  }
  if (!hasScope(caller.scopes, REQUIRED_SCOPE)) {
    return NextResponse.json({ error: `Missing required scope: ${REQUIRED_SCOPE}` }, { status: 403 })
  }

  const report = await scanConnectivity({ brokerageId: caller.brokerageId ?? null })

  // Vendor-anonymity: only platform staff (session + all-scopes) may see platform vendor
  // NAMES. For brokerage agents the platform-managed surface collapses to a count — the
  // brokerage's OWN connectors (connectors[] / capabilities[]) are always theirs to see.
  const canSeeVendorNames = caller.via === "session" && caller.scopes.includes("*")
  const payload = canSeeVendorNames
    ? report
    : { ...report, platformManaged: [], platformManagedCount: report.platformManaged.length }

  return NextResponse.json({
    protocol: "agentic-api",
    agent: "connectivity",
    authenticatedVia: caller.via,
    report: payload,
  })
}

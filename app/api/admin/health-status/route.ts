import { NextRequest, NextResponse } from "next/server"
import { getAgentContext } from "@/lib/identity"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"
import { getServiceStatuses } from "@/app/actions/system-health"
import { createServiceClient } from "@/lib/supabase/service"
import { rollupServiceStatuses } from "@/lib/platform/service-catalogue-scope"

// ─── DUPLICATE MERGED ONTO ITS SURVIVOR ──────────────────────────────────────
//
// This route used to carry its OWN copy of the service_status read and rollup.
// It was the poorer of the two halves in three separate ways, each of which is
// a defect this repository has already named and fixed on the other half
// (app/actions/system-health.ts:getServiceStatuses — THE SURVIVOR):
//
//  1. It read `.eq("brokerage_id", ctx.brokerageId)`. Every one of the 13 live
//     service_status rows carries brokerage_id IS NULL (the platform catalogue),
//     and `eq.<uuid>` cannot match NULL — so the read returned an empty set for
//     every caller. See lib/platform/service-catalogue-scope.ts.
//  2. `overallStatus` was seeded "operational" and only ever downgraded, so an
//     EMPTY result — which is what (1) guaranteed — reported a green platform.
//     That is the exact "green tick manufactured over an absence" failure the
//     survivor's header (system-health.ts:118-128) exists to forbid.
//  3. It had no not_scoped refusal: a session with no brokerage fell through to
//     the same manufactured green.
//
// ─── RESOLVED (lane W8, 2026-09-01): THE EXTERNAL-OPS CLAIM IS NOW PROVABLE ──
//
// The note that used to stand here said the endpoint stayed because "an external
// ops caller cannot be ruled out from the repository alone (UNRESOLVED)". That
// keep-reason contradicted the census's own can-a-token-get-in rule: the route
// was SESSION-ONLY, so no credential an external monitor could hold would ever
// get past the 401 — the claimed caller was structurally impossible. Per the
// route's own recorded alternative, it now authorizes on the
// `x-internal-api-secret` header (INTERNAL_API_SECRET) AHEAD of the session
// check — the same service-to-service shape as app/api/errors/collect
// (route.ts:13-27 there; mirrored below, including its plain equality — that
// route is the named pattern and it is not timing-safe, so neither is this).
// An external ops poller holding the secret can now actually get in, which is
// what makes the exemption an evidence-backed 6c ruling instead of a guess.
//
// THE SECRET PATH HAS NO COOKIE SESSION, so it cannot call the survivor action:
// getServiceStatuses() redirect()s an unauthenticated caller, which inside a
// route handler surfaces as a 500. Instead it reads the PLATFORM CATALOGUE
// (brokerage_id IS NULL — the only rows that exist; no tenant scope, so no
// tenant row can leak to an infrastructure monitor) with the service client,
// AFTER the secret gate (§4: gate first, then service client), and rolls it up
// through the ONE shared rollup the survivor itself now uses
// (lib/platform/service-catalogue-scope.ts:rollupServiceStatuses). One read
// scope helper, one rollup, no third implementation.
//
// The session path is unchanged and still delegates to THE SURVIVOR, which
// carries the platform-catalogue scope, the unknown-is-not-operational rollup,
// and the readStatus/readDetail contract that says whether the numbers were
// measured at all. The auth gate stays local because the survivor answers a
// PAGE: it redirect()s an unauthorised caller, which inside a route handler
// would surface as a 500 instead of a 401/403. Gating first means the
// survivor's redirects are unreachable from here.

export async function GET(request: NextRequest) {
  try {
    // Check for INTERNAL_API_SECRET or authenticated session — the
    // app/api/errors/collect shape: header first, session as the fallback.
    const internalSecret = request.headers.get("x-internal-api-secret")
    const expectedSecret = process.env.INTERNAL_API_SECRET

    if (internalSecret && expectedSecret && internalSecret === expectedSecret) {
      // External ops caller. Platform catalogue only — brokerage_id IS NULL is
      // every live row, and an infrastructure monitor has no tenant to be.
      const service = createServiceClient()
      const { data: services, error } = await service
        .from("service_status")
        .select("*")
        .is("brokerage_id", null)
        .order("is_critical", { ascending: false })
        .order("service_category")
        .order("service_name")

      // supabase-js RESOLVES a refusal — an unread error here would render a
      // green tick out of a denial, the exact defect the survivor forbids.
      if (error) {
        console.error("[health-status] service_status read refused:", error.message)
        return NextResponse.json({
          services: [],
          overallStatus: "unknown",
          criticalIssues: [],
          lastCheckedAt: null,
          readStatus: "unavailable",
          readDetail: `service_status read was refused: ${error.message}`,
        })
      }

      const rows = services ?? []
      const rollup = rollupServiceStatuses(rows)
      return NextResponse.json({
        services: rows,
        overallStatus: rollup.overallStatus,
        criticalIssues: rollup.criticalIssues,
        lastCheckedAt: rollup.lastCheckedAt,
        readStatus: rows.length === 0 ? "empty" : "ok",
        readDetail:
          rows.length === 0
            ? "No service is registered in the platform catalogue, so no health check has ever run. System status is UNKNOWN, not operational."
            : rollup.lastCheckedAt === null
              ? "Services are registered but no health check has ever recorded a timestamp against them."
              : null,
      })
    }

    const ctx = await getAgentContext()

    if (!ctx || !ctx.isAuthenticated) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // TRUE ADMIN GATE (operational: health status) — repointed to the ONE tenant
    // roster. 'superadmin' was dead: 0 live rows store that users.user_type.
    if (!isAdminOrBroker({ user_type: ctx.role })) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    // THE SURVIVOR. Carries the platform-catalogue scope, the
    // unknown-is-not-operational rollup, and the readStatus/readDetail contract
    // that says whether the numbers were measured at all.
    const result = await getServiceStatuses()

    return NextResponse.json(result)
  } catch (error) {
    console.error("Health status API error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}

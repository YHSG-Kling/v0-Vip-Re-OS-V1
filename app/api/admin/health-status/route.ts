import { NextResponse } from "next/server"
import { getAgentContext } from "@/lib/identity"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"
import { getServiceStatuses } from "@/app/actions/system-health"

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
// Nothing is deleted here except the duplicated logic. The ENDPOINT stays: it
// is addressed by nothing inside this tree, and per the orphan doctrine an
// unreferenced admin HTTP route is not proof of a dead route — an external ops
// caller cannot be ruled out from the repository alone (UNRESOLVED). It now
// delegates, so there is one implementation and one set of corrections.
//
// The auth gate stays local because the survivor answers a PAGE: it redirect()s
// an unauthorised caller, which inside a route handler would surface as a 500
// instead of a 401/403. Gating first means the survivor's redirects are
// unreachable from here.

export async function GET() {
  try {
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

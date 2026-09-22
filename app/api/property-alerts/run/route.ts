import { NextRequest, NextResponse } from "next/server"
import { runAllActiveAlerts } from "@/lib/property-alerts/alert-engine"
import { platformScope, tenantScope, isTenantScopeRefusal } from "@/lib/kernel/tenant-scope"

export async function POST(req: NextRequest) {
  // Auth: Bearer [CRON_SECRET]
  //
  // AN UNSET SECRET REFUSES. This read `if (cronSecret && authHeader !== …)`, so
  // when CRON_SECRET was absent from the environment the check did not run and the
  // request passed — and what it passes into is runAllActiveAlerts(frequency,
  // brokerageId) with brokerageId taken from the BODY, on the service client, whose
  // tenant predicate is conditional. Omit it and every tenant's property alerts are
  // swept; supply one and you pick a tenant you were never checked against.
  // CLAUDE.md §4: "a gate that cannot run must refuse, not pass." The 404-on-unset
  // rule is the one already in force at app/api/webhooks/sendgrid-events/route.ts
  // ("Unset secret = 404 — never a silently-open writer"); app/api/fatigue/
  // calculate/route.ts refuses on unset too. One vocabulary (§6).
  const authHeader = req.headers.get("authorization") ?? ""
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    return NextResponse.json({ error: "not found" }, { status: 404 })
  }
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  }

  let frequency = "daily"
  let brokerageId: string | undefined

  try {
    const body = await req.json().catch(() => ({}))
    if (body.frequency)   frequency   = body.frequency
    if (body.brokerageId) brokerageId = body.brokerageId
  } catch (_) {}

  // Also allow query param (Vercel cron GET → converted to POST by middleware)
  const url = new URL(req.url)
  if (url.searchParams.get("frequency"))   frequency   = url.searchParams.get("frequency")!
  if (url.searchParams.get("brokerageId")) brokerageId = url.searchParams.get("brokerageId")!

  // THE SCOPE IS DECLARED, NEVER INFERRED FROM AN ABSENT ID (lane 78D). The
  // caller above proved CRON_SECRET, which is the platform authority a
  // platform-wide sweep needs; a named brokerageId narrows that run to one
  // tenant and a blank one REFUSES rather than widening (tenantScope throws).
  let scope
  try {
    scope = brokerageId !== undefined
      ? tenantScope(brokerageId, "property-alerts run (tenant named by the CRON_SECRET-verified caller)")
      : platformScope("CRON_SECRET-verified sweep — every tenant's due property alerts, by design (lib/property-alerts/alert-engine.ts runAllActiveAlerts)")
  } catch (err) {
    if (isTenantScopeRefusal(err)) return NextResponse.json({ error: err.message }, { status: 400 })
    throw err
  }
  const stats = await runAllActiveAlerts(frequency, scope)

  // WHICH SOURCE ANSWERED, AND HOW MANY ALERTS COULD NOT BE EVALUATED, are part
  // of the sweep's own record — `stats` carries `bySource`, `unevaluated` and
  // `unevaluatedReasons`. A cron whose response said only succeeded/failed could
  // not distinguish "every buyer's market was quiet" from "no provider answered
  // for anyone", and on an alert rail those are opposite facts: the second one
  // means every buyer on the platform was told, silently, that nothing is for
  // sale. `ok` is the transport result, not a verdict on the sweep — a run with
  // `unevaluated > 0` did NOT cover those alerts.
  return NextResponse.json({ ok: true, frequency, ...stats })
}

// Vercel cron invokes via GET
export async function GET(req: NextRequest) {
  return POST(req)
}

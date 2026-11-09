import { NextRequest, NextResponse } from "next/server"
import { verifyCronAuth } from "@/lib/cron-auth"
import { runAllActiveAlerts } from "@/lib/property-alerts/alert-engine"
// WAVE 151 (lane 151J): the saved-home watch rides THIS route's daily tick (see below). Imported statically here — this
// route is reached by the cron alone, never by a page graph, so the watch's approval / caps / rail subtree lands on no
// page (app/crm/page.tsx measured 1300 → 1300); the engine itself does not import the watch.
import { watchSavedHomes, type SavedHomeWatchStats } from "@/lib/property-alerts/saved-home-watch"
import { createServiceClient } from "@/lib/supabase/service"
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
  //
  // Lane 88E: this route is a CRON_REGISTRY target (four frequencies), so it
  // now gates through THE ONE cron gate every other registry target uses —
  // lib/cron-auth.ts verifyCronAuth (unset → 500, missing/wrong Bearer → 401).
  // Still refuses on an unset secret; the status is the cron fleet's, not a
  // second spelling (scripts/cron-dispatch-simulator.ts holds the rule).
  const denied = verifyCronAuth(req)
  if (denied) return denied

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

  // WAVE 151 (lane 151J) — the SAVED-HOME WATCH on the DAILY tick. The sweep above is one subscription (a saved SEARCH);
  // a saved HOME is the other (lib/property-alerts/saved-home-watch.ts): the watch re-reads each saved home's own
  // source — a RentCast / pasted-link re-read only behind the tenant's approved plan line and the platform caps, held
  // and recorded otherwise — diffs against the last verified state (m983) and hands a REAL change to the ONE arbiter
  // door. This tick is a DETECTION poll, never a notification cadence: the arbiter decides whether, when and how a
  // buyer hears of a change. It lives in this ROUTE (reached by the cron alone) rather than in runAllActiveAlerts because
  // the engine sits on every page graph that reaches the alert actions and the watch's approval / caps / rail subtree
  // must not (app/crm/page.tsx is at its 1300-module budget). A watch failure never fails the alert sweep — it is
  // reported beside the sweep's own stats.
  let savedHomes: SavedHomeWatchStats | { error: string } | undefined
  if (frequency === "daily") {
    try {
      savedHomes = await watchSavedHomes(createServiceClient(), scope)
      console.log(`[property-alerts] daily: saved-home watch scanned ${savedHomes.scanned}, verified ${savedHomes.verifiedTotal}, changes ${savedHomes.changesTotal}, delivered ${savedHomes.delivered}, arbiter held ${savedHomes.arbiterHeld}, re-reads held ${savedHomes.meteredRecheck.heldRows}`)
    } catch (e) {
      savedHomes = { error: `saved_home_watch: ${e instanceof Error ? e.message : String(e)}` }
      console.error("[property-alerts] daily: saved-home watch failed —", savedHomes.error)
    }
  }

  // WHICH SOURCE ANSWERED, AND HOW MANY ALERTS COULD NOT BE EVALUATED, are part
  // of the sweep's own record — `stats` carries `bySource`, `unevaluated` and
  // `unevaluatedReasons`. A cron whose response said only succeeded/failed could
  // not distinguish "every buyer's market was quiet" from "no provider answered
  // for anyone", and on an alert rail those are opposite facts: the second one
  // means every buyer on the platform was told, silently, that nothing is for
  // sale. `ok` is the transport result, not a verdict on the sweep — a run with
  // `unevaluated > 0` did NOT cover those alerts.
  return NextResponse.json({ ok: true, frequency, ...stats, ...(savedHomes ? { savedHomes } : {}) })
}

// Vercel cron invokes via GET
export async function GET(req: NextRequest) {
  return POST(req)
}

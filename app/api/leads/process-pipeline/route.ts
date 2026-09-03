import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireBrokerAuth } from "@/lib/kernel/api-auth"
import { resolveLeadVisibility } from "@/lib/auth/lead-visibility"
import { loadRawPipelineStats } from "@/app/dashboard/admin/lead-intake/pipeline-stats"

export const dynamic = "force-dynamic"
export const maxDuration = 300

/**
 * API Route: Raw-lead pipeline statistics (read-only).
 *
 * CANONICAL PROCESS (owner, round 37): raw leads can't be manually moved to
 * leads — promotion is FULLY AUTOMATIC (the lead-scraping cron's
 * processRawRecord promotion pass + its stranded-record re-enrich sweep). The
 * former POST handler here (an on-demand broker trigger that ran pending raw
 * records through the pipeline) was a manual raw→lead door and has been
 * REMOVED. Only the GET stats endpoint remains.
 *
 * THE COMPUTATION MOVED (2026-09-03). The queries that lived inline here are now
 * app/dashboard/admin/lead-intake/pipeline-stats.ts:loadRawPipelineStats, so the
 * Lead Intake Cockpit page — a server component — renders the same numbers by
 * an in-process call instead of a cookie-forwarding self-fetch. This route is
 * the EXTERNAL door onto that one function, behind the same two gates. The
 * handler's `request` parameter is gone with the move: it was never read.
 */

/**
 * GET /api/leads/process-pipeline
 * Pipeline processing statistics for the caller's brokerage.
 */
export async function GET() {
  // TWO GATES, AND THE SECOND ONE IS THE POINT.
  //
  // requireBrokerAuth is the TENANT-ADMIN roster (lib/kernel/api-auth.ts →
  // isAdminOrBroker). It is kept, and it is not wrong — but it answers a
  // different question from the one this route needs, and it happened to admit
  // `team_lead` because TENANT_ADMIN_USER_TYPES always has. That meant this route
  // ALREADY served a team lead brokerage-wide raw-pipeline counts, before anybody
  // ruled that team leads should see leads at all: an incidental admission, not a
  // decided one.
  //
  // The lead answer (lib/auth/lead-visibility.ts) is asked SECOND, and a TRUE
  // TEAM SCOPE IS REFUSED, on purpose. `raw_scraped_leads` has NO agent linkage —
  // a raw record is pre-promotion, so there is no agent_id and therefore no team
  // to scope it to. A gate that cannot express the scope must refuse, not serve
  // the unscoped answer (CLAUDE.md §4: "a gate that cannot run must refuse").
  // Serving brokerage-wide ingestion totals to a team-scoped actor is the precise
  // failure this consolidation exists to prevent, and it would be invisible: the
  // numbers look like a board, not like a leak.
  //
  // Where the team IS the tenant the resolver has already collapsed the scope to
  // 'brokerage' and this route answers normally — the owner's team-tier case.
  const userSupabase = await createClient()
  const auth = await requireBrokerAuth(userSupabase)
  if (!auth.ok) return auth.response

  const vis = await resolveLeadVisibility(userSupabase, {
    userId: auth.userId,
    userType: auth.userType,
    platformRole: auth.platformRole,
    brokerageId: auth.brokerageId,
  })
  if (!vis.allowed) {
    return NextResponse.json(
      { error: vis.status === "forbidden" ? "Broker or admin access required" : vis.reason },
      { status: vis.status === "forbidden" ? 403 : 500 },
    )
  }
  if (vis.scope.kind === "team") {
    return NextResponse.json(
      { error: "Raw-lead pipeline statistics are brokerage-level and cannot be scoped to a team" },
      { status: 403 },
    )
  }

  try {
    // Tenant from the SESSION (auth.brokerageId), never a parameter.
    const res = await loadRawPipelineStats(auth.brokerageId)
    if (!res.ok) {
      console.error("[process-pipeline] Pipeline stats refused:", res.error)
      return NextResponse.json({ error: res.error }, { status: 500 })
    }
    return NextResponse.json(res.stats)
  } catch (error) {
    console.error("[process-pipeline] Error fetching pipeline stats:", error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}

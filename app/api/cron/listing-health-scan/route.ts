import {
NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { calculateListingHealth } from "@/lib/listing-health/health-scorer"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth, requireCronOrSessionCaller } from "@/lib/cron-auth"
import { resolveUserIdToAgentRecord } from "@/lib/kernel/agent-identity-resolver"
import { isValidUUID } from "@/lib/validations"

export const dynamic = "force-dynamic"

/**
 * Listing Health Scan Cron
 *
 * GET:  Scheduled scan of all active listings (12-hour interval)
 * POST: Single listing rescan — GATED (wave 155): the scheduler's credential, or a signed-in person who may open THAT
 *       listing. It had no gate at all before. (The UI's Refresh button calls rescanListingHealthAction, which is
 *       session-gated and scores directly; it never came through this door.)
 *
 * Event emission + intervention creation are handled INSIDE
 * calculateListingHealth(), so this cron stays a thin orchestrator.
 */

export async function GET(request: NextRequest) {
  // Cron auth — see lib/cron-auth.ts
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const ctxResult = await createCronRunContextAction({
    cron_name: "listing-health-scan",
    cron_path: "/app/api/cron/listing-health-scan/route.ts",
  })
  if (!ctxResult.success || !ctxResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = ctxResult.data.context_id
  await recordCronStartAction({ context_id: contextId })

  const supabase = createServiceClient()
  const results: Array<{ listingId: string; score?: number; riskLevel?: string; error?: string }> = []

  try {
    // tenant anchor (scope burn-down): platform sweep carries each row's
    // brokerage — rows without a tenant are excluded from processing.
    const { data: listings, error } = await supabase
      .from("listings")
      .select("id, brokerage_id")
      .not("brokerage_id", "is", null)
      .in("status", ["active", "coming_soon"])

    if (error) throw new Error(`Failed to fetch listings: ${error.message}`)
    if (!listings || listings.length === 0) {
      await recordCronSuccessAction({ context_id: contextId, records_processed: 0, metadata: { message: "No active listings" } })
      return NextResponse.json({ message: "No active listings to scan", results: [] })
    }

    for (const row of listings) {
      try {
        const r = await calculateListingHealth({ listingId: row.id })
        results.push({ listingId: row.id, score: r.overallScore, riskLevel: r.riskLevel })
      } catch (e) {
        const message = e instanceof Error ? e.message : "Score failed"
        results.push({ listingId: row.id, error: message })
      }
    }

    const atRisk = results.filter((r) => r.riskLevel === "at_risk" || r.riskLevel === "critical").length

    // THE LISTING-EXPIRY DECISION SURFACE — same scan, same heartbeat: for
    // every brokerage with listings approaching agreement expiry (21d),
    // compose the RELIST / REPRICE / RELEASE decision with real evidence and
    // price-cut nets, ledger the amber verdict, propose the gated agent
    // brief. Best-effort — never blocks the health scan.
    let expiryProposed = 0
    try {
      const { runExpiryDecisions } = await import("@/lib/listings/expiry-decision")
      const { data: brokerages } = await supabase.from("brokerages").select("id").is("deleted_at", null)
      for (const b of ((brokerages ?? []) as Array<{ id: string }>)) {
        const r = await runExpiryDecisions(supabase as any, { brokerageId: b.id })
        expiryProposed += r.decisionsProposed
      }
    } catch (e) {
      console.error("[listing-health-scan] expiry-decision sweep failed (non-fatal):", e)
    }

    await recordCronSuccessAction({
      context_id:        contextId,
      records_processed: results.length,
      metadata: { at_risk_count: atRisk, error_count: results.filter((r) => r.error).length, expiry_decisions_proposed: expiryProposed },
    })

    return NextResponse.json({
      message:  `Scanned ${results.length} listings`,
      atRisk,
      results,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Cron failed"
    await recordCronFailureAction({ context_id: contextId, error: message })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/**
 * POST: Single-listing rescan — a fresh score after an agent takes an action (price change, new photos, scheduled open
 * house, etc.).
 *
 * GATE FIRST, THEN THE SERVICE CLIENT (CLAUDE.md §4). Until wave 155 this handler had no gate: anyone could POST any
 * tenant's listing id, have it re-scored with the service client and read its score and risk level back. Now:
 *   · the scheduler's credential, or a signed-in person (requireCronOrSessionCaller);
 *   · a signed-in person must be able to open THIS listing by the same rule as the listing's own page
 *     (app/dashboard/listings/[id]/lifecycle/page.tsx): the listing is read through the SESSION client, pinned to the
 *     session's tenant, so the live row policies decide (tenant staff; a team lead their team's listings; never a Contact
 *     or a vendor), and an AGENT seat is narrowed to its OWN listing — listings.agent_id is an agents.id, crossed from the
 *     session user through the canonical resolver (the two id spaces are disjoint, CLAUDE.md §3);
 *   · another tenant's listing, an unknown id and a listing the caller may not open all answer the same 404;
 *   · a read that is refused refuses (503), never passes.
 */
export async function POST(request: NextRequest) {
  const gate = await requireCronOrSessionCaller(request)
  if (!gate.ok) return gate.response
  const caller = gate.caller

  try {
    let body: { listing_id?: unknown } | null = null
    try { body = await request.json() } catch { return NextResponse.json({ error: "Invalid request body" }, { status: 400 }) }
    const listing_id = body?.listing_id
    if (!listing_id) {
      return NextResponse.json({ error: "listing_id required" }, { status: 400 })
    }
    if (typeof listing_id !== "string" || !isValidUUID(listing_id)) {
      return NextResponse.json({ error: "listing_id must be a valid id" }, { status: 400 })
    }

    if (caller.kind === "session") {
      const { data: listing, error: listingError } = await caller.supabase
        .from("listings")
        .select("id, brokerage_id, agent_id")
        .eq("id", listing_id)
        .eq("brokerage_id", caller.brokerageId)
        .maybeSingle()
      if (listingError) {
        console.error("[listing-health-scan] POST gate could not run:", listingError.message)
        return NextResponse.json({ error: "Your access to this listing could not be confirmed. Try again in a moment." }, { status: 503 })
      }
      if (!listing) {
        return NextResponse.json({ error: "Listing not found" }, { status: 404 })
      }
      // An agent seat (or a seat with no type recorded — the restrictive reading) rescans only its OWN listing.
      if ((caller.userType ?? "agent") === "agent") {
        const ownAgentId = await resolveUserIdToAgentRecord(caller.userId, caller.brokerageId)
        if (!ownAgentId || (listing as { agent_id?: string | null }).agent_id !== ownAgentId) {
          return NextResponse.json({ error: "Listing not found" }, { status: 404 })
        }
      }
    }

    const result = await calculateListingHealth({ listingId: listing_id })
    return NextResponse.json({
      success:      true,
      overallScore: result.overallScore,
      riskLevel:    result.riskLevel,
      scoreDelta:   result.scoreDelta,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Rescan failed"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

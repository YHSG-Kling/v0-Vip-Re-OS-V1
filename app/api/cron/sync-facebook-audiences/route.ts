// app/api/cron/sync-facebook-audiences/route.ts
// Layer 9.5 — CRON job to sync approved Facebook custom audiences
// Runs every 24 hours to keep audiences up to date

import { type NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { syncAudience } from "@/lib/ads/facebook-audience-sync"

export const runtime = "nodejs"
export const maxDuration = 300 // 5 minutes

export async function GET(request: NextRequest) {
  // ── 1. Verify CRON_SECRET ───────────────────────────────────────────────────
  const authHeader = request.headers.get("authorization")
  const cronSecret = process.env.CRON_SECRET

  if (!cronSecret) {
    console.error("[sync-facebook-audiences] CRON_SECRET not configured")
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 })
  }

  if (authHeader !== `Bearer ${cronSecret}`) {
    console.error("[sync-facebook-audiences] Unauthorized request")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const supabase = createServiceClient()
  const results: Array<{
    audienceId: string
    audienceName: string
    status: "synced" | "skipped" | "failed"
    recordsSynced?: number
    error?: string
  }> = []

  try {
    // ── 2. Get audiences that need syncing ────────────────────────────────────
    // Criteria: status = 'approved' AND (last_synced_at IS NULL OR last_synced_at < now() - 24 hours)
    const twentyFourHoursAgo = new Date()
    twentyFourHoursAgo.setHours(twentyFourHoursAgo.getHours() - 24)

    const { data: audiences, error: fetchError } = await supabase
      .from("facebook_custom_audiences")
      .select("id, brokerage_id, audience_name, status, last_synced_at")
      .eq("status", "approved")
      .or(`last_synced_at.is.null,last_synced_at.lt.${twentyFourHoursAgo.toISOString()}`)
      .limit(50) // Process up to 50 per run

    if (fetchError) {
      console.error("[sync-facebook-audiences] Failed to fetch audiences:", fetchError)
      return NextResponse.json({ error: fetchError.message }, { status: 500 })
    }

    if (!audiences || audiences.length === 0) {
      console.log("[sync-facebook-audiences] No audiences need syncing")
      return NextResponse.json({
        success: true,
        message: "No audiences need syncing",
        processed: 0,
      })
    }

    console.log(`[sync-facebook-audiences] Found ${audiences.length} audiences to sync`)

    // ── 3. Check for already-running syncs (idempotency) ──────────────────────
    for (const audience of audiences) {
      // Check if there's already a running sync for this audience
      const { data: runningSync } = await supabase
        .from("audience_sync_runs")
        .select("id")
        .eq("audience_id", audience.id)
        .eq("run_status", "running")
        .maybeSingle()

      if (runningSync) {
        console.log(`[sync-facebook-audiences] Skipping ${audience.audience_name} - sync already running`)
        results.push({
          audienceId: audience.id,
          audienceName: audience.audience_name,
          status: "skipped",
          error: "Sync already running",
        })
        continue
      }

      // ── 4. Sync the audience ────────────────────────────────────────────────
      try {
        console.log(`[sync-facebook-audiences] Syncing audience: ${audience.audience_name}`)

        const syncResult = await syncAudience(
          "system", // CRON uses system user
          {
            brokerageId: audience.brokerage_id,
            agentId: "system",
            audienceId: audience.id,
          }
        )

        if (syncResult.success) {
          console.log(
            `[sync-facebook-audiences] Successfully synced ${audience.audience_name}: ${syncResult.recordsSynced} records`
          )
          results.push({
            audienceId: audience.id,
            audienceName: audience.audience_name,
            status: "synced",
            recordsSynced: syncResult.recordsSynced,
          })
        } else {
          console.error(
            `[sync-facebook-audiences] Failed to sync ${audience.audience_name}: ${syncResult.error}`
          )
          results.push({
            audienceId: audience.id,
            audienceName: audience.audience_name,
            status: "failed",
            error: syncResult.error,
          })
        }
      } catch (err: any) {
        console.error(`[sync-facebook-audiences] Error syncing ${audience.audience_name}:`, err)
        results.push({
          audienceId: audience.id,
          audienceName: audience.audience_name,
          status: "failed",
          error: err.message,
        })
      }
    }

    // ── 5. Return summary ─────────────────────────────────────────────────────
    const synced = results.filter((r) => r.status === "synced").length
    const skipped = results.filter((r) => r.status === "skipped").length
    const failed = results.filter((r) => r.status === "failed").length

    console.log(
      `[sync-facebook-audiences] Completed: ${synced} synced, ${skipped} skipped, ${failed} failed`
    )

    return NextResponse.json({
      success: true,
      summary: {
        total: audiences.length,
        synced,
        skipped,
        failed,
      },
      results,
    })
  } catch (err: any) {
    console.error("[sync-facebook-audiences] Unexpected error:", err)
    return NextResponse.json(
      {
        error: err.message || "Unexpected error",
        results,
      },
      { status: 500 }
    )
  }
}

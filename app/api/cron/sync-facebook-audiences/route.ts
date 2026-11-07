// app/api/cron/sync-facebook-audiences/route.ts
// Layer 9.5 — CRON job to sync approved Facebook custom audiences
// Runs every 24 hours to keep audiences up to date

import { type NextRequest, NextResponse } from "next/server"
import { verifyCronAuth } from "@/lib/cron-auth"
import { createServiceClient } from "@/lib/supabase/service"
// THE UNATTENDED DOOR. This used to import the `"use server"` action
// `lib/ads/facebook-audience-sync.ts:syncAudience` and call it as
// `syncAudience("system", { brokerageId, agentId: "system", audienceId })` —
// i.e. it asserted its own identity with the literal string "system".
//
// That action now resolves the tenant from the SESSION (it was a public endpoint
// where a caller-supplied brokerage uuid was enough to upload another tenant's
// consented contacts to Meta — orphan burn-down w2s2 closed that). A cron has no
// session, so routing through the action would fail every audience, every night,
// with "Not authenticated".
//
// The action is a session-gated door onto the kernel command; this is the
// unattended door onto the SAME command. The cron does not need to assert an
// identity because it never takes a tenant from a caller: `brokerage_id` is read
// off the `facebook_custom_audiences` row it is already syncing, and the kernel
// re-scopes its own reads to that same brokerage. (Same shape as
// app/actions/ai-listing-presentation.ts:generateListingPresentation, whose work
// lives in a library so the unattended prep chain has its own entry point.)
import { syncAudience as kernelSyncAudience } from "@/lib/kernel/ads"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"

export const runtime = "nodejs"
export const maxDuration = 300 // 5 minutes

export async function GET(request: NextRequest) {
  // ── 1. Verify CRON_SECRET ───────────────────────────────────────────────────
  // The ONE cron gate (lib/cron-auth.ts) — unset secret → 500, bad credential → 401.
  const denied = verifyCronAuth(request)
  if (denied) return denied

  const contextResult = await createCronRunContextAction({
    cron_name: "sync-facebook-audiences",
    cron_path: "/app/api/cron/sync-facebook-audiences/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  const startRecordResult = await recordCronStartAction({ context_id: contextId })
  if (!startRecordResult.success) {
    console.error("[SyncFacebookAudiences] Failed to record cron start:", startRecordResult.error)
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
    // WAVE 150 (lane 150QTV — owner ruling R4, 2026-11-06): "sync AUTOMATICALLY after approval / eligibility … revocations sync
    // the same way". This used to select status 'approved' only — and the upload writes 'synced', so a live audience was never
    // re-uploaded and a person who opted out stayed in it on the platform. The audiences are now chosen by EVIDENCE
    // (lib/ads/persona-audience.ts audiencesNeedingResync: first upload after approval, a failed upload, or a tenant whose
    // contacts / suppression list changed after the last upload — unreadable evidence re-syncs, toward the revocation). Every
    // upload is a full replace on the platform, so a re-sync is how a revocation leaves. Same tick, no new timer.
    const { audiencesNeedingResync } = await import("@/lib/ads/persona-audience")
    const picked = await audiencesNeedingResync(supabase, { limit: 50 })
    if (!picked.ok) {
      console.error("[sync-facebook-audiences] Failed to select audiences:", picked.error)
      await recordCronFailureAction({ context_id: contextId, error: new Error(picked.error), stage: "select-audiences" })
      return NextResponse.json({ error: picked.error }, { status: 500 })
    }
    for (const n of picked.notes) console.warn(`[sync-facebook-audiences] ${n}`)
    const audiences = picked.audiences

    if (audiences.length === 0) {
      console.log("[sync-facebook-audiences] No audiences need syncing")
      await recordCronSuccessAction({ context_id: contextId, records_processed: 0, output_count: 0, metadata: { synced: 0, skipped: 0, failed: 0 } })
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
        console.log(`[sync-facebook-audiences] Syncing audience: ${audience.audience_name} (${audience.reason})`)

        // The tenant comes from the row being synced, never from a caller.
        // `agentId` / `userId` are carried as empty strings because the kernel
        // command reads NEITHER — it scopes every query on ctx.brokerageId
        // alone. They are deliberately not filled with "system": that is not a
        // uuid, and writing it into an id column would raise 22P02 the moment
        // the kernel ever started persisting the actor.
        const syncResult = await kernelSyncAudience({
          ctx: { brokerageId: audience.brokerage_id, agentId: "", userId: "" },
          audienceId: audience.id,
        })

        // The kernel returns the raw `audience_sync_runs` row; the server action
        // used to flatten it for its own callers. Read the same field here.
        const recordsSynced = (syncResult.syncRun as { records_synced?: number } | undefined)
          ?.records_synced ?? 0

        if (syncResult.success) {
          console.log(
            `[sync-facebook-audiences] Successfully synced ${audience.audience_name}: ${recordsSynced} records`
          )
          results.push({
            audienceId: audience.id,
            audienceName: audience.audience_name,
            status: "synced",
            recordsSynced,
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

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: audiences.length,
      output_count: synced,
      metadata: { synced, skipped, failed },
    })

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
    await recordCronFailureAction({ context_id: contextId, error: err, stage: "main-processing" })
    return NextResponse.json(
      { error: err.message || "Unexpected error", results, context_id: contextId },
      { status: 500 }
    )
  }
}

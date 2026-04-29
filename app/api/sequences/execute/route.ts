/**
 * app/api/sequences/execute/route.ts
 *
 * Vercel Cron: runs every 15 minutes.
 * Queries sequence_enrollments WHERE status='active' AND next_step_at <= now()
 * Executes up to 50 per invocation to prevent timeout.
 *
 * Auth: Authorization: Bearer CRON_SECRET header (Vercel injects automatically).
 * No user session required — uses service role internally.
 */

import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { executeSequenceStep } from "@/lib/campaign-sequences/step-executor"

const LIMIT = 50

export async function GET(request: NextRequest) {
  // ── Auth: verify Vercel cron secret (fail-closed) ─────────────────────────
  // If CRON_SECRET is not configured, we reject ALL requests rather than
  // allowing an unprotected execution path in misconfigured deployments.
  const cronSecret = process.env.CRON_SECRET
  const authHeader = request.headers.get("authorization")

  if (!cronSecret) {
    console.error("[sequences/execute] CRON_SECRET env var is not set — rejecting request")
    return NextResponse.json({ error: "Service misconfigured" }, { status: 503 })
  }

  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const supabase = createServiceClient()
  const now = new Date().toISOString()

  // ── Query: enrollments due for execution ────────────────────────────────────
  const { data: dueEnrollments, error } = await supabase
    .from("sequence_enrollments")
    .select("id")
    .eq("status", "active")
    .lte("next_step_at", now)
    .not("next_step_at", "is", null)
    .order("next_step_at", { ascending: true })
    .limit(LIMIT)

  if (error) {
    console.error("[sequences/execute] DB query error:", error.message)
    return NextResponse.json(
      { error: "DB query failed", details: error.message, timestamp: now },
      { status: 500 }
    )
  }

  const enrollments = dueEnrollments ?? []

  let processed = 0
  let blocked = 0
  let failed = 0

  // ── Execute each enrollment step sequentially to avoid race conditions ──────
  for (const enrollment of enrollments) {
    try {
      const result = await executeSequenceStep(enrollment.id)

      if (result.status === "sent" || result.status === "completed" || result.status === "skipped") {
        processed++
      } else if (result.status === "authority_blocked") {
        blocked++
      } else {
        failed++
      }
    } catch (err) {
      failed++
      console.error(`[sequences/execute] Step error for enrollment ${enrollment.id}:`, err)
    }
  }

  return NextResponse.json({
    processed,
    blocked,
    failed,
    total: enrollments.length,
    limit: LIMIT,
    timestamp: now,
  })
}

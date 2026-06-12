/**
 * app/api/cron/geo-reel-autopublish/route.ts — GEO auto-publish sweep.
 *
 * The TRIGGER that closes the GEO loop: today a public /v/[slug] page is minted
 * only by the MANUAL Asset Manager publish_video_page action (or the agent-facing
 * publishRenderToWeb). This sweep AUTO-publishes every canonical reel that is
 * finished, compliance-passed, AND broker-approved but not yet public — so a
 * broker-approved reel lands as an AI-search-citable page (ChatGPT / Perplexity /
 * Gemini / Google AI Overviews) the moment it clears approval, with zero manual
 * step.
 *
 * THE GATE (isAutoPublishEligible, enforced again inside publishVideoProjectLanding):
 *   ai_video_projects.status='completed'
 *     AND compliance_status='passed'      (Fair-Housing / EHO / license disclosures)
 *     AND approval_status='approved'      (broker sign-off — a public page is broadcast advertising)
 *     AND is_published=false              (idempotent — never double-publish)
 * Only approved + compliant reels become public.
 *
 * Lowest-risk shape: a thin idempotent sweep over the EXISTING completion state
 * (the partial index ai_video_projects_autopublish_idx keeps the scan cheap),
 * mirroring asset-manager-weekly's CRON_SECRET auth + brokerage-agnostic loop.
 * It never renders, never spends, never sends — it only flips an approved reel
 * public through the EXISTING publishVideoProjectLanding helper.
 *
 * Auth: CRON_SECRET. Registered in lib/kernel/cron-dispatch.ts (one heartbeat).
 */
import { NextResponse, type NextRequest } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { publishVideoProjectLanding } from "@/lib/geo/publish-video-landing"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 120

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

export async function GET(req: NextRequest) {
  const auth     = req.headers.get("authorization")?.replace("Bearer ", "")
  const qs       = new URL(req.url).searchParams.get("secret")
  const expected = process.env.CRON_SECRET
  if (!expected) return NextResponse.json({ skipped: "CRON_SECRET not configured" })
  if (auth !== expected && qs !== expected) return unauthorized()

  const svc = createServiceClient()

  // Eligible reels — the gate, pushed down to SQL so the sweep is cheap.
  // publishVideoProjectLanding re-checks isAutoPublishEligible per row, so the
  // gate holds even if a row changes state between this scan and the publish.
  const { data, error } = await svc.from("ai_video_projects")
    .select("id, brokerage_id")
    .eq("is_published", false)
    .eq("status", "completed")
    .eq("compliance_status", "passed")
    .eq("approval_status", "approved")
    .not("video_url", "is", null)
    .order("completed_at", { ascending: true })
    .limit(200)
  if (error) {
    return NextResponse.json({ error: "scan failed", details: error.message }, { status: 500 })
  }

  const reels = (data ?? []) as Array<{ id: string; brokerage_id: string | null }>
  const results: Array<{ project_id: string; ok: boolean; slug?: string; reason?: string }> = []
  let published = 0

  for (const reel of reels) {
    if (!reel.brokerage_id) {
      results.push({ project_id: reel.id, ok: false, reason: "missing brokerage_id" })
      continue
    }
    try {
      const res = await publishVideoProjectLanding({ projectId: reel.id, brokerageId: reel.brokerage_id })
      if (res.ok) published++
      results.push({ project_id: reel.id, ok: res.ok, slug: res.slug, reason: res.reason })
    } catch (e) {
      results.push({ project_id: reel.id, ok: false, reason: (e as Error).message })
    }
  }

  return NextResponse.json({
    ran_at: new Date().toISOString(),
    scanned: reels.length,
    published,
    results,
  })
}

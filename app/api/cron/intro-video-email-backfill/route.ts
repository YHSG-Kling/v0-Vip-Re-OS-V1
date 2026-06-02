/**
 * app/api/cron/intro-video-email-backfill/route.ts
 *
 * Backfill the assignment-intro email once the D-ID render has landed.
 *
 * The intro-video-reactor in lib/video/intro-video-reactor.ts deliberately does
 * NOT send a placeholder email — D-ID renders are async and the placeholder
 * approach would (a) send a "video coming soon" email and (b) need a second
 * email when the URL arrives. Instead this cron sweeps every 2 minutes:
 *
 *   For agent_intro_videos rows where:
 *     - status = 'rendering'
 *     - trigger = 'contact_agent_assigned' (per the app rule: contacts are
 *       assigned to agents — m123 renamed this from the old 'lead_assigned'
 *       value). Home-anniversary videos are portal-only by design and don't
 *       need the email backfill.
 *     - delivery_channel includes 'email' (i.e. 'email' or 'both')
 *     - the linked ai_video_projects.video_url is populated (the
 *       poll-did-videos cron has finished downloading the render to OUR
 *       Supabase storage and written the canonical URL)
 *
 *   Send the email via dispatchEmail with the video embedded using OUR URL
 *   (never D-ID's signed URL — which expires in ~24h), then update the
 *   ledger to status='delivered', delivered_at=now().
 *
 * Auth: CRON_SECRET — same pattern as the rest of the cron fleet.
 */
import { NextResponse, type NextRequest } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { dispatchEmail } from "@/lib/providers/dispatch"
import { embedVideoInEmail } from "@/lib/ai-isa/video-generator"

export const dynamic = "force-dynamic"
export const maxDuration = 300

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

interface BackfillRow {
  id:                  string
  brokerage_id:        string
  contact_id:          string
  agent_id:            string
  video_project_id:    string | null
  delivery_channel:    string
  contact: {
    first_name: string | null
    email:      string | null
    video_opt_out: boolean | null
  } | null
  project: {
    video_url:   string | null
    status:      string | null
    title:       string | null
  } | null
}

export async function GET(req: NextRequest) {
  const headerSecret = req.headers.get("authorization")?.replace("Bearer ", "")
  const querySecret  = new URL(req.url).searchParams.get("secret")
  const expected     = process.env.CRON_SECRET
  if (!expected) return NextResponse.json({ skipped: "CRON_SECRET not configured" })
  if (headerSecret !== expected && querySecret !== expected) return unauthorized()

  const svc = createServiceClient()

  // Up to 50 ready rows per tick — drains backlog across runs.
  const { data: rows, error } = await svc
    .from("agent_intro_videos")
    .select(`
      id, brokerage_id, contact_id, agent_id, video_project_id, delivery_channel,
      contact:contacts(first_name, email, video_opt_out),
      project:ai_video_projects!agent_intro_videos_video_project_id_fkey(video_url, status, title)
    `)
    .eq("status", "rendering")
    .eq("trigger", "contact_agent_assigned")
    .in("delivery_channel", ["email", "both"])
    .not("video_project_id", "is", null)
    .order("created_at", { ascending: true })
    .limit(50)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const results: Array<{ id: string; outcome: string; reason?: string }> = []

  for (const r of (rows ?? []) as unknown as BackfillRow[]) {
    if (!r.project?.video_url) {
      // D-ID render still in flight — wait for the next tick.
      continue
    }
    if (!r.contact?.email) {
      await svc.from("agent_intro_videos")
        .update({ status: "failed", error_message: "contact has no email at send time" })
        .eq("id", r.id)
      results.push({ id: r.id, outcome: "failed", reason: "no_contact_email" })
      continue
    }
    if (r.contact.video_opt_out) {
      // Contact opted out between render start and send — honor the change.
      await svc.from("agent_intro_videos")
        .update({ status: "suppressed", error_message: "video_opt_out flipped during render" })
        .eq("id", r.id)
      results.push({ id: r.id, outcome: "suppressed", reason: "late_opt_out" })
      continue
    }

    // Compose the email body — the agent video embeds via the canonical
    // helper so the markup matches every other video-bearing send across
    // the platform.
    const firstName = r.contact.first_name ?? ""
    const subject   = `${firstName ? firstName + ", " : ""}a quick intro from your agent`
    const baseHtml  = `
      <p>Hi ${firstName},</p>
      <p>I wanted to introduce myself the easiest way I could — by video.</p>
      <p>[Video will be embedded here]</p>
      <p>Reply back any time. Looking forward to working with you.</p>
    `
    const html = await embedVideoInEmail(baseHtml, r.project.video_url)

    const result = await dispatchEmail({
      brokerageId:    r.brokerage_id,
      userId:         r.agent_id,
      contactId:      r.contact_id,
      systemSource:   "intro_video_email_backfill",
      channelPurpose: "conversation",
      from:           "agent@platform.com",
      to:             r.contact.email,
      subject,
      html,
      metadata: {
        ai_video_project_id: r.video_project_id,
        intro_video_id:      r.id,
      },
    })

    if (result.success) {
      await svc.from("agent_intro_videos")
        .update({ status: "delivered", delivered_at: new Date().toISOString() })
        .eq("id", r.id)
      results.push({ id: r.id, outcome: "delivered" })
    } else {
      // dispatchEmail returns providerKey='deconflict_gate' or
      // 'compliance_gate' on gated suppressions. Surface those as 'suppressed'
      // rather than 'failed' since the email gate did its job.
      const gated = result.providerKey === "deconflict_gate" || result.providerKey === "compliance_gate"
      await svc.from("agent_intro_videos")
        .update({
          status:        gated ? "suppressed" : "failed",
          error_message: result.error ?? null,
        })
        .eq("id", r.id)
      results.push({ id: r.id, outcome: gated ? "suppressed" : "failed", reason: result.error ?? undefined })
    }
  }

  return NextResponse.json({
    ran_at:    new Date().toISOString(),
    processed: results.length,
    results,
  })
}

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { requireAuth } from "@/lib/kernel/api-auth"

// TRUE ADMIN GATE (operational: marketing-content approval) — repointed to the
// ONE tenant roster below. 'superadmin' was dead: 0 live rows store that
// users.user_type.
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  if (!isAdminOrBroker({ user_type: auth.userType })) {
    return NextResponse.json({ error: "Only brokers and admins can approve scripts" }, { status: 403 })
  }

  // Verify the script belongs to the caller's brokerage before mutating
  const svc = createServiceClient()
  const { data: existing } = await svc
    .from("video_scripts_library")
    .select("brokerage_id, agent_id")
    .eq("id", id)
    .maybeSingle()
  if (!existing) return NextResponse.json({ error: "Script not found" }, { status: 404 })
  if (existing.brokerage_id !== auth.brokerageId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { data: script, error } = await supabase
    .from("video_scripts_library")
    .update({
      approval_status: "approved",
      approved_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("brokerage_id", auth.brokerageId)
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  /* ───────────────────────────────────────────────────────────────────────────
   * TOMBSTONE — the `video_assets` insert that used to sit here was REMOVED.
   * It had never once succeeded, and it made a SUCCESSFUL approval look failed.
   *
   * WHAT IT WROTE: `{ brokerage_id, agent_id, script, status: "queued",
   * video_type }` into `video_assets`. That table has none of `script`,
   * `status` or `video_type` — it is the stock-media library (license_url,
   * music_loop, tags, duration_seconds), not a render queue. PostgREST refuses
   * an INSERT naming an absent column ENTIRELY (PGRST204), so the insert could
   * only ever error, and the `if (videoError) return 500` below it reported the
   * whole request as failed AFTER the approval UPDATE had already committed.
   * Approving a script therefore appeared to fail every single time while
   * silently having worked.
   *
   * WHY IT WAS INVISIBLE FOR ITS WHOLE LIFE: the schema-drift guard read RAW
   * SOURCE, and the trailing comment on the agent_id line — "use the script's
   * agent" — has an apostrophe in "script's". The object-key parser read it as
   * an opening string literal and swallowed everything after it, so `status`
   * and `video_type` were never checked. The guard now blanks comments before
   * scanning (scripts/schema-drift-guard.ts), which is what surfaced this.
   *
   * SURVIVOR, and it is a genuinely different shape of thing:
   * `createVideoProject` at app/actions/video/create-video-project.ts:499
   * writes `ai_video_projects` — the real render queue, with the m374 status
   * vocabulary, the compliance columns and `source_script_id` lineage. Note
   * that `source_script_id` FKs `public.scripts`, NOT `video_scripts_library`
   * (app/actions/copilot.ts:589), so a curated-library row cannot stamp it
   * anyway. An approved library script reaches a render through the video
   * wizard's Script Library tab, which loads from this table and submits
   * through that survivor.
   *
   * Nothing is lost by deleting this: queuing from here never worked, and the
   * path that does work is one the agent already uses.
   * ────────────────────────────────────────────────────────────────────────── */
  return NextResponse.json({ script })
}

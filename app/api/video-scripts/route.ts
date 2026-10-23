/**
 * Layer 8.1 Video Scripts Library API
 *
 * CRUD operations for video_scripts_library table.
 *
 * CRITICAL RULES:
 * - Uses public.video_scripts_library (canonical table)
 * - NEVER references public.video_scripts or public.script_templates
 * - All writes must go through kernel governance
 */

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// TOMBSTONE (§1.3 orphan doctrine — scripts/handler-parity-census.ts,
// 2026-09-11): GET, POST and PATCH used to live here — ZERO in-tree callers
// for any of the three (only DELETE, below, is still fetched, from
// app/dashboard/videos/library/page.tsx:436). The functionality already
// lives elsewhere, and the library page's own comment already recorded HALF
// of that move:
//
//   · GET (list + single-script fetch) → app/actions/video-generation.ts::
//     getVideoScriptLibrary(), called from loadScripts() in the library page
//     with the comment "Server action rather than the /api/video-scripts
//     fetch: it derives the brokerage from the session instead of trusting
//     the URL" — this GET took brokerage scope from the session correctly,
//     but the migration to a server action was the point, not a bug in this
//     GET specifically.
//   · POST (create) → app/actions/video/generate-script.ts, the gated script
//     creator the rest of the video surface uses (canonical creator per
//     app/actions/video/create-video-project.ts). This POST additionally let
//     the caller set `approval_status` and `agent_id` directly off the
//     request body with no role gate — dead here, but the shape §4 warns
//     against, and worth being gone rather than merely unused.
//   · PATCH (update / approve / reject) → app/actions/video-generation.ts::
//     updateScriptApprovalStatus(), which lib/kernel/manager-registry.ts's
//     video_script_approval_single_writer entry already names as the
//     survivor of this exact defect class: two now-deleted sibling routes
//     ([id]/approve, [id]/reject) were the ONLY callers that gated approval
//     on isAdminOrBroker, while the path everyone actually used had none.
//     This PATCH was the SAME gap a third time over — a bare `...updates`
//     spread onto the row, so an approval_status flip (including by a
//     script's own author) needed no admin/broker role at all — now closed
//     by deleting the third ungated door rather than adding a fourth gate.
//
// DELETE is UNTOUCHED: it is the one method still reached by fetch, it is
// tenant-scoped (session → brokerage_id, never the URL), and it is a soft
// delete with no approval-authority question to gate.

// ─── DELETE: Soft delete script ──────────────────────────────────────────────

export async function DELETE(req: Request) {
  try {
    const supabase = await createClient()
    const { searchParams } = new URL(req.url)
    const id = searchParams.get("id")

    if (!id) {
      return NextResponse.json({ error: "Script id is required" }, { status: 400 })
    }

    // Auth check
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Get user's brokerage
    const { data: userRecord } = await supabase
      .from("users")
      .select("brokerage_id")
      .eq("id", user.id)
      .single()

    if (!userRecord?.brokerage_id) {
      return NextResponse.json({ error: "No brokerage found" }, { status: 403 })
    }

    // Soft delete
    const { error } = await supabase
      .from("video_scripts_library")
      .update({ is_active: false })
      .eq("id", id)
      .eq("brokerage_id", userRecord.brokerage_id)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (error: any) {
    console.error("[video-scripts] DELETE error:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

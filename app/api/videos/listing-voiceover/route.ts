/**
 * POST /api/videos/listing-voiceover
 * Cheapest video type: no avatar needed.
 * Generates ElevenLabs TTS voiceover over property images.
 * The client stitches images + audio into a slideshow video.
 *
 * Body: {
 *   video_project_id: string,
 *   script: string,
 *   elevenlabs_voice_id: string,
 *   property_image_urls: string[],  // in display order
 * }
 * Returns: { audio_url: string, property_image_urls: string[], video_project_id: string }
 *
 * ── UNRESOLVED, AND DELIBERATELY LEFT STANDING (lane G1, 2026-08-28) ─────────
 * The census reports this route under 6b ("nothing in the tree addresses it").
 * That is true, and it is HALF the story: the rail is unfinished at BOTH ends.
 *   · NO CALLER. Nothing in the tree POSTs here.
 *   · NO COMPLETER. The handler leaves the row at status 'generating' /
 *     provider_status 'audio_ready' and says "the client stitches images +
 *     audio". No such stitcher exists anywhere in this repo, so a row that DID
 *     reach here would sit in flight until the pipeline reaper aged it out
 *     (lib/video/video-status.ts:126 records exactly that phase; the reaper
 *     covers it — scripts/video-pipeline-reaper-simulator.ts:40).
 *
 * WHY IT IS NOT DELETED AS "the functionality lives elsewhere". The nearest
 * survivor candidate is the Ken Burns walkthrough rail — commissionVideo →
 * lib/video/video-director.ts:309 (situation photo_walkthrough) →
 * remotion/PhotoWalkthroughReel.tsx → Lambda render → publish, wired from
 * lib/video/video-plays.ts:131 and lib/kernel/jobs.ts:85. Same OUTCOME (listing
 * photos + narration → a video) but NOT the same business process:
 *   · that rail sources photos from listing_media and the script from the
 *     Director, and passes a compliance gate + finish-spec before it renders;
 *   · this route takes CALLER-SUPPLIED photo urls, a CALLER-SUPPLIED script and
 *     a CALLER-CHOSEN ElevenLabs voice, and gates none of it.
 * Per the owner's 2026-08-28 methodology ruling — a shared outcome is not a
 * shared capability — those are two processes, and deleting this one would be
 * deleting to move a number. OWNER DECISION: either (a) retire this route in
 * favour of the walkthrough rail and give the "my photos, my script" case a door
 * onto commissionVideo, or (b) finish this rail with a real renderer. Until then
 * it stays, hardened (see the tenant gate below, which it did not have).
 */

import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import { isValidUUID } from "@/lib/validations"

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()
    const auth = await requireAuth(supabase)
    if (!auth.ok) return auth.response

    const body = await request.json()
    const { video_project_id, script, elevenlabs_voice_id, property_image_urls } = body

    if (!video_project_id || !script || !elevenlabs_voice_id || !Array.isArray(property_image_urls)) {
      return NextResponse.json(
        { error: "Missing required fields: video_project_id, script, elevenlabs_voice_id, property_image_urls" },
        { status: 400 }
      )
    }

    if (!isValidUUID(video_project_id)) {
      return NextResponse.json({ error: "Invalid project id" }, { status: 400 })
    }

    // THE NAMED PROJECT MUST BE THE CALLER'S (CLAUDE.md §4).
    //
    // requireAuth resolved a brokerage above and then NOTHING used it: the write
    // below keyed on `.eq("id", video_project_id)` alone, so any signed-in user
    // could name any project id on the platform and overwrite its status,
    // provider_status and provider_metadata with their own audio — and append a
    // video_render_log row against it. The tenant is resolved from the SESSION
    // and compared for EQUALITY here, which is also why RLS is not the backstop:
    // ai_video_projects.brokerage_id is NULLABLE and every policy admits
    // `brokerage_id IS NULL`, so an untenanted row satisfies the predicate for
    // every brokerage. An equality test is the only thing a NULL cannot pass.
    const { data: project, error: projectError } = await supabase
      .from("ai_video_projects")
      .select("id, brokerage_id")
      .eq("id", video_project_id)
      .maybeSingle()
    // supabase-js RESOLVES a refusal (§3): without reading the error, a refused
    // read is byte-identical to "no such project" and would answer 404 for what
    // is really a broken read.
    if (projectError) {
      console.error("[ListingVoiceover] project read refused:", projectError)
      return NextResponse.json({ error: "Failed to verify project" }, { status: 500 })
    }
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 })
    }
    if (project.brokerage_id !== auth.brokerageId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    // Generate ElevenLabs TTS and upload to storage
    const ttsRes = await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/elevenlabs/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: request.headers.get("cookie") ?? "" },
      body: JSON.stringify({
        text: script,
        voice_id: elevenlabs_voice_id,
        upload_to_storage: true,
      }),
    })

    const ttsData = await ttsRes.json()
    if (!ttsRes.ok || !ttsData.audio_url) {
      return NextResponse.json({ error: "Failed to generate voiceover audio" }, { status: 500 })
    }

    // Update project with audio URL — client handles slideshow rendering.
    // Tenant-scoped on the way in as well as gated above, and `.select()`ed so a
    // predicate that matched nothing is distinguishable from a write that
    // landed: an UPDATE matching zero rows resolves with error === null (§3).
    const { data: updated, error: updateError } = await supabase
      .from("ai_video_projects")
      .update({
        // The voiceover exists but the slideshow video does not — this row is
        // still IN FLIGHT, not finished. provider_status keeps the finer-grained
        // 'audio_ready' detail; ai_video_projects.status is the one vocabulary.
        status: "generating",
        provider_status: "audio_ready",
        provider_metadata: {
          provider: "slideshow",
          audio_url: ttsData.audio_url,
          property_image_urls,
        },
        error_message: null,
      })
      .eq("id", video_project_id)
      .eq("brokerage_id", auth.brokerageId)
      .select("id")

    if (updateError) {
      console.error("[ListingVoiceover] project update refused:", updateError)
      return NextResponse.json({ error: "Failed to attach the voiceover" }, { status: 500 })
    }
    if (!updated || updated.length === 0) {
      // The gate passed a moment ago, so zero rows here means the row moved out
      // from under us (or the tenant predicate refused). Reporting success would
      // hand back an audio_url attached to nothing.
      return NextResponse.json({ error: "Failed to attach the voiceover" }, { status: 409 })
    }

    // `status` is NAMED rather than left on the column DEFAULT: the attempt list
    // an agent reads (app/components/content-studio/LinkToVideoGenerator.tsx:614)
    // renders this value, and an unnamed default is indistinguishable from an
    // attempt nobody ever updated. The voiceover IS the deliverable of this
    // route — the slideshow render is a later step — so the honest state of THIS
    // attempt is submitted, matching the project's own 'generating'.
    const { error: renderLogError } = await supabase.from("video_render_log").insert({
      project_id: video_project_id,
      brokerage_id: auth.brokerageId,
      provider: "elevenlabs_slideshow",
      status: "submitted",
    })
    // The ledger row is not the product — a refused insert is logged, and the
    // voiceover the caller paid for is still returned rather than discarded.
    if (renderLogError) {
      console.error("[ListingVoiceover] video_render_log insert refused:", renderLogError)
    }

    return NextResponse.json({
      success: true,
      audio_url: ttsData.audio_url,
      property_image_urls,
      video_project_id,
    })
  } catch (error: any) {
    console.error("[ListingVoiceover] error:", error)
    return NextResponse.json({ error: error.message ?? "Internal server error" }, { status: 500 })
  }
}

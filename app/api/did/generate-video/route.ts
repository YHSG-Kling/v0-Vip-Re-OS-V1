/**
 * POST /api/did/generate-video
 * Generates a talking-head avatar video using D-ID.
 *
 * Supports two source modes for the agent's appearance:
 *   - Photo mode  (agent_photo_url): D-ID animates a still headshot.
 *                  Best for: social/UGC content, market updates.
 *   - Video mode  (agent_video_url): D-ID lip-syncs a short clip of the agent
 *                  speaking/neutral. Produces realistic, high-quality results.
 *                  Best for: formal brand, listing presentations, agent intro.
 *
 * In both cases the voice audio comes from ElevenLabs TTS via the cloned voice.
 *
 * Body: {
 *   video_project_id: string,
 *   script: string,
 *   elevenlabs_voice_id: string,
 *   agent_photo_url?: string,   // preferred for UGC / social content
 *   agent_video_url?: string,   // preferred for formal / brand videos
 *   background?: { type: "color" | "image" | "video"; value: string },
 *   intro_video_url?: string,     // brokerage-curated clip prepended to the
 *                                 // branded main video
 *   outro_video_url?: string,     // brokerage-curated clip appended to the
 *                                 // branded main video
 *   b_roll_urls?: string[],       // splice candidates stored on the row for
 *                                 // the audit trail; segment splicing wired
 *                                 // in a follow-up
 * }
 * Provide at least one of agent_photo_url or agent_video_url.
 *
 * Background types:
 *   color  → static color behind the avatar (D-ID composites it pre-render)
 *   image  → static image behind the avatar (D-ID composites it pre-render)
 *   video  → EXPLAINER MODE. D-ID still renders just the talking head; the
 *            poll cron post-composites it as a bottom-right PIP over the
 *            background video (typical: property walkthrough, drone footage,
 *            screen recording). Logo moves to top-left, attribution band
 *            spans the bottom edge. The value is the public video URL.
 */

import { type NextRequest, NextResponse } from "next/server"
import { didRequest } from "@/lib/did/gateway"
import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { checkBrandCompliance } from "@/lib/kernel/brand-compliance"

const DID_API_BASE = "https://api.d-id.com"

export async function POST(request: NextRequest) {
  // Set once the render slot is atomically claimed, so the catch below knows
  // whether there is a reservation to release. Declared outside the try
  // because a throw before the claim must NOT release someone else's slot.
  let claimedProjectId: string | null = null

  try {
    const supabase = await createClient()
    const auth = await requireAuth(supabase)
    if (!auth.ok) return auth.response

    const didApiKey = process.env.DID_API_KEY
    const elApiKey = process.env.ELEVENLABS_API_KEY

    if (!didApiKey || !elApiKey) {
      return NextResponse.json(
        { error: "D-ID or ElevenLabs API key not configured" },
        { status: 503 }
      )
    }

    const body = await request.json()
    const {
      video_project_id,
      script,
      elevenlabs_voice_id,
      agent_photo_url,
      agent_video_url,
      // did_avatar_id: caller may pass a specific avatar from the library
      did_avatar_id: callerAvatarId,
      background,
      ugc_mode,
      intro_video_url,
      outro_video_url,
      b_roll_urls,
      // Optional: request the full avatar→Remotion chain. When target_composition_id
      // is set, the poll-did-videos cron hands the finished D-ID video off to that
      // Remotion composition (avatar URL wired into input_props) on completion.
      target_composition_id,
      composition_voiceover_url,
      composition_input_props,
    } = body

    if (!video_project_id || !script || !elevenlabs_voice_id) {
      return NextResponse.json(
        { error: "Voice clone not set up. Configure your voice in Settings → Voice & Avatar before generating videos." },
        { status: 400 }
      )
    }

    // ─── Resolve D-ID avatar: prefer persistent avatar_id over raw source_url ──
    // Persistent avatars (created via /api/did/create-avatar) render faster and
    // more consistently because D-ID has already processed the source video.
    // Fall back to source_url for photo mode and legacy profiles without an avatar_id.
    let resolvedAvatarId: string | null = callerAvatarId ?? null
    if (!resolvedAvatarId && auth.userId) {
      // Check if agent has a ready default avatar in their library
      const { data: agentRow } = await supabase
        .from("agents")
        .select("id")
        .eq("user_id", auth.userId)
        .maybeSingle()

      if (agentRow?.id) {
        const { data: defaultAsset } = await supabase
          .from("agent_avatar_assets")
          .select("did_avatar_id")
          .eq("agent_id", agentRow.id)
          .eq("status", "ready")
          .eq("is_default", true)
          .maybeSingle()
        resolvedAvatarId = defaultAsset?.did_avatar_id ?? null
      }
    }

    const sourceUrl: string | undefined = agent_video_url ?? agent_photo_url
    // Need at least one of: a ready avatar_id OR a source URL
    if (!resolvedAvatarId && !sourceUrl) {
      return NextResponse.json(
        { error: "Avatar not set up. Upload your headshot or video clip in Settings → Voice & Avatar before generating videos." },
        { status: 400 }
      )
    }

    // When using a persistent avatar_id it's always a video-quality /clips render
    const isVideoSource = !!resolvedAvatarId || !!agent_video_url
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"

    // ─── Resolve usage_intent + bake real-estate ad-law disclosure ────────────
    // ai_video_projects.usage_intent (migration 1085) decides whether the
    // rendered video needs the legally-required brokerage disclosure:
    //   public_marketing / both → verbal disclosure appended to script
    //   mls                     → render is left clean (MLS forbids
    //                             agent / brokerage attribution)
    // ffmpeg-based visual overlay is deferred (per lib/did/index.ts notes),
    // so the disclosure goes into the script the avatar speaks.
    //
    // THE IMPLEMENTATION MOVED, VERBATIM, to lib/video/verbal-disclosure.ts:62
    // (applyBrokerageVerbalDisclosure) so the OTHER live D-ID door —
    // app/actions/video-generation.ts:generateVideoFromScript — can run the same
    // rule instead of running none. It had none: it rendered public-marketing
    // videos with no brokerage attribution and left has_verbal_disclosure false,
    // which lib/kernel/brand-compliance.ts:305 reports as a violation forever.
    // Two spellings of one legal requirement is the §6 defect; there is one now.
    //
    // The stamp is now DESTRUCTURED — this call site used to `await` the update
    // undestructured, so a refused stamp reported a compliant render over a
    // column that never changed.
    const { applyBrokerageVerbalDisclosure } = await import("@/lib/video/verbal-disclosure")
    const disclosure = await applyBrokerageVerbalDisclosure(supabase, {
      script,
      projectId: video_project_id,
      brokerageId: auth.brokerageId,
    })
    const renderScript: string = disclosure.renderScript
    const captionsEnabled: boolean = disclosure.captionsEnabled
    if (disclosure.stampError) {
      console.error("[D-ID] has_verbal_disclosure stamp refused:", disclosure.stampError)
    }

    // ─── THE FAIR HOUSING HOLD ────────────────────────────────────────────────
    //
    // OWNER RULING (the refinement): "after the script is run then hold up the
    // video creation if still have a big red flag needed for a human."
    //
    // THIS IS THE ONLY COMMON GATE ON THE WIZARD LANE.
    // app/dashboard/videos/create/video-create-client.tsx inserts
    // ai_video_projects DIRECTLY from the browser and then posts here — it never
    // touches createVideoProject — so a hard Fair Housing finding that had been
    // escalated to a human at script time reached D-ID untouched: the escalation
    // row sat at approval_status='pending_review' and nothing on this path had
    // ever read it.
    //
    // It runs BEFORE the slot claim and before the ElevenLabs/D-ID spend, on the
    // RAW script — not `renderScript`, which already carries the injected
    // brokerage disclosure and would make the human-approval text match fail.
    //
    // The brand-compliance gate below is a DIFFERENT check (approved hashtags,
    // brokerage avatar/voice, brand prohibited_language from global_settings)
    // and stays where it is; it has never looked at Fair Housing.
    //
    // ADVISORY PASSES. evaluateVideoRenderHold holds on red_flag and unknown
    // only, so a "safe area" or a ThemFirst slip renders exactly as before.
    //
    // UNCONDITIONAL — deliberately not wrapped in `if (auth.brokerageId)` the
    // way the brand gate below is. requireAuth already refuses a session with no
    // brokerage (403, api-auth.ts), so that condition could only ever be a way
    // for the gate to be skipped rather than a way for it to be needed.
    {
      const { evaluateVideoRenderHold, stampProjectComplianceHold, holdErrorMessage } =
        await import("@/lib/video/video-render-hold")
      const hold = await evaluateVideoRenderHold({
        supabase,
        actor: { userId: auth.userId, brokerageId: auth.brokerageId },
        script,
        projectId: video_project_id,
        title: "Held video script (render blocked)",
      })
      if (hold.hold) {
        // Record the hold ON THE PROJECT so the board and the admin queue can
        // both see it, and so a person has something to approve at the project
        // level too. Destructured — a refused stamp must not read as recorded.
        const stamped = await stampProjectComplianceHold(supabase, video_project_id, hold)
        if (!stamped.ok) {
          console.error("[D-ID] compliance hold could not be stamped on the project:", stamped.error)
        }
        return NextResponse.json(
          {
            error: holdErrorMessage(hold),
            compliance_hold: true,
            compliance_state: hold.state,
            violations: hold.reasons,
            review_id: hold.reviewId ?? null,
          },
          { status: 422 },
        )
      }
    }

    // ─── Brand compliance gate ────────────────────────────────────────────────
    if (auth.brokerageId) {
      const compliance = await checkBrandCompliance({
        contentType: "video",
        contentId: video_project_id,
        brokerageId: auth.brokerageId,
      })
      if (!compliance.passed) {
        await supabase
          .from("ai_video_projects")
          .update({ status: "failed", error_message: `Compliance: ${compliance.violations.join("; ")}` })
          .eq("id", video_project_id)
        return NextResponse.json(
          { error: "Brand compliance check failed", violations: compliance.violations },
          { status: 422 }
        )
      }
    }

    // ─── STEP 0: CLAIM THE RENDER SLOT, ATOMICALLY, BEFORE SPENDING ──────────
    //
    // OWNER RULING: this path and lib/kernel/video.ts:submitVideoGenerationJob
    // stay SEPARATE. They are not duplicates — this route carries the compliance
    // eval, verbal-disclosure injection, avatar-asset resolution, cinematic /
    // b-roll and video_render_log; the kernel carries the slot claim, the
    // provider_status bookkeeping and the rollback. Neither is a superset. So
    // this is a DEFECT FIX inside one lane, not a merge of the two.
    //
    // THE DEFECT: the kernel claims the slot atomically before it dispatches;
    // this route did not claim it at all. It called ElevenLabs and then D-ID and
    // only afterwards wrote status + provider_job_id, unconditionally. Two
    // requests for the same project therefore BOTH spent — TTS characters and a
    // D-ID render each — and the second overwrote the first's provider_job_id.
    // app/api/cron/poll-did-videos keys on that column, so the first render
    // became unpollable and could never complete: paid for, orphaned, invisible.
    // Both paths are reachable from the SAME board (videos/board/page.tsx posts
    // here; the Video Studio dialog calls the kernel action), so this is a
    // double-click away, not a theoretical race.
    //
    // The claim is the same predicate the kernel uses, which is what makes the
    // two lanes safe to keep separate: whichever one arrives second loses,
    // because the loser is decided by the database, not by the caller.
    const { data: claimed, error: claimError } = await supabase
      .from("ai_video_projects")
      .update({
        status: "generating",
        provider_status: "submitting",
        updated_at: new Date().toISOString(),
      })
      .eq("id", video_project_id)
      // ONE predicate, not two: the claim used to also exclude status='submitting',
      // but nothing in the codebase ever WROTE that value to ai_video_projects.status
      // (it was only ever a provider_status), and the m374 vocabulary merges
      // submitting → generating. The second .neq was dead either way.
      .neq("status", "generating")
      .select("id")

    if (claimError) {
      // Never spend on an unpersisted claim. A refused reservation read as
      // success is exactly how the provider gets billed for a render nothing
      // will ever collect.
      console.error("[D-ID] slot claim refused:", claimError.message)
      return NextResponse.json(
        { error: `Could not reserve the render slot: ${claimError.message}` },
        { status: 500 },
      )
    }
    if (!claimed?.length) {
      return NextResponse.json(
        { error: "Video generation is already in progress for this project" },
        { status: 409 },
      )
    }

    claimedProjectId = video_project_id

    // From here on the slot is OURS. Every failure exit below must release it,
    // or the project stays wedged in 'generating' with no provider_job_id and
    // the poller has nothing to chase.
    const releaseSlot = async (errorMessage: string) => {
      const { error: releaseError } = await supabase
        .from("ai_video_projects")
        .update({ status: "failed", provider_status: null, error_message: errorMessage })
        .eq("id", video_project_id)
      if (releaseError) {
        console.error("[D-ID] slot release failed — project may be wedged:", releaseError.message)
      }
    }

    // ─── STEP 1: Generate voice audio via ElevenLabs ─────────────────────────
    const ttsRes = await fetch(`${appUrl}/api/elevenlabs/tts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: request.headers.get("cookie") ?? "",
      },
      body: JSON.stringify({
        text: renderScript,
        voice_id: elevenlabs_voice_id,
        upload_to_storage: true,
      }),
    })

    const ttsData = await ttsRes.json()
    if (!ttsRes.ok || !ttsData.audio_url) {
      console.error("[D-ID] TTS step failed:", ttsData)
      // The slot is claimed and nothing will ever fill it — release it, or the
      // project sits in 'generating' forever with no provider_job_id to poll.
      await releaseSlot("Failed to generate voice audio")
      return NextResponse.json({ error: "Failed to generate voice audio" }, { status: 500 })
    }

    // ─── STEP 2: Submit to D-ID ───────────────────────────────────────────────
    // For video sources D-ID uses /clips (higher quality lip sync).
    // For photo sources D-ID uses /talks (photo animation).
    const endpoint = isVideoSource ? `${DID_API_BASE}/clips` : `${DID_API_BASE}/talks`

    const expression = ugc_mode ? "happy" : "neutral"

    // Background handling — D-ID supports `background` on /talks (color hex or image URL).
    // For /clips, background gets baked in via the source clip itself.
    // type='video' is the EXPLAINER mode: D-ID still renders only the talking
    // head; we persist the video URL on the row so the poll cron can post-
    // composite the head as a PIP over it.
    const bgValue: string | { type: string; url?: string; color?: string } | undefined =
      background?.type === "image" && background?.value
        ? { type: "image", url: background.value }
        : background?.type === "color" && background?.value
        ? { type: "color", color: background.value }
        : undefined

    // Persist the cinematic-touch selections on the row so the cron knows what
    // to composite after D-ID returns. background_type/background_url drive
    // the standard-vs-explainer decision; intro/outro/b-roll are layered on
    // top of whichever rendering mode the agent picked.
    const cinematicUpdates: Record<string, unknown> = {}
    if (background?.type && background?.value) {
      cinematicUpdates.background_type = background.type
      cinematicUpdates.background_url  = background.value
    }
    if (typeof intro_video_url === "string" && intro_video_url.length > 0) {
      cinematicUpdates.intro_video_url = intro_video_url
    }
    if (typeof outro_video_url === "string" && outro_video_url.length > 0) {
      cinematicUpdates.outro_video_url = outro_video_url
    }
    if (Array.isArray(b_roll_urls) && b_roll_urls.length > 0) {
      // Filter to valid URL strings; the column is jsonb.
      cinematicUpdates.b_roll_urls = b_roll_urls.filter(
        (u): u is string => typeof u === "string" && u.length > 0
      )
    }
    if (Object.keys(cinematicUpdates).length > 0) {
      await supabase
        .from("ai_video_projects")
        .update(cinematicUpdates)
        .eq("id", video_project_id)
    }

    const didPayload = isVideoSource
      ? {
          // /clips endpoint — use persistent avatar_id if available, else raw source_url
          // avatar_id gives faster + more consistent renders; source_url is the fallback
          ...(resolvedAvatarId
            ? { avatar_id: resolvedAvatarId }
            : { source_url: sourceUrl }),
          script: {
            type: "audio",
            audio_url: ttsData.audio_url,
          },
          ...(bgValue ? { background: bgValue } : {}),
          // D-ID natively burns captions into the mp4 when subtitles=true.
          ...(captionsEnabled ? { subtitles: true } : {}),
          config: { stitch: true, result_format: "mp4" },
        }
      : {
          // /talks endpoint — animate a still photo with natural movement
          source_url: sourceUrl,
          script: {
            type: "audio",
            audio_url: ttsData.audio_url,
          },
          driver_url: "bank://natural",
          expression,
          ...(bgValue ? { background: bgValue } : {}),
          ...(captionsEnabled ? { subtitles: true } : {}),
          config: { stitch: true, result_format: "mp4", fluent: true, pad_audio: 0.0 },
          face: { size: 1, top_x: 0, top_y: 0, overlap: "NO" },
        }

    // Through Connection OS. `endpoint` is an absolute URL built above from
    // DID_API_BASE + the engine, so the path is derived from it rather than
    // re-deciding the engine here — the engine is chosen once, upstream.
    const didRes = await didRequest<any>(endpoint.replace(DID_API_BASE, ""), {
      method: "POST",
      body: didPayload,
    })

    const didData = didRes.data ?? { description: didRes.error }

    if (!didRes.ok) {
      console.error("[D-ID] API error:", didData)
      // Was an undestructured update that left provider_status stuck on
      // 'submitting'; releaseSlot clears both and reports a refused write.
      await releaseSlot(didData.description ?? "D-ID error")

      return NextResponse.json(
        { error: didData.description ?? "D-ID video generation failed" },
        { status: 500 }
      )
    }

    const did_talk_id: string = didData.id

    // ─── STEP 3: Update project record ────────────────────────────────────────
    // Destructured. This is the write that hands provider_job_id to
    // app/api/cron/poll-did-videos; if it is refused and nobody looks, the
    // render is already running and billing at D-ID with nothing on our side
    // able to collect it.
    const { error: publishError } = await supabase
      .from("ai_video_projects")
      .update({
        status: "generating",
        provider_job_id: did_talk_id,
        provider_status: "processing",
        provider_metadata: {
          provider: "did",
          mode: isVideoSource ? "clip" : "talk",
          talk_id: did_talk_id,
          source_type: isVideoSource ? "video" : "photo",
          used_avatar_id: resolvedAvatarId ?? null,
          // Avatar→Remotion chain request (consumed by poll-did-videos handoff).
          ...(target_composition_id ? {
            target_composition_id,
            voiceover_url: composition_voiceover_url ?? null,
            input_props: composition_input_props ?? {},
          } : {}),
        },
        error_message: null,
      })
      .eq("id", video_project_id)

    if (publishError) {
      // The render IS running at D-ID. We could not record its job id, so
      // nothing can poll it — say so instead of returning success over a render
      // the caller has already been charged for.
      console.error("[D-ID] failed to publish provider_job_id:", publishError.message)
      return NextResponse.json(
        {
          error: "The render started at D-ID but its job id could not be saved, so it cannot be tracked. Support has the talk id.",
          did_talk_id,
        },
        { status: 500 },
      )
    }

    // THE RENDER LEDGER ROW — now carrying the two facts that make it usable.
    //
    // This insert named only project_id/provider/render_duration_seconds, so
    // `provider_job_id` was NULL on every row (nothing could correlate a log
    // line with the D-ID job it records, and the poll cron below had no key to
    // update it by) and `status` sat on its DEFAULT 'submitted' forever — the
    // render-attempt list in app/components/content-studio/
    // LinkToVideoGenerator.tsx:614 reads exactly those columns and could
    // therefore never show a completed or a failed attempt, only "submitted".
    // Both are known right here, at submit.
    //
    // `cost_usd` stays NULL deliberately: no D-ID price table exists anywhere in
    // this repo, and a per-render dollar figure invented here would be a wrong
    // number in a cost ledger (CLAUDE.md §5).
    const { error: renderLogError } = await supabase.from("video_render_log").insert({
      project_id: video_project_id,
      brokerage_id: auth.brokerageId ?? null,
      provider: "did",
      provider_job_id: did_talk_id,
      status: "submitted",
      render_duration_seconds: null,
    })
    // Best-effort by design — the render is already running and must not be
    // reported as failed because its audit line did not land — but a swallowed
    // refusal here is why the ledger looked empty, so it is READ and said aloud.
    if (renderLogError) {
      console.error("[D-ID] render log row refused:", renderLogError.message)
    }

    await processKernelEvent({
      event: KernelEvent.VIDEO_GENERATION_REQUESTED,
      brokerageId: auth.brokerageId!,
      entityType: "video_project",
      entityId: video_project_id,
    }).catch(err => console.error("[D-ID] Kernel event failed:", err))

    return NextResponse.json({
      success: true,
      did_talk_id,
      mode: isVideoSource ? "clip" : "talk",
      status: "generating",
      estimated_completion_minutes: isVideoSource ? 5 : 3,
    })
  } catch (error: any) {
    console.error("[D-ID] generate-video error:", error)
    // A throw between the claim and the publish would otherwise wedge the
    // project in 'generating' with no provider_job_id — no poller will ever
    // finish it and no new render can claim the slot. Best-effort release,
    // guarded so it cannot mask the original error.
    if (claimedProjectId) {
      try {
        const svc = await createClient()
        await svc
          .from("ai_video_projects")
          .update({
            status: "failed",
            provider_status: null,
            error_message: error?.message ?? "Video generation failed",
          })
          .eq("id", claimedProjectId)
      } catch (releaseErr) {
        console.error("[D-ID] slot release after throw failed:", releaseErr)
      }
    }
    return NextResponse.json({ error: error.message ?? "Internal server error" }, { status: 500 })
  }
}

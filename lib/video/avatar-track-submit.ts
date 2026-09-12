/**
 * lib/video/avatar-track-submit.ts
 *
 * THE SUBMIT SIDE OF THE D-ID → REMOTION HANDOFF — the half that was missing
 * from every lane that declared `target_composition_id`.
 *
 * ── WHY THIS FILE EXISTS (§1.2, built 2026-09-01) ───────────────────────────
 * `lib/video/avatar-render-orchestrator.ts` owns the READ side: on completion,
 * `enqueueAvatarCompositionForProject` takes a finished D-ID job whose project
 * declares `provider_metadata.target_composition_id` and merges the avatar URL
 * into the Remotion render (using `target_render_id` to merge into the row the
 * producer already staged, or repointing the section at a fresh avatar-led row
 * when the queue already claimed it).
 *
 * That reader only ever fires for a project the POLLER adopts, and
 * `app/api/cron/poll-did-videos` selects exactly:
 *
 *     status = 'generating'
 *     AND provider_job_id IS NOT NULL
 *     AND provider_metadata->>provider = 'did'
 *
 * Two lanes wrote the request and matched NONE of that. Both inserted
 * `ai_video_projects` at `status='draft'` with no `provider_job_id` and no D-ID
 * submit anywhere:
 *
 *   · lib/buyer-consultation/consultation-render.ts   (BuyerConsultationSlide)
 *   · lib/listing-presentation/section-narration-orchestrator.ts (ListingSectionReel)
 *
 * `director-reel-render` does not rescue them either — it requires
 * `status='queued'` AND `video_metadata.director_key` AND
 * `provider_metadata.composition_id`, and these rows carry none of the three. So
 * the rows sat forever: writers with no reader, and BOTH avatar lanes were DARK
 * in production. The consequence reaches backwards, too — the `target_render_id`
 * reader in the orchestrator sits downstream of a handoff that never fired, so
 * it has never executed once against real data.
 *
 * The seller-update lane hit the same wall and solved it inline
 * (lib/agents/seller-update-reel-producer.ts). Three copies of one procedure is
 * the §6 defect in its literal form — and the copy most likely to drift is the
 * identity cross, which CLAUDE.md §3 records as a 23503 waiting to happen. So
 * the procedure lives here ONCE, beside the orchestrator that reads what it
 * writes, and all three lanes call it.
 *
 * ── WHY NOT INSIDE avatar-render-orchestrator.ts ────────────────────────────
 * That module declares itself "not server-only" so its pure builders can be
 * unit-tested and imported anywhere. This one has to reach `lib/did` and
 * `lib/video/presenter-media`, both of which ARE server-only. Keeping the two
 * apart is what lets the request BUILDERS stay importable while the SUBMIT
 * stays server-side; every server-only dependency below is reached through a
 * dynamic import at the call site, never a top-level one, for the same reason.
 *
 * ── WHAT IT REFUSES, AND WHY EACH REFUSAL IS NAMED ──────────────────────────
 * A D-ID submit with no face DOES NOT FAIL — it renders D-ID's own stock
 * presenter and reports success (the `no_brokerage_face` ruling). So every
 * precondition is checked before a provider call, and every skip returns a
 * sentence a human can act on rather than a silent degrade. Fail closed (§4).
 */
import type { createServiceClient } from "@/lib/supabase/service"
import { missingContentProps, describeMissingContent } from "@/lib/remotion/content-contract"

type Svc = ReturnType<typeof createServiceClient>

/**
 * What a lane asks to be assembled — the same four keys
 * `enqueueAvatarCompositionForProject` reads back off `provider_metadata`.
 *
 * Structurally identical to `IntroCompositionRequest` /
 * `BuyerSlideCompositionRequest` in avatar-render-orchestrator so a lane that
 * has a typed builder there can pass its result straight through; the
 * entity_type is widened to `string` only because ListingSectionReel has no
 * builder of its own yet and spells its own literal.
 */
export interface AvatarCompositionRequest {
  target_composition_id: string
  input_props: Record<string, unknown>
  entity_type: string
  entity_id: string
}

export interface AvatarTrackSubmission {
  /** Did a real D-ID job get submitted AND linked to a pollable project row? */
  submitted: boolean
  /** Empty on success. Never empty on a skip — a silent skip is the defect. */
  reason: string
  projectId?: string
  jobId?: string
}

export interface SubmitAvatarTrackArgs {
  brokerageId: string
  /**
   * agents.id. `ai_video_projects.agent_id` FKs `agents(id)`
   * (scripts/schema-fk-map.ts) and CLAUDE.md §3 records that agents.id and
   * users.id are DISJOINT, so passing the users-class id here is a 23503. Every
   * caller already has this answer from its own users→agents cross.
   */
  agentRecordId: string | null
  /**
   * users.id. The presenter/voice resolver and the D-ID renderer both speak
   * this class. Kept separate rather than re-derived so the cross happens once
   * per lane, where the lane already did it.
   */
  agentUserId: string | null
  /** What the avatar SAYS. Screened below; also persisted as script_content. */
  script: string
  /** The assembly being asked for. */
  request: AvatarCompositionRequest
  /** The render row already staged for this piece — the merge target. */
  targetRenderId: string
  title: string
  /**
   * `ai_video_projects.video_type`, or null.
   *
   * NULL IS A REAL ANSWER. The live CHECK admits sixteen words; a lane whose
   * product is none of them passes null and records its intent in
   * `video_metadata.video_type_intent` (the m274 precedent). Null passes the
   * CHECK, matches no consumer's `.in(...)`, and cannot borrow another
   * product's routing — `avatar_explainer`, for instance, is a member of
   * PERSONAL_WELCOME_VIDEO_TYPES, so a mislabelled row could be served to a new
   * client as their welcome video.
   */
  videoType: string | null
  /** Recorded beside a null video_type so the intent is never lost. */
  videoTypeIntent: string
  listingId?: string | null
  contactId?: string | null
  /**
   * A voiceover mp3 the lane already synthesized and STAGED on the render row.
   *
   * Pass it ONLY when the composition plays it as a separate `<Audio>` AND the
   * lane is not relying on the avatar for the audio — see the double-audio note
   * in section-narration-orchestrator. Omitted, no `voiceover_url` is written,
   * so the orchestrator's merge leaves the render row's voiceover untouched.
   */
  voiceoverUrl?: string | null
}

/**
 * Submit the avatar track for one already-staged render, and link it so the
 * poller adopts it.
 *
 * Never throws: every failure is a named skip, because the caller's staged
 * render is the guaranteed deliverable and must never be un-queued by a
 * provider problem.
 */
export async function submitAvatarTrack(
  supabase: Svc,
  args: SubmitAvatarTrackArgs,
): Promise<AvatarTrackSubmission> {
  try {
    if (!args.brokerageId) return { submitted: false, reason: "no brokerage on the request" }
    if (!args.agentRecordId) return { submitted: false, reason: "no agents row for this piece, so there is no face to render" }
    if (!args.agentUserId) return { submitted: false, reason: `no users row behind agents.id=${args.agentRecordId}` }
    if (!args.targetRenderId) return { submitted: false, reason: "no staged render to merge the avatar into" }
    const script = (args.script ?? "").trim()
    if (!script) return { submitted: false, reason: "no narration script to speak" }

    // ── Do not pay D-ID for a track whose composite would be CANCELLED ──────
    // The same question render-composition's backstop asks, asked before the
    // spend — and the same one buildIntroCompositionRequest asks before it
    // stamps a request at all.
    const missing = missingContentProps(args.request.target_composition_id, args.request.input_props)
    if (missing.length > 0) {
      return { submitted: false, reason: describeMissingContent(args.request.target_composition_id, missing) }
    }

    // ── §5: nothing reaches a client's ears unscreened ──────────────────────
    // The deterministic detector, not a second model call: it is pure, it
    // cannot fail open, and every caller here has a non-avatar fallback already
    // rendering, so refusing costs the client nothing. A HARD hit is not
    // spoken; medium/low ride through as warnings per the standing disposition.
    const { detectFairHousingViolations } = await import("@/lib/compliance-rules/fair-housing-patterns")
    const fhHits = detectFairHousingViolations(script)
    if (fhHits.some((v) => v.severity === "high")) {
      return {
        submitted: false,
        reason: `hard fair-housing flag in the spoken script (${fhHits.filter((v) => v.severity === "high").map((v) => v.phrase).join(", ")}) — not spoken`,
      }
    }
    if (fhHits.length > 0) {
      console.warn(`[avatar-track-submit] advisory fair-housing finding(s), passing through per §5: ${fhHits.map((v) => v.severity).join(", ")}`)
    }

    // ── PRECONDITION 1: a READY avatar asset ────────────────────────────────
    // §3 — supabase-js RESOLVES a refused read. A refusal is reported AS a
    // refusal; calling it "this agent has no avatar" would hide an RLS problem
    // behind a benign-looking degrade, and this lane degraded silently for
    // months already.
    const { data: assetRow, error: assetErr } = await supabase
      .from("agent_avatar_assets")
      .select("id, source_type, is_default")
      .eq("agent_id", args.agentRecordId)
      .eq("brokerage_id", args.brokerageId)
      .eq("status", "ready")
      .order("is_default", { ascending: false })
      .limit(1).maybeSingle()
    if (assetErr) return { submitted: false, reason: `agent_avatar_assets unreadable: ${assetErr.message}` }
    const asset = assetRow as { id: string; source_type: string | null } | null
    if (!asset) return { submitted: false, reason: "the agent has no READY avatar asset (Settings → Voice & Avatar)" }

    // ── PRECONDITION 2: consent, where the asset's SOURCE makes it required ──
    // ONE spelling of that rule (§6) — lib/did/contract.ts owns it. A
    // photo-sourced V2 twin needs no consent and demanding one would block a
    // legitimate avatar; a video-sourced V3 twin may not be rendered without a
    // verified one. The partial unique index on status='verified' guarantees at
    // most one row, which is what makes maybeSingle() safe here.
    const { consentRequiredFor } = await import("@/lib/did/contract")
    const sourceType: "photo" | "video" = asset.source_type === "video" ? "video" : "photo"
    if (consentRequiredFor(sourceType)) {
      const { data: consent, error: consentErr } = await supabase
        .from("agent_did_consents")
        .select("id")
        .eq("agent_id", args.agentRecordId)
        .eq("status", "verified")
        .maybeSingle()
      if (consentErr) return { submitted: false, reason: `agent_did_consents unreadable: ${consentErr.message}` }
      if (!consent) return { submitted: false, reason: "the agent's avatar is video-sourced and has no VERIFIED D-ID consent on file" }
    }

    // ── PRECONDITION 3: something to render WITH ────────────────────────────
    const { resolveAgentPresenterMedia } = await import("@/lib/video/presenter-media")
    const presenter = await resolveAgentPresenterMedia(
      { agentUserId: args.agentUserId, brokerageId: args.brokerageId }, supabase,
    )
    if (!presenter.canRender) return { submitted: false, reason: "no D-ID actor id or avatar source resolved for this agent" }

    // ── SUBMIT ──────────────────────────────────────────────────────────────
    // submitOnly: the talk id comes back immediately and poll-did-videos owns
    // completion. generateVideo refuses a faceless submit itself, before the
    // budget gate, so a stock stranger can never reach a client.
    const { generateVideo } = await import("@/lib/did")
    const submitted = await generateVideo({
      script,
      voiceId: presenter.voiceId ?? undefined,
      actorId: presenter.actorId,
      avatarImageUrl: presenter.avatarImageUrl,
      agentUserId: args.agentUserId,
      brokerageId: args.brokerageId,
      expression: presenter.expression ?? "neutral",
      submitOnly: true,
    })
    if (submitted.status === "error" || !submitted.videoId) {
      return { submitted: false, reason: `D-ID submit refused: ${submitted.note ?? "no job id returned"}` }
    }

    // ── LINK IT, or the render is billed and never polled ───────────────────
    const now = new Date().toISOString()
    const { data: project, error: projErr } = await supabase.from("ai_video_projects").insert({
      brokerage_id: args.brokerageId,
      agent_id:     args.agentRecordId,
      listing_id:   args.listingId ?? null,
      contact_id:   args.contactId ?? null,
      title:        args.title.slice(0, 200),
      // The spoken text on the ROW'S OWN COLUMN. Was `provider_metadata
      // .narration_script` in both presentation lanes — an ad-hoc key with zero
      // readers repo-wide, beside a real `script_content` column that
      // intro-video-reactor and the Director already use. Merged onto the
      // survivor (§1.1); the metadata key is gone.
      script_content: script,
      status:         "generating",
      provider_job_id: submitted.videoId,
      provider_status: "processing",
      video_provider:  "did",
      // Likewise `did_avatar_id` / `voice_id`: real columns exist for both, and
      // the metadata spellings had no reader. Recorded from what was ACTUALLY
      // submitted (the resolver's answer), not from what a caller believed.
      provider_avatar_id: presenter.actorId ?? null,
      provider_voice_id:  presenter.voiceId ?? null,
      video_type:      args.videoType,
      video_metadata:  {
        video_type_intent: args.videoTypeIntent,
        ...(args.listingId ? { listing_id: args.listingId } : {}),
      },
      usage_intent:   "public_marketing",
      audience_type:  "customer_facing",
      compliance_status: "passed",
      compliance_evaluated_at: now,
      approval_status: "pending_review",
      is_ai_generated: true,
      provider_metadata: {
        provider: "did",
        // Engine RECORDED at submit — poll-did-videos keys /talks vs /clips vs
        // /expressives off this and never guesses from id shapes.
        mode: submitted.engine === "expressives" ? "expressive" : "talk",
        talk_id: submitted.videoId,
        // THE TWO KEYS THE READER NEEDS. Without the first,
        // enqueueAvatarCompositionForProject skips the project forever; the
        // second is what merges the avatar into the render row this lane
        // already staged instead of orphaning a second one.
        target_composition_id: args.request.target_composition_id,
        target_render_id:      args.targetRenderId,
        // The staged row's OWN props: the orchestrator seeds a replacement row
        // with these when the queue beat the merge, and an empty payload there
        // would stage the composition's Studio sample data and be cancelled.
        input_props:  args.request.input_props,
        entity_type:  args.request.entity_type,
        entity_id:    args.request.entity_id,
        ...(args.voiceoverUrl ? { voiceover_url: args.voiceoverUrl } : {}),
      },
    }).select("id").maybeSingle()

    if (projErr || !project) {
      // The D-ID job is REAL but unlinked: nothing will poll it. Say so with the
      // job id so it can be reattached, rather than reporting a handoff that did
      // not happen.
      return {
        submitted: false,
        reason: `D-ID job ${submitted.videoId} submitted but the project row was refused (${projErr?.message ?? "no row returned"}) — it cannot be polled`,
        jobId: submitted.videoId,
      }
    }

    return { submitted: true, reason: "", projectId: (project as { id: string }).id, jobId: submitted.videoId }
  } catch (e) {
    return { submitted: false, reason: `avatar handoff errored: ${(e as Error).message}` }
  }
}

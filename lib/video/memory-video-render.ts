/**
 * lib/video/memory-video-render.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE MEMORY VIDEO'S RENDER — stage the chaptered MemoryVideoReel from a
 * seller-dictated capture. Lane 78D, blind spot (1): the one owner video type
 * with no composition (lane 77D's matrix) now has one, on the VOICEOVER host,
 * chaptered, purpose "memory", no avatar.
 *
 * WAVE 80C (owner verbatim): "the memory videos either can be a full video
 * with the seller on screen walking the home with the story or an uploaded
 * audio of the seller talking about the home to preserve the family's home and
 * photos of the home are used for the visuals." Two modes, one stager:
 *   seller_walkthrough  — each chapter is the seller's own on-camera clip
 *                         (input_props.chapters[].videoUrl → client_footage);
 *   seller_audio_photos — each chapter is the seller's own audio recording
 *                         (chapters[].voiceoverUrl) over the home's photos
 *                         (input_props.photoUrls → property_photos, slots cut
 *                         from the body-visual plan, never hand-timed).
 * THE NARRATOR IS THE SELLER (memory-video-gate.ts MEMORY_VIDEO_VOICE_RULE):
 * this file no longer synthesizes anything. TOMBSTONE (CLAUDE.md §1.3): the
 * prepareReelVoiceover call that read the seller's words aloud in the AGENT's
 * ElevenLabs voice (lane 78D) is gone — it made a stranger the narrator of a
 * family's story, and the owner's two modes both carry the seller's own
 * recording. The ONE narration synthesiser (lib/video/reel-voiceover.ts) stays
 * the survivor for every OTHER composition. No voice is cloned here: a clone
 * is a consent gate (lib/did/consent.ts) this product must not bypass.
 *
 * PLAN BEFORE SEND (owner: "if the script is going to need visuals ai agent
 * plans this before sending"): the body-visual plan is cut from the measured
 * chapters and gated (lib/video/body-visual-model.ts gateVisualPlanForDispatch)
 * BEFORE the render row is written — a mode whose media is missing never
 * reaches the render queue.
 *
 * ALREADY EXISTED — REUSED (CLAUDE.md §1; nothing here is a second copy):
 *   · lib/video/memory-video.ts + memory-video-gate.ts — the capture rail and
 *     the authorship boundary. The CHAPTERS ARE READ OFF THE ROW this rail
 *     stamped (video_metadata.dictation, the last segment per prompt — a
 *     re-record is a correction, exactly as assembleSellerDictatedScript
 *     treats it) and isSellerAuthored is the ONE predicate consulted;
 *     assessSellerMedia is the ONE media verdict.
 *   · lib/video/video-render-hold.ts evaluateVideoRenderHold — every render
 *     door passes through it; a memory_video that cannot prove authorship is
 *     HELD there as a red flag (fail closed).
 *   · lib/video/reel-brand.ts resolveReelBrand — the tenant brand cascade;
 *     lib/remotion/registry.ts recordRenderQueued — the ONE render row writer;
 *     lib/remotion/content-contract.ts — the refusal when nothing dictated is
 *     on the row.
 *   · lib/video/memory-video-composition.ts — the pure timeline arithmetic
 *     the composition and Root.tsx's calculateMetadata share.
 *   · lib/video/body-visual-model.ts — the ONE body-visual planner and gate.
 *
 * NO MODEL IS CALLED HERE (memory-video-gate.ts MODEL_MAY / MODEL_MAY_NOT;
 * CLAUDE.md §5's appraiser rule, same reason).
 *
 * TENANCY: `brokerageId` arrives already gated from the SESSION
 * (app/actions/video/memory-video.ts renderMemoryVideoAction); every read
 * below is additionally pinned to it (§4).
 *
 * m659 APPLIED LIVE 2026-09-22 (supabase/migrations/m659-memory-video-reel-
 * composition.sql). Before it, the render endpoint could not resolve
 * 'MemoryVideoReel' from remotion_compositions and the queued row fails at
 * resolution with that reason; this stager reports the registry miss up front
 * rather than queueing a row it knows will fail.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { assessSellerMedia, isSellerAuthored, MEMORY_VIDEO_PROMPTS, type SellerDictatedSegment } from "@/lib/video/memory-video-gate"
import {
  MEMORY_VIDEO_COMPOSITION_ID, MEMORY_VIDEO_PURPOSE,
  chapterDurationFrames, estimatedChapterSeconds, memoryChapterSegments, memoryVideoDurationFrames,
  type MemoryVideoChapterProps, type MemoryVideoMode,
} from "@/lib/video/memory-video-composition"
import { geometryFor } from "@/lib/remotion/composition-geometry"

export interface MemoryVideoRenderResult {
  ok: boolean
  status: "queued" | "held" | "refused" | "failed"
  renderId?: string
  /** Frames the film will run — cover + every clip + outro. */
  durationFrames?: number
  /** The mode the film is made in. */
  mode?: MemoryVideoMode
  /** Chapters whose length was MEASURED on upload vs. estimated from the words. */
  measured?: number
  estimated?: number
  reason: string
}

interface ProjectRow {
  id: string
  brokerage_id: string | null
  agent_id: string | null
  contact_id: string | null
  video_type: string | null
  status: string | null
  title: string | null
  script_content: string | null
  video_metadata: unknown
}

/** The last dictated segment per chapter, in the canonical chapter order (a re-record replaces). */
function latestByChapter(segments: readonly SellerDictatedSegment[]): Array<{ id: string; title: string; segment: SellerDictatedSegment }> {
  const out: Array<{ id: string; title: string; segment: SellerDictatedSegment }> = []
  for (const p of MEMORY_VIDEO_PROMPTS) {
    const mine = segments.filter((s) => s.promptId === p.id && (s.sellerWords ?? "").trim().length > 0)
    if (mine.length === 0) continue
    out.push({ id: p.id, title: p.ask, segment: mine[mine.length - 1] })
  }
  return out
}

export async function stageMemoryVideoRender(input: {
  brokerageId: string
  contactId: string
  /** users.id of the agent pressing the button — the render row's agentUserId and the hold's actor. */
  agentUserId: string
}): Promise<MemoryVideoRenderResult> {
  if (!input.brokerageId || !input.contactId || !input.agentUserId) {
    return { ok: false, status: "failed", reason: "brokerageId + contactId + agentUserId required" }
  }
  const svc = createServiceClient()

  // 0. The registry must know the composition (m659) — otherwise the queued
  //    row would fail at resolution and the agent would learn nothing.
  const geo = geometryFor(MEMORY_VIDEO_COMPOSITION_ID)
  if (!geo) return { ok: false, status: "failed", reason: `${MEMORY_VIDEO_COMPOSITION_ID} is not in the composition geometry mirror` }
  const { data: registered, error: regErr } = await svc
    .from("remotion_compositions").select("composition_id, is_active").eq("composition_id", MEMORY_VIDEO_COMPOSITION_ID).maybeSingle()
  if (regErr) return { ok: false, status: "failed", reason: `registry read refused: ${regErr.message}` }
  if (!registered || (registered as { is_active?: boolean }).is_active === false) {
    return { ok: false, status: "refused", reason: `${MEMORY_VIDEO_COMPOSITION_ID} is not registered in remotion_compositions yet (supabase/migrations/m659-memory-video-reel-composition.sql, applied live 2026-09-22 — a missing row now means the registry cache is behind the database) — the render endpoint could not resolve it, so nothing was queued` }
  }

  // 1. The capture this rail wrote, pinned to the tenant.
  const { data: row, error: projErr } = await svc
    .from("ai_video_projects")
    .select("id, brokerage_id, agent_id, contact_id, video_type, status, title, script_content, video_metadata")
    .eq("brokerage_id", input.brokerageId)
    .eq("contact_id", input.contactId)
    .eq("video_type", "memory_video")
    .limit(1)
    .maybeSingle()
  if (projErr) return { ok: false, status: "failed", reason: `project read refused: ${projErr.message}` }
  const project = (row as ProjectRow | null) ?? null
  if (!project) return { ok: false, status: "refused", reason: "no memory_video capture exists for this contact — save what the seller dictated first" }
  if (!isSellerAuthored(project.video_metadata)) {
    return { ok: false, status: "refused", reason: "the capture is not provably seller-authored (video_metadata.authored_by='seller' with dictated segments) — nothing was queued" }
  }
  const meta = project.video_metadata as {
    dictation?: SellerDictatedSegment[]; missing?: string[]; tenure_years?: number | null; property_address?: string | null
    seller_media?: { mode?: string; photo_urls?: string[] } | null
  }
  const chapters = latestByChapter(meta.dictation ?? [])
  if (chapters.length === 0) return { ok: false, status: "refused", reason: "the capture holds no dictated chapter — nothing to film" }
  if ((meta.missing ?? []).length > 0) {
    return { ok: false, status: "refused", reason: `chapters still unrecorded: ${(meta.missing ?? []).join(", ")} — the platform does not finish a family's story; capture them first` }
  }

  // 1b. THE MEDIA VERDICT (wave 80C) — the seller's own recordings for the
  //     mode, fail closed. Re-run here, never trusted off the row.
  const photoUrls = (meta.seller_media?.photo_urls ?? []).filter((u) => typeof u === "string" && u.trim().length > 0)
  const media = assessSellerMedia({ mode: meta.seller_media?.mode ?? null, segments: chapters.map((c) => c.segment), photoUrls })
  if (!media.ok || !media.mode) return { ok: false, status: "refused", reason: media.reason }
  const mode = media.mode

  // 2. THE HOLD GATE — the same door every other render passes (fail closed).
  const { evaluateVideoRenderHold } = await import("@/lib/video/video-render-hold")
  const hold = await evaluateVideoRenderHold({
    supabase: svc,
    actor: { userId: input.agentUserId, brokerageId: input.brokerageId },
    script: project.script_content ?? chapters.map((c) => c.segment.sellerWords).join("\n\n"),
    projectId: project.id,
    journeyType: "seller",
    videoType: "memory_video",
    title: project.title ?? undefined,
  })
  if (hold.hold) return { ok: false, status: "held", reason: hold.reasons.join(" | ") || "held by the render gate" }

  // 3. Whose brand frames it (whose VOICE is settled: the seller's own recording).
  const { resolveReelBrand } = await import("@/lib/video/reel-brand")
  const brand = await resolveReelBrand(svc, input.brokerageId, { agentUserId: input.agentUserId })

  const { data: contact, error: contactErr } = await svc
    .from("contacts").select("first_name, last_name, address")
    .eq("id", input.contactId).eq("brokerage_id", input.brokerageId).maybeSingle()
  if (contactErr) return { ok: false, status: "failed", reason: `contact read refused: ${contactErr.message}` }
  const lastName = (contact as { last_name?: string | null } | null)?.last_name?.trim() || null
  const familyName = lastName ? `${lastName} family` : "family"
  const address = meta.property_address ?? (contact as { address?: string | null } | null)?.address ?? null
  const title = address ? `The story of ${address}` : `The story of the ${familyName} home`
  const tenureLine = meta.tenure_years != null && Number.isFinite(meta.tenure_years)
    ? `${Math.floor(meta.tenure_years)} years in the home`
    : null

  // 4. ONE CLIP PER CHAPTER — the seller's own recording sizes the timeline.
  //    A recording measured on upload is the clip's length; an unmeasured one
  //    is estimated from the words at the fleet pace and REPORTED, never
  //    silently guessed.
  const clips: MemoryVideoChapterProps[] = []
  let measured = 0, estimated = 0
  for (const ch of chapters) {
    const s = ch.segment
    const secs = typeof s.mediaDurationSeconds === "number" && Number.isFinite(s.mediaDurationSeconds) && s.mediaDurationSeconds > 0
      ? s.mediaDurationSeconds
      : null
    if (secs != null) measured++; else estimated++
    clips.push({
      id: ch.id,
      title: ch.title,
      sellerWords: s.sellerWords.trim(),
      voiceoverUrl: mode === "seller_audio_photos" ? (s.mediaUrl ?? null) : null,
      videoUrl: mode === "seller_walkthrough" ? (s.mediaUrl ?? null) : null,
      durationFrames: chapterDurationFrames(secs ?? estimatedChapterSeconds(s.sellerWords), geo.fps),
    })
  }
  const durationFrames = memoryVideoDurationFrames({ chapters: clips }, geo.fps)

  const inputProps: Record<string, unknown> = {
    title, familyName, tenureLine, chapters: clips, mode, photoUrls,
    videoPurpose: MEMORY_VIDEO_PURPOSE,
    brand: { primaryColor: brand.primaryColor, accentColor: brand.accentColor, brokerageName: brand.brokerageName, showEhoMark: brand.showEhoMark, ...(brand.logoUrl ? { logoUrl: brand.logoUrl } : {}) },
  }
  const { missingContentProps, describeMissingContent } = await import("@/lib/remotion/content-contract")
  const missing = missingContentProps(MEMORY_VIDEO_COMPOSITION_ID, inputProps)
  if (missing.length > 0) return { ok: false, status: "refused", reason: describeMissingContent(MEMORY_VIDEO_COMPOSITION_ID, missing) }

  // 4b. PLAN BEFORE SEND — the body visual per chapter (client_footage in the
  //     walkthrough, property_photos with plan-cut slots in the audio mode),
  //     gated before any row is written. The segments are the chapters with
  //     their MEASURED frames, so the plan's slots ARE the chapter layout.
  const { stageBodyVisualPlan, gateVisualPlanForDispatch, assetsFromProps } = await import("@/lib/video/body-visual-model")
  const visual = stageBodyVisualPlan({
    compositionId: MEMORY_VIDEO_COMPOSITION_ID, props: inputProps, purpose: MEMORY_VIDEO_PURPOSE,
    segments: memoryChapterSegments(clips),
  })
  if (!visual.ok) return { ok: false, status: "refused", reason: `body visual could not be planned: ${visual.reason}` }
  const gate = gateVisualPlanForDispatch(visual.plan, assetsFromProps(inputProps, { compositionId: MEMORY_VIDEO_COMPOSITION_ID, avatarClip: false }))
  if (!gate.ok) return { ok: false, status: "refused", reason: gate.reason }
  inputProps.bodyVisualPlan = visual.plan

  // 5. The render row — the ONE writer. usedVoiceover is TRUE in the audio
  //    mode (a separate narration track plays under the photos) and false in
  //    the walkthrough (the clip carries its own sound) — the flag names a
  //    track that actually plays.
  const { recordRenderQueued } = await import("@/lib/remotion/registry")
  const queued = await recordRenderQueued({
    brokerageId: input.brokerageId, compositionId: MEMORY_VIDEO_COMPOSITION_ID, agentUserId: input.agentUserId,
    entityType: "memory_video", entityId: project.id,
    usedDidAvatar: false, usedVoiceover: mode === "seller_audio_photos",
    inputProps, scopeType: "brokerage", scopeId: input.brokerageId, requestedVia: "manual",
  })
  if (!queued.ok) {
    return { ok: false, status: "failed", reason: ("error" in queued && typeof queued.error === "string" ? queued.error : null) ?? "render row insert refused" }
  }
  return {
    ok: true, status: "queued",
    renderId: ("renderId" in queued && typeof queued.renderId === "string") ? queued.renderId : undefined,
    durationFrames, mode, measured, estimated,
    reason: `queued the ${Math.round(durationFrames / geo.fps)}s film (${mode}): ${clips.length} chapter(s) in the seller's own voice, ${measured} measured${estimated > 0 ? `, ${estimated} estimated from the words (no duration was recorded on upload)` : ""}${mode === "seller_audio_photos" ? `, ${photoUrls.length} photo(s) as the visuals` : ""}`,
  }
}

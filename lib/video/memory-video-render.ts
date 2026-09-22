/**
 * lib/video/memory-video-render.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE MEMORY VIDEO'S RENDER — stage the chaptered MemoryVideoReel from a
 * seller-dictated capture. Lane 78D, blind spot (1): the one owner video type
 * with no composition (lane 77D's matrix) now has one, on the VOICEOVER host,
 * chaptered, purpose "memory", no avatar.
 *
 * ALREADY EXISTED — REUSED (CLAUDE.md §1; nothing here is a second copy):
 *   · lib/video/memory-video.ts + memory-video-gate.ts — the capture rail and
 *     the authorship boundary. The CHAPTERS ARE READ OFF THE ROW this rail
 *     stamped (video_metadata.dictation, the last segment per prompt — a
 *     re-record is a correction, exactly as assembleSellerDictatedScript
 *     treats it) and isSellerAuthored is the ONE predicate consulted.
 *   · lib/video/video-render-hold.ts evaluateVideoRenderHold — every render
 *     door passes through it; a memory_video that cannot prove authorship is
 *     HELD there as a red flag (fail closed).
 *   · lib/video/reel-voiceover.ts prepareReelVoiceover — the ONE narration
 *     synthesiser (v3 lane, natural pauses, m310 cache, Supabase host), one
 *     clip per chapter part, its measured `durationSeconds` sizing the clip.
 *   · lib/video/video-identity.ts resolveVideoIdentity (contact_facing) — the
 *     agent's own narration voice; lib/video/reel-brand.ts resolveReelBrand —
 *     the tenant brand cascade; lib/remotion/registry.ts recordRenderQueued —
 *     the ONE render row writer; lib/remotion/content-contract.ts — the
 *     refusal when nothing dictated is on the row.
 *   · lib/video/memory-video-composition.ts — the pure timeline arithmetic
 *     the composition and Root.tsx's calculateMetadata share.
 *
 * NO MODEL IS CALLED HERE (memory-video-gate.ts MODEL_MAY / MODEL_MAY_NOT;
 * CLAUDE.md §5's appraiser rule, same reason). TTS reading the seller's words
 * aloud is the "VERBATIM" arm the gate permits; nothing composes, trims or
 * improves a sentence. WHOSE VOICE: the agent's configured narration voice —
 * the seller has no cloned voice on this platform and consenting one is a
 * D-ID/ElevenLabs gate this lane does not touch; the words on screen are the
 * seller's in any case.
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
import { isSellerAuthored, MEMORY_VIDEO_PROMPTS, type SellerDictatedSegment } from "@/lib/video/memory-video-gate"
import {
  MEMORY_VIDEO_COMPOSITION_ID, MEMORY_VIDEO_PURPOSE,
  chapterDurationFrames, estimatedChapterSeconds, memoryVideoDurationFrames, splitForSynthesis,
  type MemoryVideoChapterProps,
} from "@/lib/video/memory-video-composition"
import { MAX_SCRIPT_CHARS } from "@/lib/video/reel-voiceover"
import { geometryFor } from "@/lib/remotion/composition-geometry"

export interface MemoryVideoRenderResult {
  ok: boolean
  status: "queued" | "held" | "refused" | "failed"
  renderId?: string
  /** Frames the film will run — cover + every clip + outro. */
  durationFrames?: number
  /** Clips synthesised vs. clips left silent (words still on screen). */
  narrated?: number
  silent?: number
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
function latestWordsByChapter(segments: readonly SellerDictatedSegment[]): Array<{ id: string; title: string; words: string }> {
  const out: Array<{ id: string; title: string; words: string }> = []
  for (const p of MEMORY_VIDEO_PROMPTS) {
    const mine = segments.filter((s) => s.promptId === p.id && (s.sellerWords ?? "").trim().length > 0)
    if (mine.length === 0) continue
    out.push({ id: p.id, title: p.ask, words: mine[mine.length - 1].sellerWords.trim() })
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
  const meta = project.video_metadata as { dictation?: SellerDictatedSegment[]; missing?: string[]; tenure_years?: number | null; property_address?: string | null }
  const chapters = latestWordsByChapter(meta.dictation ?? [])
  if (chapters.length === 0) return { ok: false, status: "refused", reason: "the capture holds no dictated chapter — nothing to film" }
  if ((meta.missing ?? []).length > 0) {
    return { ok: false, status: "refused", reason: `chapters still unrecorded: ${(meta.missing ?? []).join(", ")} — the platform does not finish a family's story; capture them first` }
  }

  // 2. THE HOLD GATE — the same door every other render passes (fail closed).
  const { evaluateVideoRenderHold } = await import("@/lib/video/video-render-hold")
  const hold = await evaluateVideoRenderHold({
    supabase: svc,
    actor: { userId: input.agentUserId, brokerageId: input.brokerageId },
    script: project.script_content ?? chapters.map((c) => c.words).join("\n\n"),
    projectId: project.id,
    journeyType: "seller",
    videoType: "memory_video",
    title: project.title ?? undefined,
  })
  if (hold.hold) return { ok: false, status: "held", reason: hold.reasons.join(" | ") || "held by the render gate" }

  // 3. Whose voice narrates + whose brand frames it.
  const { resolveVideoIdentity } = await import("@/lib/video/video-identity")
  const identity = await resolveVideoIdentity(svc, { brokerageId: input.brokerageId, agentUserId: input.agentUserId, purpose: "contact_facing" })
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

  // 4. ONE CLIP PER CHAPTER PART — the timeline is sized by the narration.
  const { prepareReelVoiceover } = await import("@/lib/video/reel-voiceover")
  const clips: MemoryVideoChapterProps[] = []
  let narrated = 0, silent = 0
  for (const ch of chapters) {
    const parts = splitForSynthesis(ch.words, MAX_SCRIPT_CHARS)
    for (let i = 0; i < parts.length; i++) {
      const words = parts[i]
      const vo = identity.voiceId
        ? await prepareReelVoiceover({
            brokerageId: input.brokerageId, narration: words, voiceId: identity.voiceId,
            renderKey: `${MEMORY_VIDEO_PURPOSE}-${project.id.slice(0, 8)}-${ch.id}-${i}`,
          })
        : null
      if (vo) narrated++; else silent++
      const seconds = vo?.durationSeconds ?? estimatedChapterSeconds(words)
      clips.push({
        id: parts.length > 1 ? `${ch.id}-${i + 1}` : ch.id,
        title: ch.title,
        sellerWords: words,
        voiceoverUrl: vo?.url ?? null,
        durationFrames: chapterDurationFrames(seconds, geo.fps),
      })
    }
  }
  const durationFrames = memoryVideoDurationFrames({ chapters: clips }, geo.fps)

  const inputProps: Record<string, unknown> = {
    title, familyName, tenureLine, chapters: clips,
    brand: { primaryColor: brand.primaryColor, accentColor: brand.accentColor, brokerageName: brand.brokerageName, showEhoMark: brand.showEhoMark, ...(brand.logoUrl ? { logoUrl: brand.logoUrl } : {}) },
  }
  const { missingContentProps, describeMissingContent } = await import("@/lib/remotion/content-contract")
  const missing = missingContentProps(MEMORY_VIDEO_COMPOSITION_ID, inputProps)
  if (missing.length > 0) return { ok: false, status: "refused", reason: describeMissingContent(MEMORY_VIDEO_COMPOSITION_ID, missing) }

  // 5. The render row — the ONE writer.
  const { recordRenderQueued } = await import("@/lib/remotion/registry")
  const queued = await recordRenderQueued({
    brokerageId: input.brokerageId, compositionId: MEMORY_VIDEO_COMPOSITION_ID, agentUserId: input.agentUserId,
    entityType: "memory_video", entityId: project.id,
    usedDidAvatar: false, usedVoiceover: narrated > 0,
    inputProps, scopeType: "brokerage", scopeId: input.brokerageId, requestedVia: "manual",
  })
  if (!queued.ok) {
    return { ok: false, status: "failed", reason: ("error" in queued && typeof queued.error === "string" ? queued.error : null) ?? "render row insert refused" }
  }
  return {
    ok: true, status: "queued",
    renderId: ("renderId" in queued && typeof queued.renderId === "string") ? queued.renderId : undefined,
    durationFrames, narrated, silent,
    reason: `queued the ${Math.round(durationFrames / geo.fps)}s film: ${clips.length} clip(s) over ${chapters.length} chapter(s), ${narrated} narrated${silent > 0 ? `, ${silent} silent (no narration voice configured — the words still show on screen)` : ""}`,
  }
}

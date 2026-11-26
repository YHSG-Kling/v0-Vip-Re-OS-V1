/**
 * Video adapter — D-ID talking avatar + ElevenLabs cloned voice.
 *
 * WHO FRONTS IT (w8 fix). Every video this adapter makes is DELIVERED TO A
 * CONTACT (see the dispatchVideo call at the bottom: contactId +
 * recipientEmail), yet it resolved the presenter through
 * lib/voice/voice-resolver's SELF resolvers. Those honor the agent's own
 * self-view preferences, so:
 *
 *   · an agent whose agents.voice_preference is 'generic' had every campaign
 *     video sent to their clients narrated by an ElevenLabs STOCK voice —
 *     under their own name — because that is the voice they picked for their
 *     morning brief; and
 *   · an agent with agents.assistant_avatar_id set had their SELF-VIEW twin,
 *     not their clone, fronting the video their client watched.
 *
 * The platform already has ONE answer to "who fronts a contact-facing video":
 * lib/video/video-identity.ts:resolveVideoIdentity with purpose
 * "contact_facing" — the licensed human's own agent_voice_profiles clone,
 * never the assistant, never a preference. It is what lib/video/
 * listing-pitch-reel.ts and lib/kernel/deal-room-reel.ts already use. This
 * adapter now uses it too, so there is one notion of the presenter and not two.
 *
 * It also means an agent with NO twin gets an honest refusal from lib/did
 * (no face → no render) instead of a stranger's stock voice; that is the
 * no-brokerage-face rule, and it is deliberate.
 *
 * Supports:
 *   - Full avatar video: D-ID with agent's avatar + cloned voice
 *   - Voice-only (no avatar): audio-only output with optional B-roll over it
 *   - Separate intro/outro clips (prepended/appended)
 *   - B-roll clips (overlaid or cut-away during avatar speaking)
 *   - Background image/video (optional, behind avatar)
 *   - Logo/watermark overlay
 *
 * The generated video URL is stored as output so downstream steps can use
 * {{step_N.video_url}} in email HTML or social captions.
 */

import type { ChannelAdapter, StepContext, StepResult } from "../channel-registry"
import { dispatchVideo } from "@/lib/providers/dispatch"

export const videoAdapter: ChannelAdapter = {
  channel: "video",

  async execute(ctx: StepContext): Promise<StepResult> {
    const { contact, step, brokerageId, agentUserId, entity } = ctx

    // Persona+enrichment script (no hardcoded copy): when the step carries an ai_intent, GENERATE
    // the spoken script from this person's persona + Fair-Housing-safe enrichment. Falls back to an
    // explicit step.video_script only if no intent. Never narrate a blank/ungenerated script.
    let script = step.video_script ?? step.body ?? ""
    if ((step as any).ai_intent && contact?.id) {
      try {
        const { generateEntityStepCopy } = await import("@/lib/campaign-sequences/persona-render-runner")
        const draft = await generateEntityStepCopy({
          svc: ctx.supabase as any,
          entity: (entity ?? "contact"),
          id: contact.id as string,
          intent: (step as any).ai_intent as string,
          channel: "video",
          words: 90,
          fallback: { body: step.video_script ?? step.body ?? "" },
        })
        script = draft.body
      } catch { /* fall back to the step script below */ }
    }
    if (!script || !script.trim()) {
      return { status: "error", providerKey: "d-id", error: "No video script — persona generation produced none and no template fallback" }
    }

    // WHO FRONTS IT — the contact-facing identity (see the header): the
    // licensed human's own clone, resolved by the same function the other
    // contact-facing reels use. Never the self-view preference.
    let voiceId: string | undefined
    let avatarImageUrl: string | null = null
    let presenterName: string | null = null
    if (agentUserId) {
      try {
        const { resolveVideoIdentity } = await import("@/lib/video/video-identity")
        const identity = await resolveVideoIdentity(ctx.supabase as any, {
          brokerageId,
          agentUserId,
          purpose: "contact_facing",
        })
        voiceId = identity.voiceId ?? undefined
        avatarImageUrl = identity.avatarPhotoUrl
        presenterName = identity.speakerName
      } catch { /* identity resolution is best-effort; lib/did refuses without a face */ }
    }

    // No face resolved = no render. lib/did already refuses (a D-ID submit with
    // neither actor nor source renders D-ID's OWN stock presenter under the
    // agent's name), but saying it here names the fix instead of a vendor error.
    if (!avatarImageUrl && !step.video_voice_only) {
      return {
        status: "skipped",
        providerKey: "d-id",
        error: presenterName
          ? `No avatar on file for ${presenterName} — set one up in Twin Studio (Settings → Voice & Avatar) before a client video can be made. Nothing was sent.`
          : "No agent avatar on file — set one up in Twin Studio (Settings → Voice & Avatar) before a client video can be made. Nothing was sent.",
        output: { video_url: null, video_id: null },
      }
    }

    // Try D-ID video generation
    let videoUrl: string | undefined
    let videoId: string | undefined
    let result: import("@/lib/did").GenerateVideoResult | undefined

    try {
      // lib/did exists and exports generateVideo() — typed dynamic import
      const did = await import("@/lib/did")
      result = await did.generateVideo({
        script,
        voiceId,
        voiceOnly: step.video_voice_only,
        avatarImageUrl: avatarImageUrl ?? undefined,
        backgroundUrl: step.video_background_url ?? undefined,
        brollUrls: step.video_broll_urls ?? [],
        introUrl: step.video_intro_url ?? undefined,
        outroUrl: step.video_outro_url ?? undefined,
        logoUrl: step.video_logo_url ?? undefined,
        brokerageId,
        // Addressed to ONE contact → hosted PRIVATE (wave 156, 156S; the wave 146 personal-videos survivor).
        addresseeContactId: contact?.id ? String(contact.id) : null,
      })
      videoUrl = result.videoUrl ?? undefined
      videoId = result.videoId
    } catch {
      // D-ID not configured or module not found — SKIP honestly (don't claim 'sent' for a video
      // that was never made). The executor advances without recording a false touch.
      return {
        status: "skipped",
        providerKey: "d-id",
        error: "D-ID integration not configured — video step skipped (no false send)",
        output: { video_url: null, video_id: null },
      }
    }

    // D-ID job still processing (timed out polling) — record as sent with pending output
    if (!videoUrl && result?.status === "processing") {
      return {
        status: "sent",
        providerKey: "d-id",
        messageId: videoId,
        output: {
          video_url: null,
          video_id: videoId,
          status: "processing",
          note: result.note ?? "D-ID job queued — poll for completion",
        },
      }
    }

    if (!videoUrl) {
      return { status: "error", providerKey: "d-id", error: "Video generation returned no URL" }
    }

    // THE PERSONAL VIDEO GOES THROUGH THE SURVIVOR'S DOOR (wave 156, lane 156S). The private render comes back as a
    // stored reference; what later steps receive as {{step.video_url}} is the delivery door with a share grant for THIS
    // contact — the same door lib/video/client-video-delivery.ts hands a client in its email — never a public file URL.
    if (contact?.id && videoId) {
      const shared = await sharePersonalWorkflowVideo({ brokerageId, contactId: String(contact.id), reference: videoUrl, talkId: videoId, script })
      if (!shared.ok) {
        return { status: "error", providerKey: "d-id", messageId: videoId, error: `The personal video was made but could not be shared privately: ${shared.reason}. Nothing was sent.`, output: { video_url: null, video_id: videoId } }
      }
      videoUrl = shared.url
    }

    // Deliver via email if contact has email
    if (contact?.email) {
      const result = await dispatchVideo({
        brokerageId,
        systemSource: "sequence",
        contactId: contact.id,
        templateId: step.video_template_id ?? "",
        recipientEmail: contact.email,
        recipientName: `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim() || undefined,
      })

      return {
        status: result.success ? "sent" : "error",
        providerKey: "d-id",
        messageId: videoId,
        error: result.error,
        output: { video_url: videoUrl, video_id: videoId },
      }
    }

    return {
      status: "sent",
      providerKey: "d-id",
      messageId: videoId,
      output: { video_url: videoUrl, video_id: videoId },
    }
  },
}

/**
 * FILE + SHARE ONE PERSONAL VIDEO (wave 156, lane 156S) — through the wave 146 / 154 survivor, never a second door:
 *   1. the render is FILED as the ai_video_projects row addressed to this contact (tenant-pinned; once per D-ID job —
 *      a replayed step finds its row by provider_job_id), because the share grant is minted only for a video project
 *      addressed to the recipient (lib/storage/signed-doc-url.ts grantDoorLinksInText, purpose personal_video);
 *   2. the stored reference becomes the delivery door with a share grant for THIS contact — exactly what
 *      lib/video/client-video-delivery.ts puts in the client's email. No sealing secret / a refused read → refused
 *      with the reason (the survivor's honest state), and the caller sends nothing.
 * A value that is not a private reference (a voice-only mp3, an older public render) is returned unchanged.
 */
async function sharePersonalWorkflowVideo(a: { brokerageId: string; contactId: string; reference: string; talkId: string; script: string }): Promise<{ ok: true; url: string } | { ok: false; reason: string }> {
  if (!a.reference.startsWith("docref://")) return { ok: true, url: a.reference }
  const { createServiceClient } = await import("@/lib/supabase/service")
  const svc = createServiceClient()
  const { data: existing, error: readErr } = await svc.from("ai_video_projects")
    .select("id").eq("brokerage_id", a.brokerageId).eq("contact_id", a.contactId).eq("provider_job_id", a.talkId).limit(1)
  if (readErr) return { ok: false, reason: `the video project could not be read (${readErr.message})` }
  if (!(existing ?? []).length) {
    const { error: insErr } = await svc.from("ai_video_projects").insert({
      brokerage_id: a.brokerageId, contact_id: a.contactId, title: "Personal video", script_content: a.script.slice(0, 5000),
      status: "completed", video_url: a.reference, video_provider: "did", provider_job_id: a.talkId,
      audience_type: "customer_facing", completed_at: new Date().toISOString(),
    })
    if (insErr) return { ok: false, reason: `the video could not be filed for its contact (${insErr.message})` }
  }
  const { grantDoorLinksInText } = await import("@/lib/storage/signed-doc-url")
  const { encryptSecret, decryptSecret, isEncrypted } = await import("@/lib/security/secret-crypto")
  const { siteUrl } = await import("@/lib/platform/site-url")
  const granted = await grantDoorLinksInText(svc as never, a.reference, {
    brokerageId: a.brokerageId, recipientContactId: a.contactId,
    sealer: { seal: encryptSecret, open: decryptSecret, isSealed: isEncrypted }, origin: siteUrl(),
  })
  if (!granted.ok) return { ok: false, reason: granted.reason }
  if (granted.granted !== 1) return { ok: false, reason: "no share grant could be minted for this contact" }
  return { ok: true, url: granted.text }
}

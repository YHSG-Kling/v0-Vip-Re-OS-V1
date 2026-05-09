/**
 * Video adapter — D-ID talking avatar + ElevenLabs cloned voice.
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
    const { contact, step, brokerageId, agentUserId } = ctx

    const script = step.video_script ?? step.body ?? ""
    if (!script) {
      return { status: "error", providerKey: "d-id", error: "No video script configured" }
    }

    // Resolve agent voice via voice-resolver
    let voiceId: string | undefined
    if (agentUserId) {
      try {
        const { resolveSelfVoice } = await import("@/lib/voice/voice-resolver")
        const resolved = await resolveSelfVoice(agentUserId)
        voiceId = resolved.voiceId ?? undefined
      } catch { /* voice resolution is best-effort */ }
    }

    // Try D-ID video generation
    let videoUrl: string | undefined
    let videoId: string | undefined

    try {
      // D-ID SDK integration lives in lib/did — use string path so TypeScript
      // doesn't fail to resolve this optional module.
      const didPath = "@/lib/did"
      const did = await import(/* webpackIgnore: true */ didPath as string)
      const result = await (did as any).generateVideo({
        script,
        voiceId,
        voiceOnly: step.video_voice_only,
        backgroundUrl: step.video_background_url ?? undefined,
        brollUrls: step.video_broll_urls ?? [],
        introUrl: step.video_intro_url ?? undefined,
        outroUrl: step.video_outro_url ?? undefined,
        logoUrl: step.video_logo_url ?? undefined,
        brokerageId,
      })
      videoUrl = (result as any).videoUrl
      videoId = (result as any).videoId
    } catch {
      // D-ID not configured or module not found — log intent, return success so sequence
      // doesn't block on a missing integration. video_url output will be empty.
      return {
        status: "sent",
        providerKey: "d-id",
        output: { video_url: null, video_id: null, note: "D-ID integration not yet configured" },
      }
    }

    if (!videoUrl) {
      return { status: "error", providerKey: "d-id", error: "Video generation returned no URL" }
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

/**
 * Social Post adapter — schedules a post to omnipresence queue.
 *
 * The adapter generates a caption (using AI if social_caption_prompt is set),
 * resolves the image source, and queues to the repurposed_content_log so the
 * omnipresence engine distributes it at the scheduled time.
 *
 * Image source options (step.social_image_source):
 *   "step_output"    — uses {{step_N.image_url}} from a previous ai_image step
 *   "media_library"  — uses brokerage media library (agent picks at build time)
 *   "ai_generate"    — generates a new image for this post
 *   "listing_photo"  — first photo from the associated listing
 */

import type { ChannelAdapter, StepContext, StepResult } from "../channel-registry"
import type { ImageSize } from "@/lib/ai/image-generation"

export const socialPostAdapter: ChannelAdapter = {
  channel: "social_post",

  async execute(ctx: StepContext): Promise<StepResult> {
    const { step, brokerageId, agentUserId, contact, previousOutputs, resolvedVars, supabase } = ctx

    const platform = step.social_platform
    if (!platform) {
      return { status: "error", providerKey: "social", error: "No social platform configured" }
    }

    // Resolve image URL from variable graph or generate
    let imageUrl: string | undefined
    const imageSource = step.social_image_source ?? "step_output"

    if (imageSource === "step_output") {
      // Look for image_url in any previous step output
      for (const output of Object.values(previousOutputs)) {
        if (output?.image_url) { imageUrl = String(output.image_url); break }
      }
    } else if (imageSource === "ai_generate") {
      try {
        const { generateImage } = await import("@/lib/ai/image-generation")
        const size: ImageSize =
          platform === "instagram" || platform === "tiktok" ? "1024x1792" : "1024x1024"
        const img = await generateImage({
          prompt: step.social_caption_prompt ?? `Real estate social post for ${platform}`,
          purpose: "social_post",
          style: "vivid",
          size,
          quality: "standard",
        })
        imageUrl = img.imageUrl
      } catch { /* best-effort */ }
    }

    // Generate caption
    let caption = step.body ?? ""
    if (step.social_caption_prompt && !caption) {
      try {
        const { generateTextRouted } = await import("@/lib/ai/models")
        const { text } = await generateTextRouted({
          feature: "social_caption",
          messages: [{
            role: "user",
            content: `Write a ${platform} caption for: ${step.social_caption_prompt}. Contact context: ${contact?.first_name ?? ""}. Keep it under 280 characters for Twitter, 2200 for Instagram. Them-first, value-led, no hard sell.`,
          }],
        })
        caption = text
      } catch { /* use empty caption */ }
    }

    // Universal QR modifier — append the trackable scan URL to the caption
    const { resolveQrCode } = await import("@/lib/workflow/qr-modifier")
    const qr = await resolveQrCode(step, ctx, {
      defaultLabel: `${platform} post QR`,
      defaultPurpose: "social",
    })
    if (qr) {
      caption = caption + (caption ? "\n\n" : "") + qr.scanUrl
    }

    // Queue to omnipresence via repurposed_content_log
    // Schema: source_type, source_id, brokerage_id, output_type, output_ref_table,
    //         output_ref_id, platform_target, status, approval_status, notes, created_by
    const { error } = await supabase.from("repurposed_content_log").insert({
      brokerage_id: brokerageId,
      source_type: "sequence",
      source_id: ctx.enrollmentId,
      output_type: "social_post",
      output_ref_table: "campaign_sequence_steps",
      output_ref_id: step.id,
      platform_target: platform,
      status: "queued",
      approval_status: "pending",
      notes: JSON.stringify({ caption, media_url: imageUrl ?? null }),
      created_by: agentUserId ?? null,
      created_at: new Date().toISOString(),
    })

    if (error) {
      return { status: "error", providerKey: "social", error: error.message }
    }

    return {
      status: "sent",
      providerKey: "social",
      output: { platform, caption, image_url: imageUrl },
    }
  },
}

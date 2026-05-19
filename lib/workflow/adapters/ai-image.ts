/**
 * AI Image adapter — generates an image via gpt-image-1 through Vercel AI Gateway (Flex mode).
 *
 * Output is stored so downstream steps can reference {{step_N.image_url}}.
 * Maps aspect_ratio to the nearest supported OpenAI image size.
 */

import type { ChannelAdapter, StepContext, StepResult } from "../channel-registry"
import { generateImage } from "@/lib/ai/image-generation"
import type { ImageSize } from "@/lib/ai/image-generation"

// Map human-readable aspect ratios to OpenAI image sizes
const ASPECT_TO_SIZE: Record<string, ImageSize> = {
  "1:1":  "1024x1024",
  "16:9": "1792x1024",
  "4:3":  "1792x1024",
  "9:16": "1024x1792",
}

export const aiImageAdapter: ChannelAdapter = {
  channel: "ai_image",

  async execute(ctx: StepContext): Promise<StepResult> {
    const { step, brokerageId, resolvedVars } = ctx

    const prompt = resolvedVars["image_prompt"] ?? step.image_prompt
    if (!prompt) {
      return { status: "error", providerKey: "gpt-image-1", error: "No image prompt configured" }
    }

    const size: ImageSize = ASPECT_TO_SIZE[step.image_aspect_ratio ?? "1:1"] ?? "1024x1024"

    try {
      const result = await generateImage({
        prompt,
        purpose: "generic",        // drives prompt boilerplate
        style: (step.image_style ?? "vivid") as "vivid" | "natural",
        size,
        quality: "standard",
      })

      if (!result.imageUrl) {
        return {
          status: "error",
          providerKey: "gpt-image-1",
          error: result.error ?? "Image generation returned no URL",
        }
      }

      return {
        status: "sent",
        providerKey: "gpt-image-1",
        output: {
          image_url: result.imageUrl,
          revised_prompt: result.revisedPrompt,
          size,
        },
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { status: "error", providerKey: "gpt-image-1", error: msg }
    }
  },
}

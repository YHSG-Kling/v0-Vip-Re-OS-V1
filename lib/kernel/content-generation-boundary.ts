import type { ContentType } from "@/lib/constants"
import { generateContent } from "@/lib/services/content-generation.service"

type RawContentType =
  | ContentType
  | "social"
  | "socialPost"
  | "listing"
  | "email_campaign"

export interface KernelContentRequest {
  agentId: string
  contentType: RawContentType
  targetAudience?: string
  propertyId?: string
  contactId?: string
  transactionId?: string
  customPrompt?: string
  platform?: "facebook" | "instagram" | "linkedin" | "twitter" | "tiktok" | "email"
  emailType?: "welcome" | "follow_up" | "property_alert" | "market_update" | "check_in" | "reengagement" | "newsletter"
  metadata?: Record<string, unknown>
  context?: Record<string, unknown>
}

export interface KernelContentResponse {
  success: boolean
  contentId?: string
  content?: string
  subject?: string
  hashtags?: string[]
  raw?: unknown
  error?: string
}

function normalizeContentType(contentType: RawContentType): ContentType {
  switch (contentType) {
    case "social":
    case "socialPost":
      return "social_post"
    case "listing":
      return "listing_description"
    case "email_campaign":
      return "email"
    default:
      return contentType
  }
}

export async function generateKernelContent(
  params: KernelContentRequest
): Promise<KernelContentResponse> {
  const result = await generateContent({
    ...params,
    contentType: normalizeContentType(params.contentType),
  })

  if (!result.success || !result.content) {
    return {
      success: false,
      error: result.error || "Content generation failed",
      raw: result,
    }
  }

  return {
    success: true,
    contentId: result.content.id,
    content: result.content.generated_content,
    subject: result.content.subject,
    hashtags: result.content.hashtags || [],
    raw: result,
  }
}

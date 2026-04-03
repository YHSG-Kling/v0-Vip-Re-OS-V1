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
  metadata?: Record<string, any>
  context?: Record<string, unknown>
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

export async function generateKernelContent(params: KernelContentRequest) {
  return generateContent({
    ...params,
    contentType: normalizeContentType(params.contentType),
  })
}

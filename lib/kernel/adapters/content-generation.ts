// lib/kernel/adapters/content-generation.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE KERNEL CONTENT ADAPTER — legacy content-type spellings in, canonical
// ContentType out, then straight to the one content generator.
//
// ── WHY THIS FILE ABSORBED ANOTHER ONE (2026-08-29, CLAUDE.md §1.1) ─────────
//
// `lib/kernel/content-generation-boundary.ts` was a near-byte-identical second
// copy of this module: the same import of `generateContent`, the same private
// `normalizeContentType` over the same four legacy spellings, the same
// `KernelContentRequest` field for field, the same exported
// `generateKernelContent`. Not two capabilities that happened to share a noun —
// one capability written twice.
//
// It went unseen because the two copies ACQUITTED EACH OTHER. The only census
// that looks for unreferenced type exports asked "does this identifier occur in
// any other file", and each file's `KernelContentRequest` answered for the
// other's, forever and silently, while NOTHING imported either. That
// false-acquittal class is fixed in scripts/opposite-missing-census.ts (see its
// "THE MODULE REACHABILITY GRAPH" section); this file is the first thing the
// fixed instrument found.
//
// `lib/kernel/content-generation-boundary.ts` — MERGED-THEN-DELETED.
// SURVIVOR: lib/kernel/adapters/content-generation.ts:60 (KernelContentRequest),
// :82 (KernelContentResponse, merged FROM the deleted file), :106
// (generateKernelContent, the deleted file's richer body kept whole).
//
// SURVIVOR CHOSEN ON THE BUSINESS SEAM, not on which name read better.
// `lib/kernel/adapters/*` is a live, three-member family — brand-voice,
// compliance, financial — each doing exactly this job (translate a legacy
// caller vocabulary, delegate to the real engine) and each reached as
// `@/lib/kernel/adapters/<name>` from app/actions and lib/kernel/marketing.ts.
// "boundary" was a singleton spelling of that same idea, which is the defect
// §6 names. So the adapter path survives and the boundary's ONE genuine
// addition — `KernelContentResponse` and the result handling that produces it,
// where this file returned the service's raw shape — was merged onto it FIRST,
// per §1.1, before the duplicate was deleted. `Record<string, unknown>` also
// wins over `Record<string, any>` on `metadata`: same field, stricter half.
//
// STILL A WIRE QUESTION, AND DELIBERATELY LEFT AS ONE. Nothing imports this
// module. The live content path is app/actions/ai-content-generation.tsx:9 →
// lib/services/content-generation.service (also re-exported at
// lib/services/index.ts:16), which calls `generateContent` directly with an
// already-canonical ContentType. §1.3 is NOT applied here: the generation
// capability does live in that service, but the legacy-spelling normalisation
// below lives nowhere else, and `generateContent` REFUSES an unknown
// contentType outright (content-generation.service.ts:64-65). Whether that
// shim should be wired to a caller or retired with the legacy vocabulary is an
// owner ruling, not a number to be moved.
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

/**
 * The kernel-facing result shape — merged from the retired boundary copy, which
 * is the one thing it carried that this file did not. A caller reads
 * `contentId` / `content` / `subject` / `hashtags` without knowing the service's
 * nested `result.content.generated_content` layout, and a refusal arrives as a
 * populated `error` with the untouched service result on `raw` rather than as a
 * shape the caller has to destructure defensively.
 */
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

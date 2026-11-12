"use server"

/**
 * Publish a lead-magnet manual/guide to Google Business Profile (GBP/GMB) — gated. The guide content
 * (built from real demand topics) becomes a GBP post so the brokerage's profile answers what local
 * buyers/sellers are asking, which also feeds AI-search/local visibility. Reuses the existing
 * createSocialPost flow with platform 'google_business' + forceApprovalPending, so the post lands in
 * the Command Center Social approval queue and NEVER auto-publishes.
 */

import { createClient } from "@/lib/supabase/server"
import { createSocialPost } from "@/app/actions/social-publishing"
import { magnetDeliverableCopy, magnetHasDeliverable, type MagnetType } from "@/lib/marketing/lead-magnet-copy"

const VALID: MagnetType[] = ["home_valuation", "buyer_guide", "seller_guide", "market_report", "listing_alert", "open_house", "generic_form"]

export async function publishGuideToGbpAction(input: { magnetType: string; area?: string | null; brand?: string | null; landingUrl?: string | null }): Promise<{
  success: boolean
  postId?: string
  error?: string
}> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "unauthorized" }

  const magnetType: MagnetType = VALID.includes(input.magnetType as MagnetType) ? (input.magnetType as MagnetType) : "generic_form"
  if (!magnetHasDeliverable(magnetType)) return { success: false, error: "this magnet ships no guide to post" }
  const ctx = { area: input.area ?? null, brand: input.brand ?? null }

  // Build the GBP post content from the deliverable + real demand topics (AI-written, FH-safe).
  const { fetchContentTopics } = await import("@/lib/marketing/content-topics-runner")
  const { prepareMagnetDeliverable } = await import("@/lib/marketing/lead-magnet-copy")
  const { realCopyGenerator } = await import("@/lib/kernel/ai-copy")
  const topics = await fetchContentTopics(magnetType, input.area ?? null).catch(() => [])
  const deliverable = (await prepareMagnetDeliverable(magnetType, ctx, { topics, copyGenerator: realCopyGenerator }).catch(() => null)) ?? magnetDeliverableCopy(magnetType, ctx)

  // GBP posts are short — lead with the title + a tight summary + a CTA to the full guide.
  const summary = deliverable.body.split(/(?<=[.?!])\s+/).slice(0, 2).join(" ")
  const cta = input.landingUrl ? `\n\nGet the full guide: ${input.landingUrl}` : ""
  const content = `${deliverable.title}\n\n${summary}${cta}`

  try {
    // contentType is the post_type COLUMN VALUE, and "lead_magnet_guide" is not in
    // the social_posts.post_type CHECK — every call here used to reject with 23514.
    // The brief still records which magnet this came from.
    const post = await createSocialPost({
      content,
      platforms: ["google_business"],
      scheduledFor: new Date().toISOString(),
      contentType: "custom",
      generatedByAi: true,
      aiPrompt: `gbp_guide:${magnetType}`,
      forceApprovalPending: true, // gated — surfaces in the Command Center Social approval queue
    })
    // createSocialPost now returns a real verdict: a run that reached zero
    // channels (no connected Google Business account, content held for
    // compliance) must not be reported as posted.
    if ((post as { success?: boolean }).success === false) {
      return {
        success: false,
        error: (post as { message?: string }).message ?? "GBP publish was not scheduled",
      }
    }
    return { success: true, postId: (post as any)?.id ?? (post as any)?.postId }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "GBP publish failed" }
  }
}

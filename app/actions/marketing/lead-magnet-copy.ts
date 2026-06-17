"use server"

/**
 * Generate AI landing-page copy + deliverable copy for a lead magnet / home-value page — BUILT from
 * what buyers/sellers are ACTUALLY asking (content-topics from the gated web-search rail), not
 * boilerplate. Falls back to the safe deterministic copy when search/AI is unavailable. Marketing copy
 * only — separate from the kernel-owned portal view/education. Fair-Housing-safe (topics pre-filtered).
 */

import { createClient } from "@/lib/supabase/server"
import { landingPageCopyFromTopics, magnetDeliverableCopy, prepareMagnetDeliverable, magnetHasDeliverable, type MagnetType, type LandingCopy, type MagnetDeliverable } from "@/lib/marketing/lead-magnet-copy"

const VALID: MagnetType[] = ["home_valuation", "buyer_guide", "seller_guide", "market_report", "listing_alert", "open_house", "generic_form"]

export async function generateLeadMagnetCopyAction(input: { magnetType: string; area?: string | null; brand?: string | null }): Promise<{
  success: boolean
  landing?: LandingCopy & { fromTopics?: boolean }
  deliverable?: MagnetDeliverable | null
  topics?: string[]
  error?: string
}> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "unauthorized" }

  const magnetType: MagnetType = VALID.includes(input.magnetType as MagnetType) ? (input.magnetType as MagnetType) : "generic_form"
  const ctx = { area: input.area ?? null, brand: input.brand ?? null }

  // Pull what people are actually asking, then AI-write the copy grounded in it.
  const { fetchContentTopics } = await import("@/lib/marketing/content-topics-runner")
  const topics = await fetchContentTopics(magnetType, input.area ?? null).catch(() => [])
  const { realCopyGenerator } = await import("@/lib/kernel/ai-copy")

  const landing = await landingPageCopyFromTopics(magnetType, topics, ctx, { copyGenerator: realCopyGenerator })
  const deliverable = magnetHasDeliverable(magnetType)
    ? await prepareMagnetDeliverable(magnetType, ctx, { topics, copyGenerator: realCopyGenerator })
    : null

  return {
    success: true,
    landing,
    deliverable: deliverable ?? (magnetHasDeliverable(magnetType) ? magnetDeliverableCopy(magnetType, ctx) : null),
    topics: topics.map((t) => t.topic),
  }
}

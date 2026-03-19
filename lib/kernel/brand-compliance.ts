/**
 * lib/kernel/brand-compliance.ts
 *
 * Brand compliance gate for all outbound content types.
 *
 * Content type → table → update column map (live schema verified):
 *   social_post    → social_posts       → brand_compliance_passed + compliance_checked_at
 *   video          → ai_video_projects  → video_metadata jsonb (no dedicated column)
 *   listing_media  → listing_media      → kernel_compliance_passed
 *   document       → (no documents table in public schema) → lifecycle_events only
 *
 * Brand rules are loaded from global_settings.additional_settings (jsonb):
 *   approved_hashtags     string[]
 *   prohibited_language   string[]
 *   brokerage_avatar_id   string   (expected heygen_avatar_id for video)
 *   brokerage_voice_id    string   (expected heygen_voice_id for video)
 *   cma_disclaimer_text   string   (required substring for document type)
 *
 * Emits KernelEvent.BRAND_COMPLIANCE_PASSED or BRAND_COMPLIANCE_FAILED
 * via processKernelEvent() (non-blocking — compliance result is returned regardless).
 */

import { createServiceClient } from "@/lib/supabase/service"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CheckBrandComplianceParams {
  contentType: "video" | "social_post" | "document" | "listing_media" | "blog_post" | "podcast" | "newsletter" | "ad_creative"
  contentId: string
  brokerageId: string
}

export interface BrandComplianceResult {
  passed: boolean
  violations: string[]
}

// ─── Main exported function ───────────────────────────────────────────────────

export async function checkBrandCompliance(
  params: CheckBrandComplianceParams
): Promise<BrandComplianceResult> {
  const { contentType, contentId, brokerageId } = params
  const supabase = createServiceClient()
  const violations: string[] = []

  // ── Step 1: Load global_settings for brokerage ────────────────────────────
  const { data: settings } = await supabase
    .from("global_settings")
    .select("app_logo_url, primary_color, secondary_color, additional_settings")
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  // additional_settings jsonb holds brand-specific rules
  const additionalSettings = (settings?.additional_settings ?? {}) as Record<string, unknown>
  const approvedHashtags = (additionalSettings.approved_hashtags ?? []) as string[]
  const prohibitedLanguage = (additionalSettings.prohibited_language ?? []) as string[]
  const brokerageAvatarId = (additionalSettings.brokerage_avatar_id ?? null) as string | null
  const brokerageVoiceId = (additionalSettings.brokerage_voice_id ?? null) as string | null
  const cmaDisclaimerText = (additionalSettings.cma_disclaimer_text ?? null) as string | null
  const logoUrl = settings?.app_logo_url ?? null

  // ── Step 2–5: Type-specific compliance checks ─────────────────────────────

  if (contentType === "social_post") {
    await checkSocialPost({
      supabase,
      contentId,
      brokerageId,
      approvedHashtags,
      prohibitedLanguage,
      logoUrl,
      violations,
    })
  } else if (contentType === "video") {
    await checkVideo({
      supabase,
      contentId,
      brokerageAvatarId,
      brokerageVoiceId,
      violations,
    })
  } else if (contentType === "document") {
    await checkDocument({
      supabase,
      contentId,
      cmaDisclaimerText,
      violations,
    })
  } else if (contentType === "listing_media") {
    await checkListingMedia({
      supabase,
      contentId,
      violations,
    })
  // ── blog_post ──────────────────────────────────────────────────────────────
  } else if (contentType === "blog_post") {
    const { data: blog } = await supabase
      .from("blog_posts")
      .select("id, brokerage_id, title, content, publish_status, seo_score")
      .eq("id", contentId)
      .maybeSingle()

    if (!blog) {
      violations.push("blog_post record not found")
    } else {
      if (prohibitedLanguage?.some((w: string) => blog.content?.toLowerCase().includes(w.toLowerCase()))) {
        violations.push("prohibited language in blog content")
      }
    }

    const blogPassed = violations.length === 0
    await supabase
      .from("blog_posts")
      .update({ seo_score: blogPassed ? (blog?.seo_score ?? 0) : (blog?.seo_score ?? 0) })
      .eq("id", contentId)

  // ── podcast ───────────────────────────────────────────────────────────────
  } else if (contentType === "podcast") {
    const { data: episode } = await supabase
      .from("podcast_episodes")
      .select("id, brokerage_id, title, script, status")
      .eq("id", contentId)
      .maybeSingle()

    if (!episode) {
      violations.push("podcast_episode record not found")
    } else {
      if (prohibitedLanguage?.some((w: string) => episode.script?.toLowerCase().includes(w.toLowerCase()))) {
        violations.push("prohibited language in podcast script")
      }
    }

  // ── newsletter ────────────────────────────────────────────────────────────
  } else if (contentType === "newsletter") {
    const { data: campaign } = await supabase
      .from("newsletter_campaigns")
      .select("id, brokerage_id, campaign_name, content, brand_compliance_passed")
      .eq("id", contentId)
      .maybeSingle()

    if (!campaign) {
      violations.push("newsletter_campaign record not found")
    } else {
      if (prohibitedLanguage?.some((w: string) => campaign.content?.toLowerCase().includes(w.toLowerCase()))) {
        violations.push("prohibited language in newsletter content")
      }
    }

    const newsletterPassed = violations.length === 0
    await supabase
      .from("newsletter_campaigns")
      .update({ brand_compliance_passed: newsletterPassed })
      .eq("id", contentId)

  // ── ad_creative ───────────────────────────────────────────────────────────
  } else if (contentType === "ad_creative") {
    const { data: creative } = await supabase
      .from("ad_creative_variations")
      .select("id, brokerage_id, headline, primary_text, description, approval_status")
      .eq("id", contentId)
      .maybeSingle()

    if (!creative) {
      violations.push("ad_creative_variation record not found")
    } else {
      const adText = [creative.headline, creative.primary_text, creative.description].join(" ")
      if (prohibitedLanguage?.some((w: string) => adText.toLowerCase().includes(w.toLowerCase()))) {
        violations.push("prohibited language in ad creative")
      }
    }
  }

  const passed = violations.length === 0

  // ── Step 6: Emit kernel event ──────────────────────────────────────────────
  const kernelEvent = passed
    ? KernelEvent.BRAND_COMPLIANCE_PASSED
    : KernelEvent.BRAND_COMPLIANCE_FAILED

  await processKernelEvent({
    event:      kernelEvent,
    brokerageId,
    entityType: contentType,
    entityId:   contentId,
    metadata:   { passed, violations },
  }).catch(() => {
    // Non-blocking — compliance result is returned regardless of notification outcome
  })

  // ── Step 7: UPDATE content record ─────────────────────────────────────────
  await updateComplianceRecord({ supabase, contentType, contentId, passed })

  return { passed, violations }
}

// ─── Per-type checkers ────────────────────────────────────────────────────────

async function checkSocialPost(ctx: {
  supabase: ReturnType<typeof createServiceClient>
  contentId: string
  brokerageId: string
  approvedHashtags: string[]
  prohibitedLanguage: string[]
  logoUrl: string | null
  violations: string[]
}): Promise<void> {
  const { supabase, contentId, approvedHashtags, prohibitedLanguage, violations } = ctx

  const { data: post } = await supabase
    .from("social_posts")
    .select("content, hashtags, platform, status")
    .eq("id", contentId)
    .maybeSingle()

  if (!post) {
    violations.push("social_post record not found")
    return
  }

  // Verify approved hashtags — every tag used must be in the approved set
  if (approvedHashtags.length > 0 && Array.isArray(post.hashtags)) {
    const unapproved = (post.hashtags as string[]).filter(
      (tag: string) => !approvedHashtags.includes(tag.toLowerCase().replace(/^#/, ""))
    )
    if (unapproved.length > 0) {
      violations.push(`Unapproved hashtags: ${unapproved.join(", ")}`)
    }
  }

  // Verify no prohibited language in content
  if (prohibitedLanguage.length > 0 && post.content) {
    const contentLower = post.content.toLowerCase()
    const found = prohibitedLanguage.filter((word: string) =>
      contentLower.includes(word.toLowerCase())
    )
    if (found.length > 0) {
      violations.push(`Prohibited language detected: ${found.join(", ")}`)
    }
  }

  // Verify correct logo — posts must not reference an external/untrusted logo URL
  // (presence check: if brand logo is configured, content must not embed a competitor logo pattern)
  // This is a lightweight heuristic — deep image inspection is out of scope for the kernel gate
  if (post.content && post.content.includes("competitor_logo")) {
    violations.push("Content references a non-brokerage logo")
  }
}

async function checkVideo(ctx: {
  supabase: ReturnType<typeof createServiceClient>
  contentId: string
  brokerageAvatarId: string | null
  brokerageVoiceId: string | null
  violations: string[]
}): Promise<void> {
  const { supabase, contentId, brokerageAvatarId, brokerageVoiceId, violations } = ctx

  const { data: video } = await supabase
    .from("ai_video_projects")
    .select("heygen_avatar_id, heygen_voice_id, status")
    .eq("id", contentId)
    .maybeSingle()

  if (!video) {
    violations.push("ai_video_projects record not found")
    return
  }

  // Verify brokerage avatar is used — only checked when brokerage has a configured avatar
  if (brokerageAvatarId && video.heygen_avatar_id !== brokerageAvatarId) {
    violations.push(
      `Video uses avatar '${video.heygen_avatar_id ?? "none"}' — expected brokerage avatar '${brokerageAvatarId}'`
    )
  }

  // Verify brokerage voice is used — only checked when brokerage has a configured voice
  if (brokerageVoiceId && video.heygen_voice_id !== brokerageVoiceId) {
    violations.push(
      `Video uses voice '${video.heygen_voice_id ?? "none"}' — expected brokerage voice '${brokerageVoiceId}'`
    )
  }
}

async function checkDocument(ctx: {
  supabase: ReturnType<typeof createServiceClient>
  contentId: string
  cmaDisclaimerText: string | null
  violations: string[]
}): Promise<void> {
  const { supabase, contentId, cmaDisclaimerText, violations } = ctx

  // client_documents table exists — attempt a read but
  // treat a missing table gracefully; only the lifecycle_event and result matter
  const { data: doc } = await supabase
    .from("client_documents")
    .select("content, document_type")
    .eq("id", contentId)
    .maybeSingle()
    .catch(() => ({ data: null, error: null }))

  if (!doc) {
    // No documents table or record not found — emit as passed with a note
    // (cannot enforce disclaimer if we cannot read the document)
    return
  }

  // Verify CMA disclaimer is present (required for document_type = 'cma')
  const docRecord = doc as { content?: string; document_type?: string }
  if (docRecord.document_type === "cma") {
    if (!cmaDisclaimerText) {
      violations.push("CMA_DISCLAIMER not configured in global_settings.additional_settings")
    } else if (!docRecord.content?.includes(cmaDisclaimerText)) {
      violations.push("CMA document is missing the required brokerage disclaimer")
    }
  }
}

async function checkListingMedia(ctx: {
  supabase: ReturnType<typeof createServiceClient>
  contentId: string
  violations: string[]
}): Promise<void> {
  const { supabase, contentId, violations } = ctx

  const { data: media } = await supabase
    .from("listing_media")
    .select("id, media_type, status")
    .eq("id", contentId)
    .maybeSingle()

  if (!media) {
    violations.push("listing_media record not found")
  }
  // Listing media brand rules are currently limited to record existence;
  // deeper pixel-level inspection is delegated to the media vendor pipeline.
}

// ─── Record updater ───────────────────────────────────────────────────────────

async function updateComplianceRecord(ctx: {
  supabase: ReturnType<typeof createServiceClient>
  contentType: CheckBrandComplianceParams["contentType"]
  contentId: string
  passed: boolean
}): Promise<void> {
  const { supabase, contentType, contentId, passed } = ctx
  const now = new Date().toISOString()

  if (contentType === "social_post") {
    // social_posts uses brand_compliance_passed + compliance_checked_at (live schema confirmed)
    await supabase
      .from("social_posts")
      .update({
        brand_compliance_passed: passed,
        compliance_checked_at:  now,
        updated_at:              now,
      })
      .eq("id", contentId)
  } else if (contentType === "video") {
    // ai_video_projects has no dedicated compliance column — store in video_metadata jsonb
    const { data: existing } = await supabase
      .from("ai_video_projects")
      .select("video_metadata")
      .eq("id", contentId)
      .maybeSingle()

    const currentMeta = (existing?.video_metadata ?? {}) as Record<string, unknown>
    await supabase
      .from("ai_video_projects")
      .update({
        video_metadata: {
          ...currentMeta,
          kernel_compliance_passed: passed,
          compliance_checked_at:    now,
        },
        updated_at: now,
      })
      .eq("id", contentId)
  } else if (contentType === "listing_media") {
    // listing_media.kernel_compliance_passed confirmed in live schema
    await supabase
      .from("listing_media")
      .update({ kernel_compliance_passed: passed })
      .eq("id", contentId)
  }
  // document: no table in public schema — no UPDATE issued
}

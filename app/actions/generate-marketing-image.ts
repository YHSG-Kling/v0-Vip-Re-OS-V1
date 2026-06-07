"use server"

/**
 * Generate Marketing Image — server action wrapping the DALL-E primitive.
 *
 * Flow:
 *   1. Resolve agent + brokerage context
 *   2. Load brand hints — brokerage (name, color, logo) + agent's brand voice
 *      Team logo takes precedence over brokerage logo when agent belongs to a team
 *   3. Call generateImage() — logo is composited server-side by Sharp
 *   4. Persist to marketing_assets so the image lives in the asset library
 *   5. Return URL + asset_id to the caller
 *
 * Logo behaviour:
 *   - Default: brokerage/team logo is composited onto the bottom-right corner
 *   - noLogo=true: skip compositing, use brokerage name text in the prompt instead
 */

import { resolveWriteContext } from "@/lib/kernel/identity"
import { createServiceClient } from "@/lib/supabase/service"
import {
  generateImage,
  type ImagePurpose,
  type ImageSize,
  type ImageQuality,
  type ImageStyle,
} from "@/lib/ai/image-generation"

/**
 * Map an image purpose to a VALID marketing_assets.asset_type. The table's
 * CHECK constraint allows video/snippet/script/graphic/template/social_post/
 * newsletter/blog/podcast/mailer/ad_creative/qr — NOT "ai_image". Writing
 * "ai_image" (the pre-fix value) violated the constraint, so the library
 * insert threw and AI images never persisted (the agentic-overseen library
 * had zero AI images). The "this is an AI image" identity is preserved via
 * source_table='ai_image_generation' + metadata.asset_kind.
 */
function purposeToAssetType(purpose: ImagePurpose): string {
  switch (purpose) {
    case "social_post":     return "social_post"
    case "ad_creative":     return "ad_creative"
    case "blog_hero":       return "blog"
    case "newsletter_hero": return "newsletter"
    case "postcard":        return "mailer"
    case "podcast_cover":   return "podcast"
    case "listing_visual":
    case "event_banner":
    case "generic":
    default:                return "graphic"
  }
}

export interface GenerateMarketingImageInput {
  prompt: string
  purpose: ImagePurpose
  size?: ImageSize
  quality?: ImageQuality
  style?: ImageStyle
  /** Optional asset name shown in the library; defaults to a slug from prompt */
  assetName?: string
  /** When tied to an existing campaign, links the asset for analytics */
  campaignId?: string
  /** When tied to a listing, populates listingContext in the prompt */
  listingId?: string
  /** Free-form tags */
  tags?: string[]
  /**
   * When true: skip logo overlay and inject brokerage name text into the prompt
   * instead. Use when the agent explicitly wants text branding over a logo badge.
   */
  noLogo?: boolean
  /**
   * Determines whether real-estate ad-law attribution gets overlaid:
   *   - 'public_marketing' (default) — composite logo + brokerage attribution
   *     band + EHO mark.
   *   - 'mls' — render MLS-clean (no brokerage/agent branding). MLS rules
   *     forbid agent-specific branding on listing media submitted to the MLS.
   *   - 'both' — same as public_marketing; the agent should generate two
   *     separate versions if they need an MLS-clean cut.
   */
  usageIntent?: "public_marketing" | "mls" | "both"
}

export interface GenerateMarketingImageResult {
  success: boolean
  assetId?: string
  imageUrl?: string
  thumbnailUrl?: string
  revisedPrompt?: string
  cost?: number
  error?: string
  errorCode?: string
}

export async function generateMarketingImage(
  input: GenerateMarketingImageInput
): Promise<GenerateMarketingImageResult> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }
  if (!input.prompt?.trim()) {
    return { success: false, error: "Prompt required" }
  }

  const svc = createServiceClient()

  // Load brokerage brand + listing context in parallel. brokerages now stores
  // logo_url, license_number, and license_state (migration 1084) — these are
  // the columns the image-overlay pipeline uses to satisfy real-estate
  // advertising law (brokerage attribution + license # + EHO).
  const [{ data: brokerage }, { data: globalSettings }, listingResult] = await Promise.all([
    svc
      .from("brokerages")
      .select("name, primary_color, logo_url, license_number, license_state, dba")
      .eq("id", ctx.brokerageId)
      .maybeSingle(),
    // Fallback for brokerages that captured the logo via the onboarding brand
    // flow before logo_url was back-filled.
    svc
      .from("global_settings")
      .select("app_logo_url")
      .eq("brokerage_id", ctx.brokerageId)
      .maybeSingle(),
    input.listingId
      ? svc
          .from("listings")
          .select("address, city, state, list_price, bedrooms, bathrooms")
          .eq("id", input.listingId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ])

  let agentName: string | null = null
  let agentLicense: string | null = null
  let teamName: string | null = null
  let logoUrl: string | null = brokerage?.logo_url ?? globalSettings?.app_logo_url ?? null

  if (ctx.userId) {
    const { data: u } = await svc
      .from("users")
      .select("first_name, last_name")
      .eq("id", ctx.userId)
      .maybeSingle()
    agentName = [u?.first_name, u?.last_name].filter(Boolean).join(" ") || null

    // Pull agent's own license # — many states require both broker and agent
    // license numbers on advertising.
    const { data: agentRow } = await svc
      .from("agents")
      .select("id, license_number, license_state, team_id")
      .eq("user_id", ctx.userId)
      .maybeSingle()
    agentLicense = agentRow?.license_number ?? null

    // Team-branded agents get team name + logo overrides. Team membership
    // lives on agents.team_id (migration history confirms — there is no
    // agent_teams table; the older code path queried a non-existent table
    // and silently returned null). When the agent has a team with a logo,
    // it takes precedence over the brokerage logo.
    if (agentRow?.team_id) {
      const { data: team } = await svc
        .from("teams")
        .select("name, logo_url")
        .eq("id", agentRow.team_id)
        .maybeSingle()
      teamName = team?.name ?? null
      if (team?.logo_url) logoUrl = team.logo_url
    }
  }

  // Best-effort brand voice tone
  let brandVoiceTone: string | null = null
  try {
    const { data: bvp } = await svc
      .from("brand_voice_profile")
      .select("tone")
      .eq("brokerage_id", ctx.brokerageId)
      .limit(1)
      .maybeSingle()
    brandVoiceTone = bvp?.tone ?? null
  } catch {}

  // Generate the image
  const genResult = await generateImage({
    prompt: input.prompt,
    purpose: input.purpose,
    size: input.size,
    quality: input.quality,
    style: input.style,
    brand: {
      brokerageName: brokerage?.name ?? null,
      brokerageDba: brokerage?.dba ?? null,
      brokerageLicense: brokerage?.license_number ?? null,
      brokerageLicenseState: brokerage?.license_state ?? null,
      teamName,
      agentName,
      agentLicense,
      primaryColor: brokerage?.primary_color ?? null,
      brandVoiceTone,
      logoUrl: input.noLogo ? null : logoUrl,
      noLogo: input.noLogo ?? false,
      // MLS rules forbid brokerage/agent branding on listing media submitted
      // to the MLS — the rendering pipeline reads this to short-circuit
      // both the logo composite and the attribution band.
      mlsClean: input.usageIntent === "mls",
    },
    listingContext: (listingResult as any).data
      ? {
          address: (listingResult as any).data.address,
          city: (listingResult as any).data.city,
          state: (listingResult as any).data.state,
          listPrice: (listingResult as any).data.list_price,
          bedrooms: (listingResult as any).data.bedrooms,
          bathrooms: (listingResult as any).data.bathrooms,
        }
      : undefined,
  })

  if (!genResult.success || !genResult.imageUrl) {
    return {
      success: false,
      error: genResult.error,
      errorCode: genResult.errorCode,
    }
  }

  // Persist to marketing_assets
  const assetName =
    input.assetName ??
    `${input.purpose.replace(/_/g, " ")} - ${input.prompt.slice(0, 40)}`

  const { data: asset, error: insertErr } = await svc
    .from("marketing_assets")
    .insert({
      brokerage_id: ctx.brokerageId,
      agent_user_id: ctx.userId ?? null,
      created_by: ctx.userId ?? null,
      visibility_scope: "agent",
      campaign_id: input.campaignId ?? null,
      asset_type: purposeToAssetType(input.purpose),
      asset_name: assetName,
      source_table: "ai_image_generation",
      asset_url: genResult.imageUrl,
      thumbnail_url: genResult.thumbnailUrl ?? genResult.imageUrl,
      preview_text: genResult.revisedPrompt?.slice(0, 280) ?? input.prompt.slice(0, 280),
      tags: input.tags ?? [input.purpose],
      approval_status: "pending",
      metadata: {
        asset_kind: "ai_image",
        purpose: input.purpose,
        original_prompt: input.prompt,
        revised_prompt: genResult.revisedPrompt,
        size: genResult.size,
        cost_usd: genResult.cost,
        listing_id: input.listingId ?? null,
        provider: "dall-e-3",
        // Real-estate ad-law attribution audit trail. compositeAttributionBand
        // and compositeLogoOntoImage in image-generation.ts both short-circuit
        // when usageIntent='mls' so MLS-bound images render clean — agent /
        // brokerage attribution is FORBIDDEN on MLS listing media.
        usage_intent:            input.usageIntent ?? "public_marketing",
        mls_clean:               input.usageIntent === "mls",
        logo_composited:         input.usageIntent !== "mls" && !input.noLogo && !!logoUrl,
        brokerage_attribution:   input.usageIntent !== "mls" && !!brokerage?.name,
        license_number_on_image: input.usageIntent !== "mls" && !!brokerage?.license_number,
        eho_mark_on_image:       input.usageIntent !== "mls" && !!brokerage?.name,
        team_name:               teamName,
      },
    })
    .select("id")
    .single()

  if (insertErr || !asset) {
    // Image was generated but library insert failed — return image anyway
    return {
      success: true,
      imageUrl: genResult.imageUrl,
      thumbnailUrl: genResult.thumbnailUrl,
      revisedPrompt: genResult.revisedPrompt,
      cost: genResult.cost,
      error: insertErr?.message ?? "Asset library save failed",
    }
  }

  // Fire image.generated orchestrator event so handleImageGenerated can
  // route the image to the same downstream destinations as videos: social
  // post drafts, contact message drafts, listing landing page, and any
  // marketing-campaign assets sharing the same umbrella.
  try {
    const { emitEventFromCron } = await import("@/lib/orchestrator/internal")
    await emitEventFromCron({
      brokerage_id: ctx.brokerageId,
      user_id:      ctx.userId ?? undefined,
      event_type:   "image.generated",
      source:       "system",
      dedupe_key:   `image.generated:${asset.id}`,
      payload: {
        image_id:              asset.id,
        image_type:            input.purpose,
        image_url:             genResult.imageUrl,
        thumbnail_url:         genResult.thumbnailUrl ?? null,
        caption:               assetName,
        listing_id:            input.listingId ?? null,
        marketing_campaign_id: input.campaignId ?? null,
        agent_user_id:         ctx.userId ?? null,
      },
    })
  } catch (eventErr) {
    console.error("[generateMarketingImage] image.generated event failed:", eventErr)
  }

  return {
    success: true,
    assetId: asset.id,
    imageUrl: genResult.imageUrl,
    thumbnailUrl: genResult.thumbnailUrl,
    revisedPrompt: genResult.revisedPrompt,
    cost: genResult.cost,
  }
}

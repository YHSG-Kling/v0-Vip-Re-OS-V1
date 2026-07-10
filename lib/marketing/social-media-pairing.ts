/**
 * lib/marketing/social-media-pairing.ts
 *
 * MEDIA ↔ COPY PAIRING for autonomous social (owner rule: nothing ships
 * bare — a caption needs fitting media, media needs a fitting caption).
 * The cadence stager wrote text-only drafts for months; every brand post
 * now carries an image:
 *
 *   1. LIBRARY-FIRST — the newest approved marketing_assets image for the
 *      tenant (carousel hooks, twilight/staged photos, quote graphics are
 *      all prime feed art). Reuse beats regeneration: one render → many
 *      marketing uses is the library's whole thesis.
 *   2. GENERATE as the fallback — a brand-aware gpt-image-1 social image
 *      from the post's topic (the image-gen rail already composites the
 *      logo + the legal attribution band and bakes in the Fair-Housing
 *      constraints), CAPTURED back into the library so tomorrow's post
 *      reuses it instead of paying again.
 *
 * Never throws — a bare-text post is still better than no post, so the
 * caller treats null as "stage without media" (and the approval UI shows
 * the gap to the human).
 */

export interface PairedMedia {
  mediaUrls: string[]
  source: "library" | "generated"
  assetId: string | null
}

export async function resolveSocialMedia(
  svc: any,
  params: {
    brokerageId: string
    agentUserId?: string | null
    /** Topic the caption is about — steers both library match and generation. */
    topicTitle?: string | null
    postType?: string | null
  },
): Promise<PairedMedia | null> {
  try {
    // 1. LIBRARY-FIRST — prefer the agent's own art, then the brokerage's.
    const { data: assets } = await svc.from("marketing_assets")
      .select("id, asset_url, agent_user_id, tags, asset_name")
      .eq("brokerage_id", params.brokerageId)
      .eq("asset_type", "image")
      .eq("approval_status", "approved")
      .not("asset_url", "is", null)
      .order("created_at", { ascending: false })
      .limit(30)
    const rows = (assets ?? []) as Array<{ id: string; asset_url: string; agent_user_id: string | null; tags: string[] | null; asset_name: string | null }>
    if (rows.length > 0) {
      const topicWords = (params.topicTitle ?? "").toLowerCase().split(/\W+/).filter((w) => w.length > 4)
      const matchesTopic = (r: { tags: string[] | null; asset_name: string | null }) => {
        const hay = `${(r.tags ?? []).join(" ")} ${r.asset_name ?? ""}`.toLowerCase()
        return topicWords.some((w) => hay.includes(w))
      }
      const pick =
        rows.find((r) => r.agent_user_id === params.agentUserId && matchesTopic(r)) ??
        rows.find((r) => matchesTopic(r)) ??
        rows.find((r) => r.agent_user_id === params.agentUserId) ??
        rows[0]
      return { mediaUrls: [pick.asset_url], source: "library", assetId: pick.id }
    }

    // 2. GENERATE — brand-aware, FH-constrained, attribution-banded by the rail.
    const { data: b } = await svc.from("brokerages")
      .select("name, dba, primary_color, logo_url, license_number, license_state")
      .eq("id", params.brokerageId).maybeSingle()
    const { generateImage } = await import("@/lib/ai/image-generation")
    const prompt = params.topicTitle
      ? `An editorial real-estate social image illustrating: ${params.topicTitle}. Architectural or lifestyle photography mood, no people.`
      : "A premium residential architecture photograph — warm light, inviting, editorial quality, no people."
    const result = await generateImage({
      prompt,
      purpose: "social_post",
      brand: {
        brokerageName: (b as any)?.name ?? null,
        brokerageDba: (b as any)?.dba ?? null,
        brokerageLicense: (b as any)?.license_number ?? null,
        brokerageLicenseState: (b as any)?.license_state ?? null,
        primaryColor: (b as any)?.primary_color ?? null,
        logoUrl: (b as any)?.logo_url ?? null,
      },
    })
    if (!result.success || !result.imageUrl) return null

    // Capture into the library so the NEXT post reuses it (one asset → many uses).
    const { data: captured } = await svc.from("marketing_assets").insert({
      brokerage_id: params.brokerageId,
      agent_user_id: params.agentUserId ?? null,
      visibility_scope: "brokerage",
      asset_type: "image",
      asset_name: params.topicTitle ? `Social — ${params.topicTitle.slice(0, 60)}` : "Social brand image",
      asset_url: result.imageUrl,
      thumbnail_url: result.imageUrl,
      source_table: "social_posts",
      source_id: null,
      tags: ["reusable", "social", ...(params.postType ? [params.postType] : [])],
      approval_status: "approved",
      metadata: { captured_from: "social_cadence_pairing", topic: params.topicTitle ?? null },
    }).select("id").maybeSingle()

    return { mediaUrls: [result.imageUrl], source: "generated", assetId: (captured as { id: string } | null)?.id ?? null }
  } catch {
    return null
  }
}

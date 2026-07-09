// lib/video/video-plays.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE AUTONOMOUS VIDEO PLAYS — the three moments where speed and automation
// beat every marketing tool serving real estate. Each play is a pure detector
// over ledgers we already own + a runner that stages through the Video
// Director's commissionVideo (compliance-gated, idempotent per entity+kind,
// format-learning, avatar/QR/bookends per the finish spec). Nothing here
// renders or sends — the Director stages, the render rail produces, the
// existing gates deliver.
//
//   1. MARKET MOMENT — mortgage rates just moved (market_rate_snapshots, the
//      ledger refresh-market-rates fills daily): a meaningful 30yr-fixed DROP
//      stages a circle-avatar MarketUpdateReel per active agent within the
//      same cron tick. Agents' faces on the news hours before anyone using a
//      manual tool has opened an editor.
//   2. TESTIMONIAL ENGINE — a five-star review with real text (agent_reviews,
//      filled by review-request-on-close) becomes a TestimonialReel,
//      idempotent per review. Social proof on autopilot.
//   3. WALKTHROUGH PREMIERE — a photo-rich listing entering its marketing
//      window gets the Ken Burns PhotoWalkthroughReel as its day-one asset,
//      idempotent per listing. Every listing premieres with a video.

export interface RateMoment {
  moment: boolean
  dropBps: number
  label: string
}

/** PURE: a market moment is a ≥ 12.5bps (an eighth-point) DROP in the 30yr
 *  fixed vs the prior snapshot — the threshold buyers actually notice. Rises
 *  and noise are NOT moments (we never manufacture urgency). */
export function detectRateMoment(latestBps: number | null, previousBps: number | null): RateMoment {
  if (latestBps == null || previousBps == null) return { moment: false, dropBps: 0, label: "" }
  const drop = previousBps - latestBps
  if (drop < 12.5) return { moment: false, dropBps: Math.max(0, drop), label: "" }
  const pct = (latestBps / 100).toFixed(2)
  return {
    moment: true, dropBps: drop,
    label: `30-year fixed just dropped ${(drop / 100).toFixed(2)}% to ${pct}%`,
  }
}

/** PURE: a testimonial-worthy review — five stars, real words, no video yet.
 *  Thin or unrated reviews never become videos (no manufactured praise). */
export function isTestimonialWorthy(r: { rating: number | null; review_text: string | null; video_url: string | null }): boolean {
  return Number(r.rating) >= 5 && (r.review_text ?? "").trim().length >= 40 && !r.video_url
}

/** PURE: a walkthrough-premiere listing — in its marketing window with enough
 *  photos to carry a Ken Burns cut. */
export function isWalkthroughEligible(l: { lifecycle_stage: string | null; photos: unknown }): boolean {
  const stage = (l.lifecycle_stage ?? "").toUpperCase()
  const inWindow = ["COMING_SOON_ACTIVE", "MLS_ACTIVE", "OPEN_HOUSE_MARKETING"].includes(stage)
  const photoCount = Array.isArray(l.photos) ? l.photos.length : 0
  return inWindow && photoCount >= 5
}

export interface VideoPlaysResult { rateMoment: boolean; marketReels: number; testimonialReels: number; walkthroughs: number; errors: number }

/** MARKET MOMENT runner — call from the refresh-market-rates cron right after
 *  the day's snapshot lands. One commission per agent per rate_date. */
export async function runMarketMomentReels(svc: any): Promise<Pick<VideoPlaysResult, "rateMoment" | "marketReels" | "errors">> {
  const out = { rateMoment: false, marketReels: 0, errors: 0 }
  const { data: snaps } = await svc.from("market_rate_snapshots")
    .select("rate_date, rate_30yr_fixed_bps")
    .order("rate_date", { ascending: false }).limit(2)
  const [latest, prev] = ((snaps ?? []) as any[])
  const moment = detectRateMoment(latest?.rate_30yr_fixed_bps ?? null, prev?.rate_30yr_fixed_bps ?? null)
  if (!moment.moment) return out
  out.rateMoment = true

  const { commissionVideo } = await import("@/lib/video/video-director")
  const { data: brokerages } = await svc.from("brokerages").select("id").limit(2000)
  for (const b of ((brokerages ?? []) as any[])) {
    try {
      const { data: agents } = await svc.from("agents")
        .select("user_id").eq("brokerage_id", b.id).eq("is_active", true).not("user_id", "is", null).limit(100)
      for (const a of ((agents ?? []) as any[])) {
        const r = await commissionVideo(
          { kind: "market_update", tier: "brokerage", targetChannel: "instagram", facts: { rateDropBps: moment.dropBps, headline: moment.label } },
          { brokerageId: b.id, agentUserId: a.user_id, idempotencyDiscriminator: `rate-${latest.rate_date}` },
          svc,
        )
        if (r.ok) out.marketReels += 1
      }
    } catch { out.errors += 1 }
  }
  return out
}

/** TESTIMONIAL ENGINE runner — five-star reviews become TestimonialReels,
 *  idempotent per review via the Director's discriminator key. */
export async function runTestimonialReels(svc: any): Promise<Pick<VideoPlaysResult, "testimonialReels" | "errors">> {
  const out = { testimonialReels: 0, errors: 0 }
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const { commissionVideo } = await import("@/lib/video/video-director")
  const { data: reviews } = await svc.from("agent_reviews")
    .select("id, brokerage_id, agent_id, contact_id, rating, review_text, reviewer_name, video_url")
    .gte("created_at", since).gte("rating", 5).is("video_url", null).limit(200)
  for (const r of ((reviews ?? []) as any[])) {
    if (!isTestimonialWorthy(r) || !r.agent_id || !r.brokerage_id) continue
    try {
      const res = await commissionVideo(
        { kind: "testimonial", tier: "brokerage", targetChannel: "instagram", facts: { reviewId: r.id, quote: String(r.review_text).slice(0, 400), reviewerName: r.reviewer_name ?? "A happy client" } },
        { brokerageId: r.brokerage_id, agentUserId: r.agent_id, contactId: r.contact_id ?? null, idempotencyDiscriminator: `review-${r.id}` },
        svc,
      )
      if (res.ok) out.testimonialReels += 1
    } catch { out.errors += 1 }
  }
  return out
}

/** WALKTHROUGH PREMIERE runner — photo-rich listings in the marketing window
 *  get the Ken Burns day-one asset, idempotent per listing. */
export async function runWalkthroughPremieres(svc: any): Promise<Pick<VideoPlaysResult, "walkthroughs" | "errors">> {
  const out = { walkthroughs: 0, errors: 0 }
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const { commissionVideo } = await import("@/lib/video/video-director")
  const { data: listings } = await svc.from("listings")
    .select("id, brokerage_id, agent_id, address, lifecycle_stage, photos")
    .in("lifecycle_stage", ["COMING_SOON_ACTIVE", "MLS_ACTIVE", "OPEN_HOUSE_MARKETING"])
    .is("deleted_at", null).gte("created_at", since).limit(300)
  for (const l of ((listings ?? []) as any[])) {
    if (!isWalkthroughEligible(l)) continue
    try {
      const { data: agent } = await svc.from("agents").select("user_id").eq("id", l.agent_id).maybeSingle()
      const agentUserId = (agent as any)?.user_id
      if (!agentUserId) continue
      const res = await commissionVideo(
        { kind: "photo_walkthrough", tier: "brokerage", targetChannel: "instagram", facts: { address: l.address } },
        { brokerageId: l.brokerage_id, agentUserId, listingId: l.id, idempotencyDiscriminator: "walkthrough" },
        svc,
      )
      if (res.ok) out.walkthroughs += 1
    } catch { out.errors += 1 }
  }
  return out
}

/** LISTING FLYER runner — every photo-rich listing in its marketing window
 *  gets the 8.5x11 print flyer (still render, tracked scan-to-tour QR),
 *  idempotent per listing; the finished PNG is handed to THE AGENT. Closes
 *  the print family (the QR system anticipated `listing_flyer` for years). */
export async function runListingFlyers(svc: any): Promise<{ flyers: number; delivered: number; errors: number }> {
  const out = { flyers: 0, delivered: 0, errors: 0 }
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const { data: listings } = await svc.from("listings")
    .select("id, brokerage_id, agent_id, address, city, state, list_price, bedrooms, bathrooms, sqft, property_type, public_remarks, photos, primary_photo_url, lifecycle_stage")
    .in("lifecycle_stage", ["COMING_SOON_ACTIVE", "MLS_ACTIVE", "OPEN_HOUSE_MARKETING", "OPEN_HOUSE_EVENT"])
    .is("deleted_at", null).gte("created_at", since).limit(300)
  for (const l of ((listings ?? []) as any[])) {
    const photos = Array.isArray(l.photos) ? l.photos.map((p: any) => (typeof p === "string" ? p : p?.url)).filter((u: any) => typeof u === "string") : []
    const hero = l.primary_photo_url ?? photos[0]
    if (!hero) continue
    try {
      const { data: existing } = await svc.from("remotion_composition_renders").select("id")
        .eq("brokerage_id", l.brokerage_id).eq("composition_id", "ListingFlyer")
        .eq("entity_type", "listing_flyer").eq("entity_id", l.id).limit(1).maybeSingle()
      if (existing) continue

      const { data: agent } = await svc.from("agents").select("user_id, photo_url, profile_image_url").eq("id", l.agent_id).maybeSingle()
      const agentUserId = (agent as any)?.user_id
      if (!agentUserId) continue
      const { data: u } = await svc.from("users").select("first_name, last_name, phone").eq("id", agentUserId).maybeSingle()
      const agentName = u ? [(u as any).first_name, (u as any).last_name].filter(Boolean).join(" ") || "Your Agent" : "Your Agent"

      const [{ resolveReelBrand }, { mintVideoQr }] = await Promise.all([
        import("@/lib/video/reel-brand"), import("@/lib/video/video-qr"),
      ])
      const brand = await resolveReelBrand(svc, l.brokerage_id)
      const qr = await mintVideoQr({ brokerageId: l.brokerage_id, agentUserId, kind: "just_listed", listingId: l.id }, svc)

      const stage = String(l.lifecycle_stage ?? "").toUpperCase()
      const statusLine = stage.startsWith("OPEN_HOUSE") ? "OPEN HOUSE" : stage === "COMING_SOON_ACTIVE" ? "COMING SOON" : "JUST LISTED"
      const highlights = String(l.public_remarks ?? "").split(/[.\n]/).map((s: string) => s.trim()).filter((s: string) => s.length > 12 && s.length < 70).slice(0, 4)
      const price = l.list_price ? `$${Number(l.list_price).toLocaleString("en-US")}` : ""

      const { recordRenderQueued } = await import("@/lib/remotion/registry")
      const rq = await recordRenderQueued({
        brokerageId: l.brokerage_id, compositionId: "ListingFlyer", agentUserId,
        entityType: "listing_flyer", entityId: l.id,
        inputProps: {
          address: l.address ?? "", cityState: [l.city, l.state].filter(Boolean).join(", "),
          price, beds: String(l.bedrooms ?? ""), baths: String(l.bathrooms ?? ""),
          sqft: l.sqft ? Number(l.sqft).toLocaleString("en-US") : "", propertyType: l.property_type ?? "",
          highlights, heroImageUrl: hero, photoUrls: photos.slice(1, 4),
          agentName, agentPhone: (u as any)?.phone ?? "",
          agentPhotoUrl: (agent as any)?.photo_url ?? (agent as any)?.profile_image_url ?? null,
          qrCodeDataUrl: qr?.qrCodeDataUrl ?? null, qrCaption: "Scan to tour",
          statusLine,
          brand: { primaryColor: brand.primaryColor, accentColor: brand.accentColor, logoUrl: brand.logoUrl, brokerageName: brand.brokerageName, licenseLine: null, showEhoMark: true },
        },
        scopeType: "brokerage", scopeId: l.brokerage_id, requestedVia: "cron",
      })
      if (rq.ok) out.flyers += 1
    } catch { out.errors += 1 }
  }

  // Deliver finished flyers (stills render within minutes) to THE AGENT.
  try {
    const { data: done } = await svc.from("remotion_composition_renders")
      .select("id, brokerage_id, agent_user_id, output_url, input_props")
      .eq("entity_type", "listing_flyer").eq("render_status", "succeeded")
      .not("output_url", "is", null).gte("created_at", since).limit(100)
    for (const ren of ((done ?? []) as any[])) {
      if (!ren.agent_user_id) continue
      const marker = `[flyer:${ren.id}]`
      const { data: dup } = await svc.from("notifications").select("id")
        .eq("brokerage_id", ren.brokerage_id).ilike("body", `%${marker}%`).limit(1).maybeSingle()
      if (dup) continue
      const address = (ren.input_props as any)?.address ?? "your listing"
      await svc.from("notifications").insert({
        user_id: ren.agent_user_id, brokerage_id: ren.brokerage_id, type: "listing_flyer_ready",
        title: `Print flyer ready — ${address}`,
        body: `Your 8.5x11 open-house flyer (300 DPI, tracked QR) is print-ready: ${ren.output_url} ${marker}`,
        priority: "medium", channel: "in_app", is_read: false,
      }).then(undefined, () => {})
      out.delivered += 1
    }
  } catch { /* delivery retries next run */ }
  return out
}

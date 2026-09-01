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
//
// ── THE PRINT PLAYS ASK THE CONTENT CONTRACT FIRST ──────────────────────────
// runListingFlyers and runDoorHangers do NOT go through the Director (they are
// stills, queued straight onto remotion_composition_renders), so they were
// outside the ONE place that refuses an unrenderable piece before it costs
// anything. They staged `price: ""` for a listing with no list_price,
// `highlights: []` for one with no public_remarks, and `agentPhone: ""` for an
// agent with no phone on their users row — every one of which `isSupplied`
// reads as NOT SUPPLIED, so render-composition's backstop CANCELLED the render.
// The runner still counted it (`out.flyers += 1`), and because the idempotency
// probe matched ANY render row for the listing with no status filter, that
// cancelled row then blocked the listing from EVER getting a flyer again — the
// day the agent added their phone number changed nothing. Three parts, all
// below: ask missingContentProps BEFORE the render row is queued and count the
// skip by name; exclude 'cancelled' from both probes so a fixed listing can
// retry; and increment the success counters only for a row that actually landed.
// (The queue-helper name is deliberately NOT spelled in this comment: the
// partners-meeting simulator counts its occurrences in RAW source, where a
// comment reads as a call site — CLAUDE.md §2's own trap, in another lane's
// file. Reported rather than worked around by editing that guard.)
import { missingContentProps, describeMissingContent } from "@/lib/remotion/content-contract"

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
export async function runListingFlyers(svc: any): Promise<{ flyers: number; skipped: number; delivered: number; errors: number }> {
  const out = { flyers: 0, skipped: 0, delivered: 0, errors: 0 }
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
      // A CANCELLED row is not a flyer — it is the record of one that could not
      // be rendered. Counting it as "already produced" is what turned a
      // one-tick content gap into a permanent one, so it is excluded here.
      const { data: existing } = await svc.from("remotion_composition_renders").select("id")
        .eq("brokerage_id", l.brokerage_id).eq("composition_id", "ListingFlyer")
        .eq("entity_type", "listing_flyer").eq("entity_id", l.id)
        .neq("render_status", "cancelled")
        .limit(1).maybeSingle()
      if (existing) continue

      const { data: agent } = await svc.from("agents").select("user_id, photo_url, profile_image_url").eq("id", l.agent_id).maybeSingle()
      const agentUserId = (agent as any)?.user_id
      if (!agentUserId) continue
      const { data: u } = await svc.from("users").select("first_name, last_name, phone").eq("id", agentUserId).maybeSingle()
      const agentName = u ? [(u as any).first_name, (u as any).last_name].filter(Boolean).join(" ") || "Your Agent" : "Your Agent"

      const stage = String(l.lifecycle_stage ?? "").toUpperCase()
      const statusLine = stage.startsWith("OPEN_HOUSE") ? "OPEN HOUSE" : stage === "COMING_SOON_ACTIVE" ? "COMING SOON" : "JUST LISTED"
      const highlights = String(l.public_remarks ?? "").split(/[.\n]/).map((s: string) => s.trim()).filter((s: string) => s.length > 12 && s.length < 70).slice(0, 4)
      const price = l.list_price ? `$${Number(l.list_price).toLocaleString("en-US")}` : ""

      // THE CONTENT GATE RUNS BEFORE THE QR IS MINTED. Every prop ListingFlyer
      // REQUIRES is already known at this point — none of them comes from the
      // brand row or the QR — so the refusal costs nothing: no qr_codes slug is
      // minted for a piece that cannot exist, which is the same defect the
      // buyer-match reel carried one lane over.
      const claims: Record<string, unknown> = {
        address: l.address ?? "", cityState: [l.city, l.state].filter(Boolean).join(", "),
        price, beds: String(l.bedrooms ?? ""), baths: String(l.bathrooms ?? ""),
        sqft: l.sqft ? Number(l.sqft).toLocaleString("en-US") : "", propertyType: l.property_type ?? "",
        highlights, agentName, agentPhone: (u as any)?.phone ?? "", statusLine,
      }
      const missingEarly = missingContentProps("ListingFlyer", claims)
      if (missingEarly.length > 0) {
        out.skipped += 1
        console.warn(`[video-plays] listing ${l.id} flyer skipped — ${describeMissingContent("ListingFlyer", missingEarly)}`)
        continue
      }

      const [{ resolveReelBrand }, { mintVideoQr }] = await Promise.all([
        import("@/lib/video/reel-brand"), import("@/lib/video/video-qr"),
      ])
      const brand = await resolveReelBrand(svc, l.brokerage_id)
      const qr = await mintVideoQr({ brokerageId: l.brokerage_id, agentUserId, kind: "just_listed", listingId: l.id }, svc)

      const inputProps: Record<string, unknown> = {
        address: l.address ?? "", cityState: [l.city, l.state].filter(Boolean).join(", "),
        price, beds: String(l.bedrooms ?? ""), baths: String(l.bathrooms ?? ""),
        sqft: l.sqft ? Number(l.sqft).toLocaleString("en-US") : "", propertyType: l.property_type ?? "",
        highlights, heroImageUrl: hero, photoUrls: photos.slice(1, 4),
        agentName, agentPhone: (u as any)?.phone ?? "",
        agentPhotoUrl: (agent as any)?.photo_url ?? (agent as any)?.profile_image_url ?? null,
        qrCodeDataUrl: qr?.qrCodeDataUrl ?? null, qrCaption: "Scan to tour",
        statusLine,
        brand: { primaryColor: brand.primaryColor, accentColor: brand.accentColor, logoUrl: brand.logoUrl, brokerageName: brand.brokerageName, licenseLine: null, showEhoMark: true },
      }

      // THE AUTHORITATIVE GATE, on the payload that will actually be staged —
      // the same question the render backstop asks. The early check above is a
      // spend guard; this one is the contract. A flyer with no price, no
      // highlights or no agent phone is not a flyer with a gap: the contract
      // reads "" and [] as unsupplied, so Remotion would merge the Studio sample
      // data over them and render-composition cancels the render. Skipping by
      // NAME (and counting it) is what turns an invisible cancellation into
      // something an agent can act on.
      const missing = missingContentProps("ListingFlyer", inputProps)
      if (missing.length > 0) {
        out.skipped += 1
        console.warn(`[video-plays] listing ${l.id} flyer skipped — ${describeMissingContent("ListingFlyer", missing)}`)
        continue
      }

      const { recordRenderQueued } = await import("@/lib/remotion/registry")
      const rq = await recordRenderQueued({
        brokerageId: l.brokerage_id, compositionId: "ListingFlyer", agentUserId,
        entityType: "listing_flyer", entityId: l.id,
        inputProps,
        scopeType: "brokerage", scopeId: l.brokerage_id, requestedVia: "cron",
      })
      // Only a row that actually landed is a flyer. A refused insert used to
      // fall through both counters and report as a clean tick (§3 — supabase-js
      // resolves refusals; the queue helper hands the message back on `.error`
      // and nobody read it).
      if (rq.ok) out.flyers += 1
      else {
        out.errors += 1
        console.warn(`[video-plays] listing ${l.id} flyer queue refused: ${rq.error ?? "unknown"}`)
      }
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

/** DOOR HANGER PLAY — a listing CLOSES and the neighborhood door-knock piece
 *  is waiting for the agent the same day: "JUST SOLD" + the neighbor hook +
 *  a scan-to-value QR (4.25x11 @ 300 DPI print still, dashed knob die-cut
 *  guide). Idempotent per listing (entity_type door_hanger). A print STILL,
 *  not a Director video — it queues the render directly like the flyer. */
export async function runDoorHangers(svc: any): Promise<{ doorHangers: number; hangersSkipped: number; hangersDelivered: number; hangerErrors: number }> {
  // `hangersSkipped`, not `skipped` — the video-plays cron merges this bag over
  // the flyer bag into one summary object, so an unprefixed key would silently
  // overwrite the flyer count. The rest of this shape is already prefixed for
  // the same reason.
  const out = { doorHangers: 0, hangersSkipped: 0, hangersDelivered: 0, hangerErrors: 0 }
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const { data: listings } = await svc.from("listings")
    .select("id, brokerage_id, agent_id, address, city, state, photos, primary_photo_url, lifecycle_stage, updated_at")
    .eq("lifecycle_stage", "CLOSED")
    .is("deleted_at", null).gte("updated_at", since).limit(200)
  for (const l of ((listings ?? []) as any[])) {
    const photos = Array.isArray(l.photos) ? l.photos.map((p: any) => (typeof p === "string" ? p : p?.url)).filter((u: any) => typeof u === "string") : []
    const hero = l.primary_photo_url ?? photos[0]
    if (!hero) continue
    try {
      // Cancelled ≠ produced — see the flyer probe above.
      const { data: existing } = await svc.from("remotion_composition_renders").select("id")
        .eq("brokerage_id", l.brokerage_id).eq("composition_id", "DoorHanger")
        .eq("entity_type", "door_hanger").eq("entity_id", l.id)
        .neq("render_status", "cancelled")
        .limit(1).maybeSingle()
      if (existing) continue

      const { data: agent } = await svc.from("agents").select("user_id, photo_url, profile_image_url").eq("id", l.agent_id).maybeSingle()
      const agentUserId = (agent as any)?.user_id
      if (!agentUserId) continue
      const { data: u } = await svc.from("users").select("first_name, last_name, phone").eq("id", agentUserId).maybeSingle()
      const agentName = u ? [(u as any).first_name, (u as any).last_name].filter(Boolean).join(" ") || "Your Agent" : "Your Agent"

      // The neighbor hook is AI-written per listing (the copy rail bakes in
      // the Fair-Housing rules) — the deterministic line is only the fallback,
      // and it is never empty, so the content gate can run against it BEFORE
      // the QR is minted and before a model is paid to write a hook for a piece
      // that cannot be printed.
      let hook = "Curious what YOUR home is worth in today's market?"

      const claims: Record<string, unknown> = {
        headline: "JUST SOLD",
        address: l.address ?? "", cityState: [l.city, l.state].filter(Boolean).join(", "),
        hook, agentName, agentPhone: (u as any)?.phone ?? "",
      }
      const missingEarly = missingContentProps("DoorHanger", claims)
      if (missingEarly.length > 0) {
        out.hangersSkipped += 1
        console.warn(`[video-plays] listing ${l.id} door hanger skipped — ${describeMissingContent("DoorHanger", missingEarly)}`)
        continue
      }

      const [{ resolveReelBrand }, { mintVideoQr }] = await Promise.all([
        import("@/lib/video/reel-brand"), import("@/lib/video/video-qr"),
      ])
      const brand = await resolveReelBrand(svc, l.brokerage_id)
      const qr = await mintVideoQr({ brokerageId: l.brokerage_id, agentUserId, kind: "just_sold", listingId: l.id }, svc)

      try {
        const { generatePersonaCopy, realCopyGenerator } = await import("@/lib/kernel/ai-copy")
        const draft = await generatePersonaCopy(
          { goal: "a one-sentence door-hanger hook inviting a neighbor to check their home's value after a nearby sale", facts: [l.address ?? "", [l.city, l.state].filter(Boolean).join(", ")], channel: "landing_page", persona: { audience: "neighbors" }, words: 14 },
          { body: hook }, { generator: realCopyGenerator },
        )
        hook = (draft.body || hook).slice(0, 110)
      } catch { /* fallback hook stands */ }

      const inputProps: Record<string, unknown> = {
        headline: "JUST SOLD",
        address: l.address ?? "", cityState: [l.city, l.state].filter(Boolean).join(", "),
        heroImageUrl: hero,
        hook,
        agentName, agentPhone: (u as any)?.phone ?? "",
        agentPhotoUrl: (agent as any)?.photo_url ?? (agent as any)?.profile_image_url ?? null,
        qrCodeDataUrl: qr?.qrCodeDataUrl ?? null, qrCaption: "Scan for your home's value",
        brand: { primaryColor: brand.primaryColor, accentColor: brand.accentColor, logoUrl: brand.logoUrl, brokerageName: brand.brokerageName, licenseLine: null, showEhoMark: true },
      }

      // DoorHanger requires agentPhone — a door-knock piece whose only route
      // back to the agent is blank is exactly what the contract refuses.
      const missing = missingContentProps("DoorHanger", inputProps)
      if (missing.length > 0) {
        out.hangersSkipped += 1
        console.warn(`[video-plays] listing ${l.id} door hanger skipped — ${describeMissingContent("DoorHanger", missing)}`)
        continue
      }

      const { recordRenderQueued } = await import("@/lib/remotion/registry")
      const rq = await recordRenderQueued({
        brokerageId: l.brokerage_id, compositionId: "DoorHanger", agentUserId,
        entityType: "door_hanger", entityId: l.id,
        inputProps,
        scopeType: "brokerage", scopeId: l.brokerage_id, requestedVia: "cron",
      })
      if (rq.ok) out.doorHangers += 1
      else {
        out.hangerErrors += 1
        console.warn(`[video-plays] listing ${l.id} door hanger queue refused: ${rq.error ?? "unknown"}`)
      }
    } catch { out.hangerErrors += 1 }
  }

  // Deliver finished hangers to THE AGENT (stills render within minutes).
  try {
    const { data: done } = await svc.from("remotion_composition_renders")
      .select("id, brokerage_id, agent_user_id, output_url, input_props")
      .eq("entity_type", "door_hanger").eq("render_status", "succeeded")
      .not("output_url", "is", null).gte("created_at", since).limit(100)
    for (const ren of ((done ?? []) as any[])) {
      if (!ren.agent_user_id) continue
      const marker = `[hanger:${ren.id}]`
      const { data: dup } = await svc.from("notifications").select("id")
        .eq("brokerage_id", ren.brokerage_id).ilike("body", `%${marker}%`).limit(1).maybeSingle()
      if (dup) continue
      const address = (ren.input_props as any)?.address ?? "your sold listing"
      await svc.from("notifications").insert({
        user_id: ren.agent_user_id, brokerage_id: ren.brokerage_id, type: "door_hanger_ready",
        title: `Door hangers ready — ${address}`,
        body: `Your just-sold door-knock piece (4.25x11, 300 DPI, scan-to-value QR) is print-ready for the neighborhood: ${ren.output_url} ${marker}`,
        priority: "medium", channel: "in_app", is_read: false,
      }).then(undefined, () => {})
      out.hangersDelivered += 1
    }
  } catch { /* delivery retries next run */ }
  return out
}

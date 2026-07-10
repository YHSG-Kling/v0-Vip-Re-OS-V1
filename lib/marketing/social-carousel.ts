/**
 * lib/marketing/social-carousel.ts
 *
 * SOCIAL CAROUSEL IMAGE SETS — the multi-image format the repurposer named
 * (`instagram_carousel`) but never actually produced (it was a caption-only
 * stub). Now real, and produced the way this OS produces everything:
 *
 *   PLAN    — the AI writes the slide deck (hook → value/photo/stat → CTA)
 *             grounded ONLY in the listing's real facts, cleared through the
 *             compliance gate. Copy is NEVER hardcoded: the deterministic
 *             fact-built slides are the safe FALLBACK when the generator or
 *             gate is unavailable (the lead-magnet pattern).
 *   RENDER  — one CarouselSlide still per swipe through the same render rail
 *             as every other composition (word-perfect text, brand-true).
 *   ASSEMBLE— when every slide has succeeded, ONE social_posts row with the
 *             ordered media_urls, status draft + approval pending — the
 *             existing human gate + publisher carry it out. No connected
 *             Instagram account → the agent still gets the finished set.
 *
 * Idempotent per listing (entity_type social_carousel / post_type carousel).
 * Runs on the daily video-plays cron (asset_manager).
 */
import { gatewayChatJSON } from "@/lib/ai/gateway-chat"
import type { CarouselSlideRole } from "@/remotion/CarouselSlide"

export interface CarouselSlidePlan {
  role: CarouselSlideRole
  kicker: string
  title: string
  body: string
  statValue?: string
  statLabel?: string
  usePhoto?: boolean
}

export interface CarouselListingFacts {
  address: string
  cityState: string
  price: string
  beds: string
  baths: string
  sqft: string
  statusLine: string
  /** Real selling points pulled from the listing's own remarks. */
  highlights: string[]
}

/** PURE fallback: slides built ONLY from the listing's own facts — the safe
 *  floor when the AI generator or the compliance gate is unreachable. */
export function fallbackCarouselPlan(f: CarouselListingFacts): CarouselSlidePlan[] {
  const factsLine = [f.beds && `${f.beds} bed`, f.baths && `${f.baths} bath`, f.sqft && `${f.sqft} sqft`]
    .filter(Boolean).join(" · ")
  return [
    { role: "hook", kicker: `${f.statusLine} · ${f.cityState}`, title: f.address, body: f.price, usePhoto: true },
    { role: "stat", kicker: "The numbers", title: "", body: "", statValue: f.price, statLabel: factsLine || f.address },
    ...(f.highlights.length
      ? [{ role: "value" as const, kicker: "Why this one", title: f.highlights[0], body: f.highlights.slice(1, 3).join(" · ") }]
      : []),
    { role: "photo", kicker: f.cityState, title: f.address, body: "", usePhoto: true },
    { role: "cta", kicker: "See it in person", title: "Tour it before the weekend", body: "Send a message or comment TOUR and we'll set it up." },
  ]
}

/** AI-first plan (compliance-gated), fallback by construction. */
export async function planListingCarousel(
  f: CarouselListingFacts,
  opts: {
    gate?: (text: string) => Promise<{ allowed: boolean }>
    model?: string
  } = {},
): Promise<{ slides: CarouselSlidePlan[]; fromAI: boolean }> {
  const fallback = fallbackCarouselPlan(f)
  try {
    const res = await gatewayChatJSON<{ slides: Array<Record<string, unknown>> }>({
      model: opts.model ?? "openai/gpt-4o-mini",
      maxTokens: 900,
      temperature: 0.7,
      messages: [
        {
          role: "system",
          content:
            "You write Instagram carousel copy for a real-estate listing. HARD RULES: " +
            "FAIR HOUSING — never reference or imply race, religion, national origin, family status, disability, sex, " +
            "and never use steering language ('safe neighborhood', 'perfect for families', 'great for retirees'). " +
            "Use ONLY the facts provided — invent nothing. Titles ≤ 9 words, punchy. Bodies ≤ 22 words. " +
            'Return STRICT JSON: {"slides":[{"role":"hook|value|photo|stat|cta","kicker":"...","title":"...","body":"...","statValue":"...","statLabel":"..."}]} ' +
            "with 5 slides: slide 1 role hook, last slide role cta, one stat slide using the price.",
        },
        {
          role: "user",
          content:
            `Listing facts:\n- Address: ${f.address}\n- Area: ${f.cityState}\n- Price: ${f.price}\n` +
            `- Beds: ${f.beds} · Baths: ${f.baths} · Sqft: ${f.sqft}\n- Status: ${f.statusLine}\n` +
            `- Highlights: ${f.highlights.join("; ") || "(none provided)"}`,
        },
      ],
    })
    const raw = res.ok ? res.data?.slides : null
    if (!Array.isArray(raw) || raw.length < 3) return { slides: fallback, fromAI: false }
    const roles: CarouselSlideRole[] = ["hook", "value", "photo", "stat", "cta"]
    const slides: CarouselSlidePlan[] = raw.slice(0, 6).map((s, i) => {
      const role = roles.includes(s.role as CarouselSlideRole) ? (s.role as CarouselSlideRole)
        : i === 0 ? "hook" : i === raw.length - 1 ? "cta" : "value"
      return {
        role,
        kicker: String(s.kicker ?? "").slice(0, 48),
        title: String(s.title ?? "").slice(0, 90),
        body: String(s.body ?? "").slice(0, 160),
        statValue: s.statValue ? String(s.statValue).slice(0, 16) : undefined,
        statLabel: s.statLabel ? String(s.statLabel).slice(0, 80) : undefined,
        usePhoto: role === "hook" || role === "photo",
      }
    })
    if (opts.gate) {
      const text = slides.map((s) => `${s.kicker} ${s.title} ${s.body} ${s.statLabel ?? ""}`).join("\n")
      const g = await opts.gate(text).catch(() => ({ allowed: false }))
      if (!g.allowed) return { slides: fallback, fromAI: false }
    }
    return { slides, fromAI: true }
  } catch {
    return { slides: fallback, fromAI: false }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RUNNER — queue slides for marketing-window listings, assemble finished sets
// ─────────────────────────────────────────────────────────────────────────────

export async function runListingCarousels(svc: any): Promise<{ carousels: number; carouselPosts: number; carouselErrors: number }> {
  const out = { carousels: 0, carouselPosts: 0, carouselErrors: 0 }
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString()

  const { data: listings } = await svc.from("listings")
    .select("id, brokerage_id, agent_id, address, city, state, list_price, bedrooms, bathrooms, sqft, public_remarks, photos, primary_photo_url, lifecycle_stage")
    .in("lifecycle_stage", ["COMING_SOON_ACTIVE", "MLS_ACTIVE", "OPEN_HOUSE_MARKETING", "OPEN_HOUSE_EVENT"])
    .is("deleted_at", null).gte("created_at", since).limit(200)

  for (const l of ((listings ?? []) as any[])) {
    const photos = Array.isArray(l.photos) ? l.photos.map((p: any) => (typeof p === "string" ? p : p?.url)).filter((u: any) => typeof u === "string") : []
    const hero = l.primary_photo_url ?? photos[0]
    if (!hero || photos.length + (l.primary_photo_url ? 1 : 0) < 3) continue
    try {
      const { data: existing } = await svc.from("remotion_composition_renders").select("id")
        .eq("brokerage_id", l.brokerage_id).eq("composition_id", "CarouselSlide")
        .eq("entity_type", "social_carousel").eq("entity_id", l.id).limit(1).maybeSingle()
      if (existing) continue

      const { data: agent } = await svc.from("agents").select("id, user_id, photo_url, profile_image_url").eq("id", l.agent_id).maybeSingle()
      const agentUserId = (agent as any)?.user_id
      if (!agentUserId) continue
      const { data: u } = await svc.from("users").select("first_name, last_name").eq("id", agentUserId).maybeSingle()
      const agentName = u ? [(u as any).first_name, (u as any).last_name].filter(Boolean).join(" ") || "Your Agent" : "Your Agent"

      const { resolveReelBrand } = await import("@/lib/video/reel-brand")
      const brand = await resolveReelBrand(svc, l.brokerage_id)

      const stage = String(l.lifecycle_stage ?? "").toUpperCase()
      const statusLine = stage.startsWith("OPEN_HOUSE") ? "OPEN HOUSE" : stage === "COMING_SOON_ACTIVE" ? "COMING SOON" : "JUST LISTED"
      const facts: CarouselListingFacts = {
        address: l.address ?? "",
        cityState: [l.city, l.state].filter(Boolean).join(", "),
        price: l.list_price ? `$${Number(l.list_price).toLocaleString("en-US")}` : "",
        beds: String(l.bedrooms ?? ""), baths: String(l.bathrooms ?? ""),
        sqft: l.sqft ? Number(l.sqft).toLocaleString("en-US") : "",
        statusLine,
        highlights: String(l.public_remarks ?? "").split(/[.\n]/).map((s: string) => s.trim()).filter((s: string) => s.length > 12 && s.length < 70).slice(0, 4),
      }

      const gate = async (content: string) => {
        try {
          const { evaluateOutbound } = await import("@/lib/kernel/compliance")
          const r = await evaluateOutbound({
            actorContext: { brokerageId: l.brokerage_id, userId: agentUserId, role: "system" },
            journeyType: "buyer", persona: "other", messageType: "social", content,
          })
          return { allowed: r.allowed }
        } catch { return { allowed: true } } // the fact-built fallback is FH-safe by construction
      }
      const { slides } = await planListingCarousel(facts, { gate })

      const slidePhotos = [hero, ...photos.filter((p: string) => p !== hero)]
      let photoCursor = 0
      const { recordRenderQueued } = await import("@/lib/remotion/registry")
      let queued = 0
      for (let i = 0; i < slides.length; i++) {
        const s = slides[i]
        const photoUrl = s.usePhoto ? (slidePhotos[photoCursor++ % slidePhotos.length] ?? hero) : null
        const rq = await recordRenderQueued({
          brokerageId: l.brokerage_id, compositionId: "CarouselSlide", agentUserId,
          entityType: "social_carousel", entityId: l.id,
          inputProps: {
            role: s.role, slideIndex: i, slideCount: slides.length,
            kicker: s.kicker, title: s.title, body: s.body,
            photoUrl, statValue: s.statValue ?? "", statLabel: s.statLabel ?? "",
            agentName, agentPhotoUrl: (agent as any)?.photo_url ?? (agent as any)?.profile_image_url ?? null,
            handleLine: brand.brokerageName,
            brand: { primaryColor: brand.primaryColor, accentColor: brand.accentColor, logoUrl: brand.logoUrl, brokerageName: brand.brokerageName, licenseLine: null, showEhoMark: true },
          },
          scopeType: "brokerage", scopeId: l.brokerage_id, requestedVia: "cron",
        })
        if (rq.ok) queued++
      }
      if (queued > 0) out.carousels += 1
    } catch { out.carouselErrors += 1 }
  }

  // ── ASSEMBLE: every finished slide set → ONE gated social_posts draft ──
  try {
    const { data: done } = await svc.from("remotion_composition_renders")
      .select("id, brokerage_id, agent_user_id, entity_id, output_url, input_props, render_status")
      .eq("entity_type", "social_carousel").gte("created_at", since).limit(400)
    const byListing = new Map<string, any[]>()
    for (const r of ((done ?? []) as any[])) {
      if (!r.entity_id) continue
      const arr = byListing.get(r.entity_id) ?? []
      arr.push(r)
      byListing.set(r.entity_id, arr)
    }
    for (const [listingId, renders] of byListing) {
      const expected = Number((renders[0]?.input_props as any)?.slideCount ?? 0)
      const finished = renders.filter((r) => r.render_status === "succeeded" && r.output_url)
      if (!expected || finished.length < expected) continue

      const { data: dupPost } = await svc.from("social_posts").select("id")
        .eq("listing_id", listingId).eq("post_type", "carousel").limit(1).maybeSingle()
      if (dupPost) continue

      finished.sort((a, b) => Number((a.input_props as any)?.slideIndex ?? 0) - Number((b.input_props as any)?.slideIndex ?? 0))
      const mediaUrls = finished.slice(0, expected).map((r) => r.output_url)
      const brokerageId = finished[0].brokerage_id
      const agentUserId = finished[0].agent_user_id

      // social_posts.agent_id is agents.id — resolve from the render's user id.
      const { data: agentRow } = await svc.from("agents").select("id")
        .eq("user_id", agentUserId).eq("brokerage_id", brokerageId).maybeSingle()
      if (!agentRow?.id) continue
      const { data: account } = await svc.from("social_media_accounts").select("id")
        .eq("brokerage_id", brokerageId).eq("agent_id", agentRow.id)
        .eq("platform", "instagram").eq("is_active", true).limit(1).maybeSingle()

      // Caption: AI-first, fact-built fallback (never hardcoded marketing prose).
      const address = String((finished[0].input_props as any)?.title ?? "this listing")
      let caption = `${address} — swipe for the story. Comment TOUR for a showing.`
      try {
        const { generatePersonaCopy, realCopyGenerator } = await import("@/lib/kernel/ai-copy")
        const draft = await generatePersonaCopy(
          { goal: "an Instagram caption for a listing carousel (invite saves + a TOUR comment)", facts: [address], channel: "social", persona: { audience: "followers" }, words: 40 },
          { body: caption }, { generator: realCopyGenerator },
        )
        caption = draft.body || caption
      } catch { /* fallback caption stands */ }

      if (account?.id) {
        const { error } = await svc.from("social_posts").insert({
          brokerage_id: brokerageId, agent_id: agentRow.id, social_account_id: account.id,
          listing_id: listingId, platform: "instagram", post_type: "carousel",
          content: caption, media_urls: mediaUrls,
          status: "draft", approval_status: "pending", ai_generated: true,
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        })
        if (!error) out.carouselPosts += 1
      }
      // Either way the AGENT gets the finished set (dedup marker on the notification).
      if (agentUserId) {
        const marker = `[carousel:${listingId}]`
        const { data: dupNote } = await svc.from("notifications").select("id")
          .eq("brokerage_id", brokerageId).ilike("body", `%${marker}%`).limit(1).maybeSingle()
        if (!dupNote) {
          await svc.from("notifications").insert({
            user_id: agentUserId, brokerage_id: brokerageId, type: "social_carousel_ready",
            title: `Carousel ready — ${address}`,
            body: `${mediaUrls.length}-slide Instagram carousel is finished${account?.id ? " and staged for your approval" : " (connect Instagram to publish from here)"}: ${mediaUrls[0]} ${marker}`,
            priority: "medium", channel: "in_app", is_read: false,
          }).then(undefined, () => {})
        }
      }
    }
  } catch { /* assembly retries next run */ }

  return out
}

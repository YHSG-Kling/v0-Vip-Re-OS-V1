// lib/video/director-content.ts
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THE DIRECTOR IS ACTUALLY DIRECTING.
//
// commissionVideo picked a composition, minted a QR, drafted and gated a hook,
// sourced B-roll, consulted the format-learning layer — and then staged a prop
// payload that contained the QR, the music mood, the b-roll and the bookends
// and NOT ONE FACT ABOUT THE SUBJECT. Remotion merges input props over each
// composition's Studio defaults, so the missing half did not render blank: an
// equity report rendered $600,000 against $500,000 paid, a listing reel rendered
// 123 Main Street at $625,000, a testimonial rendered a five-star review from a
// client who does not exist.
//
// The callers were not the problem. equity-trigger already hands over a
// RentCast-backed valuation and the closed transaction's basis price;
// video-plays already hands over a real agent_reviews row. The Director read
// those facts ONLY to feed the hook copy's fact list, and dropped them.
//
// THIS MODULE IS THE MISSING HALF: situation + composition → the content props
// that composition states as fact, resolved from the live tables
// (listings / open_houses / market_data / neighborhood_reports / agent_reviews)
// or from facts the caller already established.
//
// ── THE RULE IT FOLLOWS ─────────────────────────────────────────────────────
// It NEVER invents. Every value here traces to a row or to a caller-supplied
// fact. When a fact is not available the prop is simply omitted, and
// lib/remotion/content-contract.ts refuses the commission with the prop names
// in the reason. A refused commission is a manager telling a human "I could not
// establish these numbers"; a fabricated one is the OS lying on their behalf.
//
// The pure builders are exported separately from the reads so the simulator can
// prove the mapping without a database.

import type { SituationKind, VideoSituation } from "./video-director"

type AnyClient = any

export interface DirectorIdentity {
  agentName: string
  agentPhone: string
  agentPhotoUrl: string | null
  brokerageName: string
  primaryColor: string
  accentColor: string
  logoUrl: string | null
}

/** The brand block every composition takes, from the resolved identity. */
export function brandBlock(id: DirectorIdentity): Record<string, unknown> {
  return {
    primaryColor: id.primaryColor,
    accentColor: id.accentColor,
    brokerageName: id.brokerageName,
    showEhoMark: true,
    ...(id.logoUrl ? { logoUrl: id.logoUrl } : {}),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PURE BUILDERS — row shape in, composition props out. No I/O.
// ─────────────────────────────────────────────────────────────────────────────

export interface ListingRow {
  address?: string | null
  city?: string | null
  state?: string | null
  list_price?: number | null
  sold_price?: number | null
  bedrooms?: number | null
  bathrooms?: number | null
  sqft?: number | null
  property_type?: string | null
  public_remarks?: string | null
  photos?: unknown
  primary_photo_url?: string | null
  listing_date?: string | null
  sold_date?: string | null
  go_live_date?: string | null
  lifecycle_stage?: string | null
}

export function money(n: number | null | undefined): string | null {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null
  return `$${Math.round(n).toLocaleString("en-US")}`
}

export function cityStateOf(l: ListingRow): string | null {
  const s = [l.city, l.state].filter((v) => typeof v === "string" && v.trim()).join(", ")
  return s || null
}

export function photoUrlsOf(l: ListingRow, max = 6): string[] {
  const list = Array.isArray(l.photos) ? (l.photos as unknown[]) : []
  const urls = [
    l.primary_photo_url,
    ...list.map((p) => (typeof p === "string" ? p : (p as { url?: string } | null)?.url)),
  ].filter((u): u is string => typeof u === "string" && u.startsWith("http"))
  return Array.from(new Set(urls)).slice(0, max)
}

/** Whole days between two dates; null when either is unusable. */
export function daysBetween(fromIso: string | null | undefined, toIso: string): number | null {
  if (!fromIso) return null
  const a = Date.parse(fromIso), b = Date.parse(toIso)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  const d = Math.floor((b - a) / 86_400_000)
  return d >= 0 ? d : null
}

/**
 * The JustListed family (also serves price_drop and photo_walkthrough).
 *
 * Omits any prop the row cannot establish, so an incomplete listing is REFUSED
 * by the contract naming the exact missing fields — never padded to look
 * complete. bedrooms/bathrooms/sqft are strings because that is the prop shape
 * the compositions render.
 */
export function listingReelProps(l: ListingRow, hook: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (hook.trim()) out.hook = hook.trim()
  if (l.address?.trim()) out.address = l.address.trim()
  const cs = cityStateOf(l); if (cs) out.cityState = cs
  const price = money(l.list_price); if (price) out.price = price
  if (l.bedrooms != null) out.bedrooms = String(l.bedrooms)
  if (l.bathrooms != null) out.bathrooms = String(l.bathrooms)
  if (l.sqft != null && Number(l.sqft) > 0) out.sqft = Number(l.sqft).toLocaleString("en-US")
  const photos = photoUrlsOf(l); if (photos.length) out.imageUrls = photos
  return out
}

/** JustSoldReelSquare — the agent's public track record, so every number is the row's. */
export function justSoldProps(l: ListingRow, nowIso: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (l.address?.trim()) out.address = l.address.trim()
  const cs = cityStateOf(l); if (cs) out.cityState = cs
  const sold = money(l.sold_price); if (sold) out.soldPrice = sold
  const list = money(l.list_price); if (list) out.listPrice = list
  // Days on market from the row's own dates — listed → sold, or listed → today
  // when the sold date is missing. Never estimated.
  const dom = daysBetween(l.listing_date ?? l.go_live_date, l.sold_date ?? nowIso)
  if (dom != null) out.daysOnMarket = dom
  const photos = photoUrlsOf(l); if (photos.length) out.imageUrls = photos
  return out
}

/** ComingSoonReel — a teaser and a date the viewer plans around. */
export function comingSoonProps(l: ListingRow, id: DirectorIdentity): Record<string, unknown> {
  const out: Record<string, unknown> = { agentName: id.agentName }
  if (l.address?.trim()) out.address = l.address.trim()
  const cs = cityStateOf(l); if (cs) out.cityState = cs
  // The teaser is the listing's own beds + first real remark — never invented.
  const bits: string[] = []
  if (l.bedrooms != null) bits.push(`${l.bedrooms} BD`)
  if (l.bathrooms != null) bits.push(`${l.bathrooms} BA`)
  const remark = String(l.public_remarks ?? "").split(/[.\n]/).map((s) => s.trim())
    .find((s) => s.length > 8 && s.length < 60)
  if (remark) bits.push(remark)
  if (bits.length) out.teaser = bits.join(" · ")
  const when = l.go_live_date ?? l.listing_date
  if (when) {
    const d = new Date(when)
    if (!Number.isNaN(d.getTime())) {
      out.whenString = d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" })
    }
  }
  const photos = photoUrlsOf(l, 1); if (photos[0]) out.heroImageUrl = photos[0]
  return out
}

export interface OpenHouseRow {
  property_address?: string | null
  description?: string | null
  event_date?: string | null
  start_time?: string | null
  end_time?: string | null
}

/**
 * OpenHouseAnnounceReel.
 *
 * The single worst composition in the library to render from defaults: the
 * sample props announce Saturday 12–2 at 185 Berry Street, so a defaulted reel
 * sends buyers to a house on a day nobody will be there. Date and time come
 * from the open_houses row or the reel does not render.
 */
export function openHouseProps(
  oh: OpenHouseRow, l: ListingRow | null, id: DirectorIdentity,
): Record<string, unknown> {
  const out: Record<string, unknown> = { agentName: id.agentName }
  if (id.agentPhone.trim()) out.agentPhone = id.agentPhone.trim()
  const address = (oh.property_address ?? l?.address ?? "").trim()
  if (address) out.address = address
  const cs = l ? cityStateOf(l) : null; if (cs) out.cityState = cs
  if (oh.event_date) {
    const d = new Date(oh.event_date)
    if (!Number.isNaN(d.getTime())) {
      out.dateLabel = d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" })
    }
  }
  const t = formatTimeWindow(oh.start_time, oh.end_time)
  if (t) out.timeLabel = t
  const body = (oh.description ?? l?.public_remarks ?? "").trim()
  if (body) out.bodyLine = body.split(/[.\n]/)[0].trim().slice(0, 120)
  if (l) { const photos = photoUrlsOf(l); if (photos.length) out.imageUrls = photos }
  return out
}

/** "12:00 - 2:00 PM" from two HH:MM[:SS] strings; null when either is missing. */
export function formatTimeWindow(start?: string | null, end?: string | null): string | null {
  const f = (t?: string | null): string | null => {
    if (!t) return null
    const m = /^(\d{1,2}):(\d{2})/.exec(t)
    if (!m) return null
    const h = Number(m[1]), mm = m[2]
    if (!Number.isFinite(h) || h > 23) return null
    const ampm = h >= 12 ? "PM" : "AM"
    const h12 = h % 12 === 0 ? 12 : h % 12
    return `${h12}:${mm} ${ampm}`
  }
  const a = f(start), b = f(end)
  if (!a || !b) return null
  // One meridiem when both sides share it — "12:00 - 2:00 PM".
  const sameHalf = a.slice(-2) === b.slice(-2)
  return sameHalf ? `${a.slice(0, -3)} - ${b}` : `${a} - ${b}`
}

export interface MarketDataRow {
  market_area?: string | null
  city?: string | null
  data_date?: string | null
  median_sale_price?: number | null
  avg_days_on_market?: number | null
  active_listings?: number | null
  price_trend_pct_30d?: number | null
  dom_trend?: string | null
}

/**
 * MarketUpdateReel — three stat cards, each EARNED from market_data.
 *
 * A card only appears when its column has a value, so a thin snapshot produces
 * a shorter honest reel rather than three cards where two are the sample's.
 * `direction` is the composition's colour semantics: for a seller a rising
 * median is good, falling days-on-market is good, rising inventory is not.
 */
export function marketUpdateProps(md: MarketDataRow, id: DirectorIdentity): Record<string, unknown> {
  const stats: Array<Record<string, unknown>> = []
  if (md.median_sale_price != null && md.median_sale_price > 0) {
    const pct = md.price_trend_pct_30d
    stats.push({
      value: compactMoney(md.median_sale_price),
      label: "MEDIAN SALE PRICE",
      delta: pct != null ? `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% MoM` : null,
      direction: pct == null ? "flat" : pct >= 0 ? "up_good" : "down_bad",
    })
  }
  if (md.avg_days_on_market != null && md.avg_days_on_market > 0) {
    // market_data.dom_trend is CHECK-constrained to decreasing|stable|increasing
    // — an ENUM, not a human delta line. Passing it through verbatim would print
    // the word "decreasing" where the card shows "-3 days vs Sept", and would
    // also have hardcoded the arrow: for a seller, days-on-market FALLING is
    // good news and RISING is not, and the column already says which.
    const d = DOM_TREND[String(md.dom_trend ?? "")] ?? null
    stats.push({
      value: `${Math.round(md.avg_days_on_market)} days`,
      label: "AVG DAYS ON MARKET",
      delta: d?.delta ?? null,
      direction: d?.direction ?? "flat",
    })
  }
  if (md.active_listings != null && md.active_listings > 0) {
    stats.push({ value: String(md.active_listings), label: "ACTIVE LISTINGS", delta: null, direction: "up_bad" })
  }

  const out: Record<string, unknown> = { agentName: id.agentName }
  if (id.agentPhone.trim()) out.agentPhone = id.agentPhone.trim()
  const area = (md.market_area ?? md.city ?? "").trim()
  if (area) out.areaName = area
  if (md.data_date) {
    const d = new Date(md.data_date)
    if (!Number.isNaN(d.getTime())) out.period = d.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })
  }
  if (stats.length) out.stats = stats
  return out
}

/**
 * market_data.dom_trend's live vocabulary, mapped to what the card shows.
 *
 * The CHECK on that column is decreasing|stable|increasing. Read from the live
 * schema rather than assumed: the first cut of this file put the raw column
 * value into the card's delta line, which would have rendered the literal word
 * "decreasing" in the slot the composition reserves for "-3 days vs Sept".
 */
const DOM_TREND: Record<string, { delta: string; direction: string }> = {
  decreasing: { delta: "selling faster", direction: "down_good" },
  increasing: { delta: "sitting longer", direction: "up_bad" },
  stable:     { delta: "holding steady", direction: "flat" },
}

export function compactMoney(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `$${Math.round(n / 1000)}K`
  return `$${Math.round(n)}`
}

export interface NeighborhoodRow {
  neighborhood_name?: string | null
  city?: string | null
  median_home_price?: number | null
  walk_score?: number | null
  avg_days_on_market?: number | null
  ai_summary?: string | null
}

/** NeighborhoodSpotlightReel — highlights earned from neighborhood_reports. */
export function neighborhoodProps(n: NeighborhoodRow, id: DirectorIdentity): Record<string, unknown> {
  const highlights: Array<{ label: string; value: string }> = []
  if (n.median_home_price != null && n.median_home_price > 0) {
    highlights.push({ label: "MEDIAN PRICE", value: compactMoney(n.median_home_price) })
  }
  if (n.walk_score != null && n.walk_score > 0) highlights.push({ label: "WALK SCORE", value: String(Math.round(n.walk_score)) })
  if (n.avg_days_on_market != null && n.avg_days_on_market > 0) {
    highlights.push({ label: "AVG DAYS ON MARKET", value: String(Math.round(n.avg_days_on_market)) })
  }
  const out: Record<string, unknown> = { agentName: id.agentName }
  if (id.agentPhone.trim()) out.agentPhone = id.agentPhone.trim()
  const name = (n.neighborhood_name ?? n.city ?? "").trim()
  if (name) out.neighborhood = name
  // The tagline is the report's own AI summary sentence — the OS already wrote
  // and stored it against real data; the reel quotes it rather than re-drafting.
  const tag = String(n.ai_summary ?? "").split(/[.\n]/).map((s) => s.trim()).find((s) => s.length > 12 && s.length < 90)
  if (tag) out.tagline = tag
  if (highlights.length) out.highlights = highlights
  return out
}

export interface ReviewRow {
  review_text?: string | null
  reviewer_name?: string | null
  rating?: number | null
  created_at?: string | null
  kind?: string | null
}

/**
 * TestimonialReel.
 *
 * A fabricated endorsement is the one default in this library that is not just
 * wrong but a representation about a named agent to the public. Every field
 * here is the agent_reviews row's; nothing is inferred, including the rating.
 */
export function testimonialProps(r: ReviewRow, id: DirectorIdentity): Record<string, unknown> {
  const out: Record<string, unknown> = { agentName: id.agentName }
  const quote = String(r.review_text ?? "").trim()
  if (quote) out.quote = quote.slice(0, 320)
  const who = String(r.reviewer_name ?? "").trim()
  if (who) out.clientName = who
  // The review's own kind is the role; absent, we say "Client" — true of every
  // reviewer, and never the sample's specific "Buyer" claim.
  out.clientRole = r.kind === "buyer" || r.kind === "seller"
    ? r.kind.charAt(0).toUpperCase() + r.kind.slice(1)
    : "Client"
  if (r.created_at) {
    const d = new Date(r.created_at)
    if (!Number.isNaN(d.getTime())) {
      out.closingLabel = `Reviewed ${d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" })}`
    }
  }
  if (r.rating != null && Number(r.rating) > 0) out.stars = Math.round(Number(r.rating))
  return out
}

/**
 * EquityReportReel — THE proven case.
 *
 * equity-trigger computes all five numbers from a RentCast AVM plus the closed
 * transaction's basis price and passes them on situation.facts. This reads them
 * back with no arithmetic of its own: recomputing here would let this module and
 * the trigger disagree about a client's equity, which is a worse failure than
 * the one being fixed.
 */
export function equityProps(
  facts: Record<string, unknown>, address: string | null, id: DirectorIdentity,
): Record<string, unknown> {
  const out: Record<string, unknown> = { agentName: id.agentName }
  if (id.agentPhotoUrl) out.agentPhotoUrl = id.agentPhotoUrl
  if (address?.trim()) out.address = address.trim()
  for (const k of ["estimatedValue", "purchasePrice", "appreciation", "appreciationPct", "estimatedEquity", "yearsHeld"] as const) {
    const v = facts[k]
    if (typeof v === "number" && Number.isFinite(v)) out[k] = k === "appreciationPct" ? Math.round(v * 10) / 10 : Math.round(v)
  }
  out.brandColors = brandBlock(id)
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// THE RESOLVER — one situation, one composition, the reads it needs.
// ─────────────────────────────────────────────────────────────────────────────

export interface ResolveContentArgs {
  brokerageId: string
  agentUserId: string
  listingId?: string | null
  contactId?: string | null
  hookLine: string
  nowIso?: string
}

/** The agent + brokerage identity every composition footer names. */
export async function resolveDirectorIdentity(
  svc: AnyClient, brokerageId: string, agentUserId: string,
): Promise<DirectorIdentity> {
  let agentName = "", agentPhone = "", agentPhotoUrl: string | null = null
  try {
    const { data: u } = await svc.from("users").select("first_name, last_name, phone").eq("id", agentUserId).maybeSingle()
    const full = [u?.first_name, u?.last_name].filter(Boolean).join(" ").trim()
    if (full) agentName = full
    if (u?.phone) agentPhone = String(u.phone)
  } catch { /* the contract refuses on a blank agentName rather than guess one */ }
  try {
    const { data: a } = await svc.from("agents").select("photo_url, profile_image_url").eq("user_id", agentUserId).maybeSingle()
    agentPhotoUrl = a?.photo_url ?? a?.profile_image_url ?? null
  } catch { /* a photo is cosmetic */ }
  const { resolveReelBrand } = await import("./reel-brand")
  const brand = await resolveReelBrand(svc, brokerageId)
  return {
    agentName, agentPhone, agentPhotoUrl,
    brokerageName: brand.brokerageName,
    primaryColor: brand.primaryColor,
    accentColor: brand.accentColor,
    logoUrl: brand.logoUrl,
  }
}

/**
 * The content props for THIS commission, resolved from live rows.
 *
 * Returns whatever it could establish. Nothing here throws and nothing here
 * substitutes: an unresolvable fact is an absent key, and the caller runs it
 * through missingContentProps to decide whether the reel can honestly be made.
 */
export async function resolveDirectorContentProps(
  svc: AnyClient,
  situation: VideoSituation,
  compositionId: string,
  args: ResolveContentArgs,
): Promise<Record<string, unknown>> {
  const nowIso = args.nowIso ?? new Date().toISOString()
  const facts = (situation.facts ?? {}) as Record<string, unknown>
  const id = await resolveDirectorIdentity(svc, args.brokerageId, args.agentUserId)
  const base: Record<string, unknown> = { brand: brandBlock(id) }
  if (id.agentPhotoUrl) base.agentPhotoUrl = id.agentPhotoUrl

  const listing = args.listingId ? await readListing(svc, args.listingId) : null

  try {
    switch (compositionId) {
      case "JustListedReel":
      case "JustListedReelSquare":
      case "JustListedReelHorizontal":
        return listing ? { ...base, ...listingReelProps(listing, args.hookLine) } : base

      case "PhotoWalkthroughReel":
        return listing ? { ...base, ...listingReelProps(listing, args.hookLine) } : base

      case "JustSoldReelSquare":
        return listing ? { ...base, ...justSoldProps(listing, nowIso) } : base

      case "ComingSoonReel":
        return listing ? { ...base, ...comingSoonProps(listing, id) } : base

      case "OpenHouseAnnounceReel": {
        if (!args.listingId) return base
        const oh = await readOpenHouse(svc, args.listingId, nowIso)
        return oh ? { ...base, ...openHouseProps(oh, listing, id) } : base
      }

      case "MarketUpdateReel": {
        const md = await readMarketData(svc, args.brokerageId, listing, facts)
        return md ? { ...base, ...marketUpdateProps(md, id) } : base
      }

      case "NeighborhoodSpotlightReel": {
        const n = await readNeighborhood(svc, args.brokerageId, args.listingId ?? null)
        return n ? { ...base, ...neighborhoodProps(n, id) } : base
      }

      case "TestimonialReel": {
        const r = await readReview(svc, args.brokerageId, facts)
        return r ? { ...base, ...testimonialProps(r, id) } : base
      }

      case "EquityReportReel": {
        const address = (typeof facts.address === "string" && facts.address.trim())
          ? facts.address
          : listing?.address ?? await readClientAddress(svc, args.brokerageId, args.contactId ?? null)
        return { ...base, ...equityProps(facts, address, id) }
      }

      case "AgentExplainerReel":
      case "TeammateExplainerReel": {
        // AI-authored through the SAME compliance-gated author the Video Studio
        // uses — one drafting rail, not a second one that could drift from it.
        // A failed draft returns nothing and the contract refuses; there is no
        // canned fallback, because a canned explainer IS demo data.
        const topic = typeof facts.topic === "string" && facts.topic.trim()
          ? facts.topic.trim() : args.hookLine
        const { authorExplainerContent } = await import("./avatar-explainer")
        const authored = await authorExplainerContent({
          brokerageId: args.brokerageId, agentUserId: args.agentUserId,
          topic, audience: audienceFor(situation.kind),
          // The narration budget derives from the composition THIS case is
          // resolving — AgentExplainerReel (18s) and TeammateExplainerReel
          // (30s) speak different word counts, so the writer is told which.
          compositionId,
        })
        if (!authored.ok) return { ...base, agentName: id.agentName }
        return {
          ...base,
          agentName: id.agentName,
          eyebrow: authored.content.eyebrow,
          title: authored.content.title,
          bullets: authored.content.bullets,
          ctaLabel: authored.content.ctaLabel,
          captionScript: authored.content.narration,
        }
      }

      case "AgentTalkingHeadReel":
        return { ...base, agentName: id.agentName, hook: args.hookLine, caption: args.hookLine }

      default:
        // CMAReel, ExplainerAnimReel, the presentation slides and the print
        // stills all have dedicated producers that already resolve their own
        // data (cma-reel-orchestrator, explainer-diagram, section-render,
        // video-plays). The Director does not re-derive them badly — it stages
        // what it has and the contract refuses if that is not enough.
        return base
    }
  } catch {
    // A read failure must not fabricate. Returning the base leaves the content
    // props absent, which the contract turns into an explicit refusal.
    return base
  }
}

function audienceFor(kind: SituationKind): string {
  if (kind === "lead_intro") return "a new lead deciding whether to work with this agent"
  if (kind === "presentation") return "a homeowner considering listing"
  return "a client of this agent"
}

// ── reads ───────────────────────────────────────────────────────────────────

async function readListing(svc: AnyClient, listingId: string): Promise<ListingRow | null> {
  try {
    const { data } = await svc.from("listings")
      .select("address, city, state, list_price, sold_price, bedrooms, bathrooms, sqft, property_type, public_remarks, photos, primary_photo_url, listing_date, sold_date, go_live_date, lifecycle_stage")
      .eq("id", listingId).maybeSingle()
    return (data as ListingRow | null) ?? null
  } catch { return null }
}

/** The NEXT scheduled open house for this listing — never a past one. */
async function readOpenHouse(svc: AnyClient, listingId: string, nowIso: string): Promise<OpenHouseRow | null> {
  try {
    // open_house_events is the survivor; `open_houses` was a second spelling of it
    // and was retired by m543 (property_address merged onto this table there).
    const { data } = await svc.from("open_house_events")
      .select("property_address, description, event_date, start_time, end_time")
      .eq("listing_id", listingId)
      .gte("event_date", nowIso.slice(0, 10))
      .neq("status", "cancelled")
      .order("event_date", { ascending: true })
      .limit(1).maybeSingle()
    return (data as OpenHouseRow | null) ?? null
  } catch { return null }
}

/** The freshest market_data row for the listing's city, else the brokerage's. */
async function readMarketData(
  svc: AnyClient, brokerageId: string, listing: ListingRow | null, facts: Record<string, unknown>,
): Promise<MarketDataRow | null> {
  const city = (typeof facts.area_name === "string" && facts.area_name.trim())
    || (typeof facts.city === "string" && facts.city.trim())
    || listing?.city?.trim()
    || null
  try {
    let q = svc.from("market_data")
      .select("market_area, city, state, data_date, median_sale_price, avg_days_on_market, active_listings, price_trend_pct_30d, dom_trend")
      .eq("brokerage_id", brokerageId)
      .order("data_date", { ascending: false })
      .limit(1)
    if (city) q = q.ilike("city", city)
    const { data } = await q.maybeSingle()
    return (data as MarketDataRow | null) ?? null
  } catch { return null }
}

async function readNeighborhood(
  svc: AnyClient, brokerageId: string, listingId: string | null,
): Promise<NeighborhoodRow | null> {
  try {
    let q = svc.from("neighborhood_reports")
      .select("neighborhood_name, city, median_home_price, walk_score, avg_days_on_market, ai_summary")
      .eq("brokerage_id", brokerageId)
      .order("generated_at", { ascending: false })
      .limit(1)
    if (listingId) q = q.eq("listing_id", listingId)
    const { data } = await q.maybeSingle()
    return (data as NeighborhoodRow | null) ?? null
  } catch { return null }
}

/**
 * The review this reel is about.
 *
 * video-plays already passes the reviewId it selected, so the reel quotes THAT
 * review — falling back to "the newest published one" would mean the reel and
 * the commission that requested it could be about different reviews.
 */
async function readReview(
  svc: AnyClient, brokerageId: string, facts: Record<string, unknown>,
): Promise<ReviewRow | null> {
  const reviewId = typeof facts.reviewId === "string" ? facts.reviewId : null
  try {
    let q = svc.from("agent_reviews")
      .select("review_text, reviewer_name, rating, created_at, kind")
      .eq("brokerage_id", brokerageId).limit(1)
    if (reviewId) q = q.eq("id", reviewId)
    else q = q.eq("is_published", true).order("created_at", { ascending: false })
    const { data } = await q.maybeSingle()
    return (data as ReviewRow | null) ?? null
  } catch { return null }
}

/** The address of the home an equity report is about — the closed transaction's. */
async function readClientAddress(
  svc: AnyClient, brokerageId: string, contactId: string | null,
): Promise<string | null> {
  if (!contactId) return null
  try {
    const { data } = await svc.from("transactions")
      .select("property_address")
      .eq("brokerage_id", brokerageId).eq("status", "closed")
      .or(`buyer_contact_id.eq.${contactId},contact_id.eq.${contactId}`)
      .order("close_date", { ascending: false })
      .limit(1).maybeSingle()
    const addr = (data as { property_address?: string | null } | null)?.property_address
    return addr?.trim() || null
  } catch { return null }
}

// lib/lead-pipeline/social-sourcer.ts
// COLLECT layer for the social / forum / search sources, routed per the
// SOURCE_VENDOR contract (Apify owns Facebook / Instagram / Craigslist / Reddit /
// Google; ZenRows is reserved for the real-estate sites + Nextdoor). Each source
// has a pure normalizer (vendor post JSON -> canonical NormalizedScrapedRecord)
// so the intent-detection logic is unit-testable without the network, and a thin
// async wrapper that calls the real Apify client and returns viable records.
//
// Both-intent sources (Instagram, Google, Nextdoor) resolve buyer-vs-seller per
// post via detectIntent(); single-intent sources keep their source default.

import {
  scrapeRedditPosts,
  scrapeFacebookGroupPosts,
  scrapeInstagramPosts,
  scrapeCraigslistPosts,
  scrapeGoogleSearchResults,
  scrapeLinkedInPosts,
} from "@/lib/external/apify-client"
import { isViableRecord, type NormalizedScrapedRecord } from "./raw-record-types"
import { parseCraigslistHtml, buildRealtySiteChatterUrl, parseContactAgentChatter } from "./scraper-parsers"
import { buildAgentSeekingPhrases } from "./source-intent-map"

export interface SocialMarket {
  city: string | null
  state: string | null
}

const SELLER_TERMS = [
  "selling my", "sell my house", "sell my home", "fsbo", "for sale by owner",
  "listing my", "list my home", "thinking of selling", "need to sell", "downsizing",
]
const BUYER_TERMS = [
  "looking to buy", "house hunting", "first home", "first-time buyer", "pre-approved",
  "preapproved", "buying a house", "relocating to", "moving to", "house shopping",
]

/** Classify free-text social/search content into buyer / seller / unknown intent. */
export function detectIntent(text: string): "buyer" | "seller" | "unknown" {
  const t = (text ?? "").toLowerCase()
  const seller = SELLER_TERMS.some((s) => t.includes(s))
  const buyer = BUYER_TERMS.some((b) => t.includes(b))
  if (seller && !buyer) return "seller"
  if (buyer && !seller) return "buyer"
  return "unknown" // ambiguous or both — resolved later at enrichment
}

// Real-estate INVESTOR signals — investors are buyers acquiring income/flip
// property; tagged as buyer intent with an "investor" marker for routing.
const INVESTOR_TERMS = [
  "investment property", "rental property", "income property", "looking to invest",
  "1031 exchange", "cash buyer", "fix and flip", "fix-and-flip", "buy and hold",
  "rental portfolio", "cap rate", "cash flow property", "multifamily", "investor looking",
]

/** True if the text expresses real-estate INVESTOR (acquisition) intent. */
export function isInvestor(text: string): boolean {
  const t = (text ?? "").toLowerCase()
  return INVESTOR_TERMS.some((term) => t.includes(term))
}

function nameFromHandle(handle: unknown): { firstName: string | null; lastName: string | null } {
  const parts = String(handle ?? "").trim().split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return { firstName: parts[0], lastName: parts.slice(1).join(" ") }
  return { firstName: null, lastName: null }
}

// ─── Pure normalizers (testable) ──────────────────────────────────────────────

export function normalizeRedditPost(post: Record<string, any>, market: SocialMarket): NormalizedScrapedRecord {
  const text = `${post.title ?? ""} ${post.body ?? post.text ?? ""}`
  const intent = detectIntent(text)
  return {
    sourceRecordId: `reddit-${post.id ?? post.post_id ?? post.url ?? `${Date.now()}-${Math.random()}`}`,
    source: "reddit_intent",
    behaviorType: "social_intent",
    intentType: intent, // buyer ("looking to buy") OR seller ("selling my home"), per post
    intentSignals: [intent === "seller" ? "selling" : "looking_to_buy"],
    city: market.city,
    state: market.state,
    username: (post.author ?? post.username) ?? undefined,
    sourceUrl: post.url ?? null,
    motivationScore: 40,
    rawPayload: post,
  }
}

export function normalizeFacebookPost(post: Record<string, any>, market: SocialMarket): NormalizedScrapedRecord {
  const text = `${post.text ?? post.message ?? post.content ?? ""}`
  const intent = detectIntent(text)
  const { firstName, lastName } = nameFromHandle(post.authorName ?? post.user?.name)
  return {
    sourceRecordId: `fb-${post.postId ?? post.id ?? post.url ?? `${Date.now()}-${Math.random()}`}`,
    source: "facebook_group",
    behaviorType: "social_intent",
    intentType: intent, // buyer + seller both captured; classified per post
    intentSignals: [intent === "buyer" ? "looking_to_buy" : "selling"],
    firstName,
    lastName,
    city: market.city,
    state: market.state,
    sourceUrl: post.url ?? null,
    motivationScore: 38,
    rawPayload: post,
  }
}

export function normalizeInstagramPost(post: Record<string, any>, market: SocialMarket): NormalizedScrapedRecord {
  const text = `${post.caption ?? post.text ?? ""} ${(post.hashtags ?? []).join(" ")}`
  const { firstName, lastName } = nameFromHandle(post.ownerFullName ?? post.fullName)
  return {
    sourceRecordId: `ig-${post.id ?? post.shortCode ?? post.url ?? `${Date.now()}-${Math.random()}`}`,
    source: "instagram_intent",
    behaviorType: "social_intent",
    intentType: detectIntent(text), // both buyer + seller; resolved per caption
    intentSignals: [detectIntent(text) === "seller" ? "selling" : "house_hunting"],
    firstName,
    lastName,
    username: post.ownerUsername ?? post.username ?? undefined,
    city: market.city,
    state: market.state,
    sourceUrl: post.url ?? null,
    motivationScore: 36,
    rawPayload: post,
  }
}

const CL_WANTED = /\b(wanted|iso|in search of|looking (to|for)|need(ed)? to (buy|rent))\b/i

export function normalizeCraigslistItem(item: Record<string, any>, market: SocialMarket): NormalizedScrapedRecord {
  const title = `${item.title ?? item.name ?? ""}`
  const isFsbo = /\b(by owner|fsbo|for sale by owner)\b/i.test(title)
  // Housing-wanted / "ISO" posts are BUYER intent; for-sale-by-owner is SELLER.
  const isBuyer = CL_WANTED.test(title) || detectIntent(title) === "buyer"
  const intentType: "buyer" | "seller" = isBuyer ? "buyer" : "seller"
  return {
    sourceRecordId: `cl-${item.id ?? item.pid ?? item.url ?? `${Date.now()}-${Math.random()}`}`,
    source: "craigslist_fsbo",
    behaviorType: intentType === "buyer" ? "social_intent" : isFsbo ? "fsbo_listing" : "property_listing",
    intentType,
    intentSignals: intentType === "buyer" ? ["looking_to_buy"] : isFsbo ? ["fsbo", "by_owner"] : ["craigslist_listing"],
    // A buyer "wanted" post has no property to sell — don't store its title as a property address.
    propertyAddress: intentType === "seller" ? title.slice(0, 100) || null : null,
    // Craigslist posts carry an (often anonymized) reply email/handle — the viability
    // anchor for buyer "wanted" posts that have no address.
    email: item.email ?? item.contactEmail ?? item.replyEmail ?? undefined,
    username: item.author ?? item.posterId ?? undefined,
    city: market.city,
    state: market.state,
    sourceUrl: item.url ?? null,
    motivationScore: isFsbo ? 75 : 45,
    rawPayload: item,
  }
}

export function normalizeGoogleResult(result: Record<string, any>, market: SocialMarket): NormalizedScrapedRecord {
  const text = `${result.title ?? ""} ${result.description ?? result.snippet ?? ""}`
  return {
    sourceRecordId: `google-${Buffer.from(String(result.url ?? result.link ?? text)).toString("base64").slice(0, 40)}`,
    source: "google_phrase_intent",
    behaviorType: "search_signal",
    intentType: detectIntent(text), // searches span buyer ("homes for sale") + seller ("sell my house fast")
    intentSignals: [detectIntent(text) === "seller" ? "selling" : "search_intent"],
    city: market.city,
    state: market.state,
    sourceUrl: result.url ?? result.link ?? null,
    motivationScore: 38,
    rawPayload: result,
  }
}

// ─── Thin fetch wrappers (real Apify) ──────────────────────────────────────────

export async function sourceReddit(subreddits: string[], keywords: string[], market: SocialMarket): Promise<{ records: NormalizedScrapedRecord[]; cost: number }> {
  const r = await scrapeRedditPosts({ subreddits, keywords, limit: 50 }).catch(() => ({ posts: [], cost: 0 }))
  return { records: (r.posts ?? []).map((p) => normalizeRedditPost(p, market)).filter(isViableRecord), cost: r.cost ?? 0 }
}

export async function sourceFacebook(groupUrl: string, keywords: string[], market: SocialMarket): Promise<{ records: NormalizedScrapedRecord[]; cost: number }> {
  const r = await scrapeFacebookGroupPosts({ groupUrl, keywords, limit: 100 }).catch(() => ({ posts: [], cost: 0 }))
  return { records: (r.posts ?? []).map((p) => normalizeFacebookPost(p, market)).filter(isViableRecord), cost: r.cost ?? 0 }
}

export async function sourceInstagram(hashtags: string[], market: SocialMarket): Promise<{ records: NormalizedScrapedRecord[]; cost: number }> {
  const r = await scrapeInstagramPosts({ hashtags, limit: 100 }).catch(() => ({ posts: [], cost: 0 }))
  return { records: (r.posts ?? []).map((p) => normalizeInstagramPost(p, market)).filter(isViableRecord), cost: r.cost ?? 0 }
}

// ── Craigslist Apify-lane HTML fallback ───────────────────────────────────────
// Apify (lukaskrivka/craigslist-scraper via scrapeCraigslistPosts) is the PRIMARY
// collector (SOURCE_VENDOR contract above). When the actor errors OR returns zero
// items (actor down, selector drift, rate-limited), this falls back to fetching the
// same Craigslist search page's raw HTML through ZenRows and parsing it with the
// pure cheerio parser (scraper-parsers.ts::parseCraigslistHtml) — a distinct
// collection PATH for the SAME Craigslist capability, not a second source (owner
// ruling: keep each source distinct, but a fallback path for one source is not a
// second source). Never runs when Apify already produced records — no double spend.
function craigslistSearchUrl(city: string, query: string, section: string): string {
  return `https://${city.toLowerCase().replace(/ /g, "")}.craigslist.org/search/${section}?query=${encodeURIComponent(query)}`
}

async function craigslistHtmlFallback(
  city: string, query: string, section: "rea" | "hhh", market: SocialMarket,
): Promise<{ records: NormalizedScrapedRecord[]; cost: number }> {
  try {
    const { scrapeWithZenRows } = await import("@/lib/external/zenrows-client")
    const res = await scrapeWithZenRows(craigslistSearchUrl(city, query, section), { premiumProxy: true })
    const parsed = parseCraigslistHtml(res.body)
    // parseCraigslistHtml hardcodes seller intent (it parses the 'rea'/for-sale shape);
    // the 'hhh' housing-wanted section is buyer/ISO intent — remap here, same rule
    // normalizeCraigslistItem applies to the Apify path, so both paths agree.
    const records = section === "hhh"
      ? parsed.map((r) => ({
          ...r, intentType: "buyer" as const, behaviorType: "social_intent",
          intentSignals: ["looking_to_buy"], propertyAddress: null,
          city: market.city, state: market.state,
        }))
      : parsed.map((r) => ({ ...r, city: market.city, state: market.state }))
    return { records: records.filter(isViableRecord), cost: res.cost ?? 0 }
  } catch (e) {
    console.warn("[social-sourcer] craigslist HTML fallback failed:", e instanceof Error ? e.message : e)
    return { records: [], cost: 0 }
  }
}

export async function sourceCraigslist(city: string, query: string, market: SocialMarket): Promise<{ records: NormalizedScrapedRecord[]; cost: number }> {
  const r = await scrapeCraigslistPosts({ city, query, limit: 100, section: "rea" }).catch(() => ({ posts: [], cost: 0 }))
  const records = (r.posts ?? []).map((p) => normalizeCraigslistItem(p, market)).filter(isViableRecord)
  if (records.length > 0) return { records, cost: r.cost ?? 0 }
  const fallback = await craigslistHtmlFallback(city, query, "rea", market)
  return { records: fallback.records, cost: (r.cost ?? 0) + fallback.cost }
}

/** Craigslist housing section — surfaces buyer "wanted"/ISO posts (buyer intent). */
export async function sourceCraigslistWanted(city: string, market: SocialMarket): Promise<{ records: NormalizedScrapedRecord[]; cost: number }> {
  const wantedQuery = "wanted to buy ISO looking to buy home"
  const r = await scrapeCraigslistPosts({ city, query: wantedQuery, limit: 100, section: "hhh" }).catch(() => ({ posts: [], cost: 0 }))
  // normalizeCraigslistItem classifies "wanted"/ISO titles as buyer intent.
  const records = (r.posts ?? []).map((p) => normalizeCraigslistItem(p, market)).filter(isViableRecord)
  if (records.length > 0) return { records, cost: r.cost ?? 0 }
  const fallback = await craigslistHtmlFallback(city, wantedQuery, "hhh", market)
  return { records: fallback.records, cost: (r.cost ?? 0) + fallback.cost }
}

export async function sourceGoogle(queries: string[], market: SocialMarket): Promise<{ records: NormalizedScrapedRecord[]; cost: number }> {
  const r = await scrapeGoogleSearchResults({ queries, resultsPerQuery: 10 }).catch(() => ({ results: [], cost: 0 }))
  return { records: (r.results ?? []).map((x) => normalizeGoogleResult(x, market)).filter(isViableRecord), cost: r.cost ?? 0 }
}

// ── Rental listings (Craigslist apartments) → landlord/investor SELLER ───────

export function normalizeRentalListing(item: Record<string, any>, market: SocialMarket): NormalizedScrapedRecord {
  const title = `${item.title ?? item.name ?? ""}`
  const byOwner = /\b(by owner|owner|private landlord)\b/i.test(title) && !/\b(property management|realty|broker|agent)\b/i.test(title)
  return {
    sourceRecordId: `rental-${item.id ?? item.pid ?? item.url ?? `${Date.now()}-${Math.random()}`}`,
    source: "rental_listing",
    behaviorType: "rental_listing",
    intentType: "seller", // landlords listing rentals are prospective sellers of the asset
    intentSignals: byOwner ? ["by_owner", "tired_landlord"] : ["rental_listing"],
    propertyAddress: title.slice(0, 100) || null,
    email: item.email ?? item.contactEmail ?? item.replyEmail ?? undefined,
    username: item.author ?? item.posterId ?? undefined,
    city: market.city,
    state: market.state,
    sourceUrl: item.url ?? null,
    motivationScore: byOwner ? 50 : 40,
    rawPayload: item,
  }
}

export async function sourceRentalListings(city: string, market: SocialMarket): Promise<{ records: NormalizedScrapedRecord[]; cost: number }> {
  // Craigslist 'apa' = apartments / housing for rent (landlord-posted).
  const r = await scrapeCraigslistPosts({ city, query: "house for rent by owner", limit: 100, section: "apa" }).catch(() => ({ posts: [], cost: 0 }))
  return { records: (r.posts ?? []).map((p) => normalizeRentalListing(p, market)).filter(isViableRecord), cost: r.cost ?? 0 }
}

// ── LinkedIn relocation posts → inbound BUYER ────────────────────────────────

export function normalizeLinkedInPost(post: Record<string, any>, market: SocialMarket): NormalizedScrapedRecord {
  const text = `${post.text ?? post.content ?? post.commentary ?? ""}`
  const { firstName, lastName } = nameFromHandle(post.authorName ?? post.author?.name ?? post.fullName)
  return {
    sourceRecordId: `li-${post.id ?? post.urn ?? post.url ?? `${Date.now()}-${Math.random()}`}`,
    source: "linkedin_relocation",
    behaviorType: "social_intent",
    intentType: "buyer", // relocation posts are inbound-buyer signals
    intentSignals: ["relocating", "new_job"],
    firstName,
    lastName,
    username: post.authorHeadline ? undefined : (post.authorPublicId ?? post.username ?? undefined),
    city: market.city,
    state: market.state,
    sourceUrl: post.url ?? null,
    motivationScore: 52,
    rawPayload: post,
  }
}

export async function sourceLinkedInRelocation(market: SocialMarket): Promise<{ records: NormalizedScrapedRecord[]; cost: number }> {
  const where = [market.city, market.state].filter(Boolean).join(" ")
  // Territory honesty: no territory geography → no scrape (never a global sweep).
  if (!where) return { records: [], cost: 0 }
  const r = await scrapeLinkedInPosts({
    keywords: ["excited to announce", "starting a new role", "relocating to", "moving to"].map((k) => `${k} ${where}`.trim()),
    location: where || undefined,
    limit: 50,
  }).catch(() => ({ posts: [], cost: 0 }))
  return { records: (r.posts ?? []).map((p) => normalizeLinkedInPost(p, market)).filter(isViableRecord), cost: r.cost ?? 0 }
}

// ═══════════════════════════════════════════════════════════════════════════════
// WAVE 65 LANES (owner ruling 2026-09-15) — each is a DISTINCT capability with its
// own territory-centric query builder + normalizer + sourceChannel. Never merged
// with the look-alike lanes above (facebook_group / reddit_intent / google_phrase_intent).
// ═══════════════════════════════════════════════════════════════════════════════

// ── Reddit relocation lane — "moving to <city>" / "looking for a realtor in <city>" ─────────

export function normalizeRedditRelocationPost(post: Record<string, any>, market: SocialMarket): NormalizedScrapedRecord {
  const text = `${post.title ?? ""} ${post.body ?? post.text ?? post.selftext ?? ""}`
  return {
    sourceRecordId: `reddit-reloc-${post.id ?? post.post_id ?? post.url ?? `${Date.now()}-${Math.random()}`}`,
    source: "reddit_relocation",
    behaviorType: "social_intent",
    intentType: "buyer", // relocation / "need a realtor" posts are inbound-buyer signals
    intentSignals: ["relocating", "looking_for_realtor"],
    city: market.city,
    state: market.state,
    username: (post.author ?? post.username) ?? undefined,
    sourceUrl: post.url ?? post.permalink ?? null,
    motivationScore: 54,
    rawPayload: post,
  }
}

/** Territory-centric relocation query — fixed phrase set, independent of configured keywords. */
export async function sourceRedditRelocation(market: SocialMarket): Promise<{ records: NormalizedScrapedRecord[]; cost: number }> {
  const where = [market.city, market.state].filter(Boolean).join(", ")
  if (!where) return { records: [], cost: 0 }
  const { phrases } = buildAgentSeekingPhrases(market)
  const keywords = [
    `moving to ${market.city ?? where}`,
    `relocating to ${market.city ?? where}`,
    ...phrases.slice(0, 2),
  ]
  // General relocation subreddits + a city-named community when one plausibly exists.
  const subreddits = ["moving", "relocating", "IWantOut", market.city ? `${market.city.toLowerCase().replace(/\s+/g, "")}` : undefined].filter(Boolean) as string[]
  const r = await scrapeRedditPosts({ subreddits, keywords, limit: 50 }).catch(() => ({ posts: [], cost: 0 }))
  return { records: (r.posts ?? []).map((p) => normalizeRedditRelocationPost(p, market)).filter(isViableRecord), cost: r.cost ?? 0 }
}

// ── Facebook "recommend a realtor" lane ───────────────────────────────────────────────────

export function normalizeFacebookRecommendRealtorPost(post: Record<string, any>, market: SocialMarket): NormalizedScrapedRecord {
  const { firstName, lastName } = nameFromHandle(post.authorName ?? post.user?.name)
  return {
    sourceRecordId: `fb-recrealtor-${post.postId ?? post.id ?? post.url ?? `${Date.now()}-${Math.random()}`}`,
    source: "facebook_recommend_realtor",
    behaviorType: "social_intent",
    intentType: "unknown", // a "recommend a realtor" thread may resolve buyer or seller at enrichment
    intentSignals: ["recommend_a_realtor", "agent_referral_request"],
    firstName,
    lastName,
    city: market.city,
    state: market.state,
    sourceUrl: post.url ?? null,
    motivationScore: 50,
    rawPayload: post,
  }
}

/** Territory-centric "recommend a realtor" query against the market's local FB groups. */
export async function sourceFacebookRecommendRealtor(
  groupUrls: string[], market: SocialMarket,
): Promise<{ records: NormalizedScrapedRecord[]; cost: number }> {
  if (groupUrls.length === 0) return { records: [], cost: 0 }
  const keywords = ["recommend a realtor", "need an agent", "looking for a realtor", "recommend a real estate agent"]
  const all: NormalizedScrapedRecord[] = []
  let cost = 0
  for (const groupUrl of groupUrls) {
    const r = await scrapeFacebookGroupPosts({ groupUrl, keywords, limit: 50 }).catch(() => ({ posts: [], cost: 0 }))
    cost += r.cost ?? 0
    all.push(...(r.posts ?? []).map((p) => normalizeFacebookRecommendRealtorPost(p, market)).filter(isViableRecord))
  }
  return { records: all, cost }
}

// ── Agent-seeking phrase intent — cross-source (Google/Apify today) ──────────────────────────

export function normalizeAgentSeekingResult(result: Record<string, any>, market: SocialMarket): NormalizedScrapedRecord {
  return {
    sourceRecordId: `agent-seeking-${Buffer.from(String(result.url ?? result.link ?? result.title ?? Date.now())).toString("base64").slice(0, 40)}`,
    source: "agent_seeking_phrase_intent",
    behaviorType: "search_signal",
    intentType: "unknown",
    intentSignals: ["agent_referral_request", "looking_for_realtor"],
    city: market.city,
    state: market.state,
    sourceUrl: result.url ?? result.link ?? null,
    motivationScore: 42,
    rawPayload: result,
  }
}

/** "Looking for a real estate agent/realtor" phrase intent — territory-centric, cross-source. */
export async function sourceAgentSeekingPhraseIntent(market: SocialMarket): Promise<{ records: NormalizedScrapedRecord[]; cost: number }> {
  const { phrases } = buildAgentSeekingPhrases(market)
  if (phrases.length === 0) return { records: [], cost: 0 }
  const r = await scrapeGoogleSearchResults({ queries: phrases.slice(0, 5), resultsPerQuery: 10 }).catch(() => ({ results: [], cost: 0 }))
  return { records: (r.results ?? []).map((x) => normalizeAgentSeekingResult(x, market)).filter(isViableRecord), cost: r.cost ?? 0 }
}

// ── Zillow/Realtor/Homes.com saved-search + "contact agent" chatter (ZenRows/Zyte) ──────────
// DISTINCT from the zillow_behavior FSBO/saved-search block in the cron (which parses per-listing
// cards). This targets the general market page's saved-search + contact-agent CTA chatter, with
// Homes.com as NEW coverage — reuses the SAME parseBuyerSavedSearches signal plus the new
// parseContactAgentChatter DOM reader, over whichever provider is configured (ZenRows primary,
// Zyte fallback — lib/external/zenrows-client.ts::scrapeSiteWithBestProvider).
export async function sourceRealtySiteChatter(
  site: "zillow" | "realtor" | "homes", market: { city: string; state: string },
): Promise<{ records: NormalizedScrapedRecord[]; cost: number; provider: "zenrows" | "zyte" | null }> {
  if (!market.city || !market.state) return { records: [], cost: 0, provider: null }
  const { scrapeSiteWithBestProvider } = await import("@/lib/external/zenrows-client")
  const url = buildRealtySiteChatterUrl(site, market)
  const res = await scrapeSiteWithBestProvider(url, { jsRender: true, premiumProxy: true }).catch(
    () => ({ ok: false, html: "", provider: null as "zenrows" | "zyte" | null, cost: 0, error: "scrape threw" }),
  )
  if (!res.ok || !res.html) return { records: [], cost: res.cost ?? 0, provider: res.provider }

  const { parseBuyerSavedSearches } = await import("./scraper-parsers")
  const savedSearch = parseBuyerSavedSearches(res.html, site, market)
  const contactAgent = parseContactAgentChatter(res.html, site, market)
  return { records: [...savedSearch, ...contactAgent], cost: res.cost, provider: res.provider }
}

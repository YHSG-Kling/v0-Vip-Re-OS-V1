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
} from "@/lib/external/apify-client"
import { isViableRecord, type NormalizedScrapedRecord } from "./raw-record-types"

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

function nameFromHandle(handle: unknown): { firstName: string | null; lastName: string | null } {
  const parts = String(handle ?? "").trim().split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return { firstName: parts[0], lastName: parts.slice(1).join(" ") }
  return { firstName: null, lastName: null }
}

// ─── Pure normalizers (testable) ──────────────────────────────────────────────

export function normalizeRedditPost(post: Record<string, any>, market: SocialMarket): NormalizedScrapedRecord {
  const text = `${post.title ?? ""} ${post.body ?? post.text ?? ""}`
  return {
    sourceRecordId: `reddit-${post.id ?? post.post_id ?? post.url ?? `${Date.now()}-${Math.random()}`}`,
    source: "reddit_intent",
    behaviorType: "social_intent",
    intentType: "buyer", // reddit r/realestate skews buyer research; default per source map
    intentSignals: [detectIntent(text) === "seller" ? "selling" : "looking_to_buy"],
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
    intentType: intent === "unknown" ? "seller" : intent, // groups skew seller
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

export function normalizeCraigslistItem(item: Record<string, any>, market: SocialMarket): NormalizedScrapedRecord {
  const title = `${item.title ?? item.name ?? ""}`
  const isFsbo = /\b(by owner|fsbo|for sale by owner)\b/i.test(title)
  return {
    sourceRecordId: `cl-${item.id ?? item.pid ?? item.url ?? `${Date.now()}-${Math.random()}`}`,
    source: "craigslist_fsbo",
    behaviorType: isFsbo ? "fsbo_listing" : "property_listing",
    intentType: "seller",
    intentSignals: isFsbo ? ["fsbo", "by_owner"] : ["craigslist_listing"],
    propertyAddress: title.slice(0, 100) || null,
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

export async function sourceCraigslist(city: string, query: string, market: SocialMarket): Promise<{ records: NormalizedScrapedRecord[]; cost: number }> {
  const r = await scrapeCraigslistPosts({ city, query, limit: 100 }).catch(() => ({ posts: [], cost: 0 }))
  return { records: (r.posts ?? []).map((p) => normalizeCraigslistItem(p, market)).filter(isViableRecord), cost: r.cost ?? 0 }
}

export async function sourceGoogle(queries: string[], market: SocialMarket): Promise<{ records: NormalizedScrapedRecord[]; cost: number }> {
  const r = await scrapeGoogleSearchResults({ queries, resultsPerQuery: 10 }).catch(() => ({ results: [], cost: 0 }))
  return { records: (r.results ?? []).map((x) => normalizeGoogleResult(x, market)).filter(isViableRecord), cost: r.cost ?? 0 }
}

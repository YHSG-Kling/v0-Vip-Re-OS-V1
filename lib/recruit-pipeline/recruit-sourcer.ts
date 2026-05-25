// lib/recruit-pipeline/recruit-sourcer.ts
// Sources platform-owned raw recruiting prospects (agents/teams looking to
// switch brokerages) into raw_recruit_prospects. Two signal families, per the
// chosen strategy:
//   1. Social/forum intent — agent communities (e.g. Reddit r/realtors) where
//      agents express dissatisfaction or intent to switch, via Apify/ZenRows.
//   2. Job-board / brokerage-review intent — negative or "leaving" signals in
//      public brokerage reviews (Glassdoor/Indeed style), via ZenRows.
//
// Records are PLATFORM-OWNED: brokerage_id is left NULL and only market_id (the
// active-subscriber territory) is set. The owning brokerage is resolved at
// promotion (lib/recruit-pipeline/recruit-processor.ts) from the market's state.
//
// Identity is frequently partial in these public sources; the recruit promotion
// gate (full name + email-or-current-brokerage) filters non-viable signals, so
// this stage captures broadly and lets the gate decide.

import type { SupabaseClient } from "@supabase/supabase-js"
import { ZenrowsClient } from "@/lib/external"

const SWITCH_INTENT_TERMS = [
  "thinking of switching brokerage",
  "leaving my brokerage",
  "best brokerage to switch to",
  "unhappy with my broker",
  "low commission split",
  "switching brokerages",
  "new brokerage recommendations",
]

export interface RecruitSourceParams {
  supabase: SupabaseClient
  marketId: string
  /** Market state used for license-territory matching at promotion. */
  state: string | null
  /** Agent-focused subreddits to scan for switch intent. */
  subreddits?: string[]
  /** Public brokerage-review URLs to scan for "leaving" signals. */
  reviewUrls?: string[]
}

export interface RecruitSourceResult {
  inserted: number
  scanned: number
  errors: string[]
}

async function insertRawRecruit(
  supabase: SupabaseClient,
  row: {
    marketId: string
    source: string
    sourceRecordId: string
    rawData: Record<string, unknown>
    preview: Record<string, unknown>
  },
): Promise<boolean> {
  const { error } = await supabase.from("raw_recruit_prospects").insert({
    // Platform-owned: no brokerage_id until promotion. market_id carries the
    // active-subscriber territory this prospect was sourced for.
    brokerage_id: null,
    market_id: row.marketId,
    source: row.source,
    source_record_id: row.sourceRecordId,
    raw_data: row.rawData,
    normalized_preview: row.preview,
    processing_status: "pending",
  })
  // 23505 = unique_violation on (source, source_record_id) — already captured.
  if (error?.code === "23505") return false
  if (error) return false
  return true
}

export async function sourceRecruitProspects(params: RecruitSourceParams): Promise<RecruitSourceResult> {
  const result: RecruitSourceResult = { inserted: 0, scanned: 0, errors: [] }
  const zenrows = new ZenrowsClient()

  // ── 1. Social/forum agent-switch intent (Reddit agent communities) ─────────
  const subreddits = params.subreddits?.length ? params.subreddits : ["realtors", "RealEstate"]
  try {
    const { scrapeRedditPosts } = await import("@/lib/external/apify-client")
    const reddit = await scrapeRedditPosts({
      subreddits,
      keywords: SWITCH_INTENT_TERMS,
      limit: 50,
    }).catch(() => ({ posts: [] as Array<Record<string, any>> }))

    for (const post of reddit.posts ?? []) {
      result.scanned++
      const text = `${post.title ?? ""} ${post.body ?? ""}`.toLowerCase()
      const matched = SWITCH_INTENT_TERMS.find((t) => text.includes(t))
      if (!matched) continue
      const author = (post.author ?? post.username ?? "").toString().trim()
      const ok = await insertRawRecruit(params.supabase, {
        marketId: params.marketId,
        source: "reddit_agent_switch",
        sourceRecordId: `reddit-recruit-${post.post_id ?? post.url ?? `${Date.now()}-${Math.random()}`}`,
        rawData: { post, matched_term: matched },
        preview: {
          // Reddit handles are usually pseudonymous — name/email rarely present,
          // so most of these are filtered by the promotion identity gate.
          firstName: null,
          lastName: null,
          state: params.state,
          currentBrokerage: null,
          switchSignal: matched,
          handle: author || null,
          sourceUrl: post.url ?? null,
        },
      })
      if (ok) result.inserted++
    }
  } catch (err) {
    result.errors.push(`reddit_agent_switch: ${err instanceof Error ? err.message : String(err)}`)
  }

  // ── 2. Job-board / brokerage-review "leaving" signals ──────────────────────
  for (const url of params.reviewUrls ?? []) {
    try {
      const scraped = await zenrows.scrape(url, { js_render: true }).catch(() => null)
      result.scanned++
      if (!scraped?.success || !scraped.html) continue
      const html = scraped.html.toLowerCase()
      const matched = SWITCH_INTENT_TERMS.find((t) => html.includes(t)) ?? "brokerage_review_signal"
      const ok = await insertRawRecruit(params.supabase, {
        marketId: params.marketId,
        source: "brokerage_review_signal",
        sourceRecordId: `review-${Buffer.from(url).toString("base64").slice(0, 40)}`,
        rawData: { url, matched_term: matched },
        preview: {
          firstName: null,
          lastName: null,
          state: params.state,
          currentBrokerage: null,
          switchSignal: matched,
          sourceUrl: url,
        },
      })
      if (ok) result.inserted++
    } catch (err) {
      result.errors.push(`brokerage_review_signal: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return result
}

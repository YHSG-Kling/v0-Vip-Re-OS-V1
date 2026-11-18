/**
 * app/api/cron/content-intel-rss/route.ts
 *
 * Wave 17 — RSS industry-news ingest. Daily 07:00 UTC.
 *
 * Iterates active content_topic_sources rows of source_type='rss', fetches
 * the feed via fetchRssFeed(), files each item through THE ONE topic
 * intake (lib/content-intel/topic-intake.ts — wave 154, lane 154G1).
 *
 * Auth: CRON_SECRET.
 */
import { NextResponse, type NextRequest } from "next/server"
import { verifyCronAuth } from "@/lib/cron-auth"
import { createServiceClient } from "@/lib/supabase/service"
import { fetchRssFeed } from "@/lib/content-intel/rss-scraper"
import { intakeTopicIdeas } from "@/lib/content-intel/topic-intake"

export const dynamic = "force-dynamic"
export const maxDuration = 300
export const runtime = "nodejs"

interface SourceRow {
  id:            string
  // local_intel: a local-intelligence feed (wave 144G) — owned by lib/content-intel/local-intel.ts, skipped here
  source_config: { feed_url?: string; source_trust?: number; local_intel?: unknown }
  brokerage_id:  string | null
  label:         string | null
}

export async function GET(req: NextRequest) {
  const denied = verifyCronAuth(req)
  if (denied) return denied

  const svc = createServiceClient()
  const { data: sources, error } = await svc.from("content_topic_sources")
    .select("id, source_config, brokerage_id, label")
    .eq("source_type", "rss")
    .eq("is_active", true)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const results: Array<{ source_id: string; feed: string; fetched: number; inserted: number; updated: number }> = []

  for (const s of (sources ?? []) as SourceRow[]) {
    // A local-intelligence feed is NOT also a generic topic (wave 144 — lane 144G Outside-lane 6): ingesting it here too would
    // ping-pong categories / raw_data with the local pass on an RSS-format feed.
    if (s.source_config?.local_intel) continue // lib/content-intel/local-intel.ts owns it
    const feedUrl = s.source_config?.feed_url
    if (!feedUrl) continue
    let fetched = 0, inserted = 0, updated = 0
    try {
      const items = await fetchRssFeed({
        feedUrl,
        sourceTrust: s.source_config?.source_trust ?? 70,
      })
      fetched = items.length
      // THROUGH THE ONE INTAKE (wave 154, lane 154G1 — this route inserted directly and stored the feed's summary verbatim
      // as the angle at the batch-2 base). Stored now: the credited headline, link and date (rights public_citation). The
      // feed score is the source's configured trust + an item-age adjustment (rss-scraper.ts parseRssXml) — a labeled proxy
      // for source quality and freshness, never audience demand.
      const now = new Date()
      const r = await intakeTopicIdeas(svc, {
        brokerageId: s.brokerage_id, now,
        ideas: items.map((it) => ({
          sourceKind: "news_article", sourceId: s.id, title: it.title,
          angle: "Explain what this means for local buyers and sellers in ORIGINAL words; credit and link the source — never copy it.",
          categories: it.categories, sourceUrl: it.link, publishedAt: it.published_date, observedAt: now.toISOString(),
          evidence: { kind: "proxy" as const, metric: "feed_trust_plus_freshness", value: it.engagement_score, unit: "score_0_100", note: "configured source trust adjusted by item age — not engagement, not demand" },
          rights: "public_citation" as const,
          brief: { transport: "rss", feed_url: feedUrl },
        })),
      })
      inserted = r.inserted
      updated = r.merged
      if (!r.ok) console.error(`[content-intel-rss] "${feedUrl}" intake: ${r.refused ?? r.errors.slice(0, 3).join("; ")}`)
      const { error: lastRunErr } = await svc.from("content_topic_sources").update({ last_run_at: now.toISOString() }).eq("id", s.id).select("id")
      if (lastRunErr) console.error(`[content-intel-rss] last_run_at not recorded for ${s.id}: ${lastRunErr.message}`)
    } catch (e) {
      console.error(`[content-intel-rss] "${feedUrl}" failed:`, (e as Error).message)
    }
    results.push({ source_id: s.id, feed: feedUrl, fetched, inserted, updated })
  }

  return NextResponse.json({
    ran_at: new Date().toISOString(),
    sources_processed: results.length,
    results,
  })
}

/**
 * app/api/cron/content-intel-rss/route.ts
 *
 * Wave 17 — RSS industry-news ingest. Daily 07:00 UTC.
 *
 * Iterates active content_topic_sources rows of source_type='rss', fetches
 * the feed via fetchRssFeed(), upserts each item into content_topic_bank
 * keyed on the item's link URL.
 *
 * Auth: CRON_SECRET.
 */
import { NextResponse, type NextRequest } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { fetchRssFeed } from "@/lib/content-intel/rss-scraper"

export const dynamic = "force-dynamic"
export const maxDuration = 300
export const runtime = "nodejs"

interface SourceRow {
  id:            string
  source_config: { feed_url?: string; source_trust?: number }
  brokerage_id:  string | null
  label:         string | null
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization")?.replace("Bearer ", "")
  const qs   = new URL(req.url).searchParams.get("secret")
  const expected = process.env.CRON_SECRET
  if (!expected) return NextResponse.json({ skipped: "CRON_SECRET not configured" })
  if (auth !== expected && qs !== expected) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const svc = createServiceClient()
  const { data: sources, error } = await svc.from("content_topic_sources")
    .select("id, source_config, brokerage_id, label")
    .eq("source_type", "rss")
    .eq("is_active", true)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const results: Array<{ source_id: string; feed: string; fetched: number; inserted: number; updated: number }> = []

  for (const s of (sources ?? []) as SourceRow[]) {
    const feedUrl = s.source_config?.feed_url
    if (!feedUrl) continue
    let fetched = 0, inserted = 0, updated = 0
    try {
      const items = await fetchRssFeed({
        feedUrl,
        sourceTrust: s.source_config?.source_trust ?? 70,
      })
      fetched = items.length
      for (const it of items) {
        const existing = await svc.from("content_topic_bank")
          .select("id")
          .eq("source_id", s.id)
          .eq("source_url", it.link)
          .maybeSingle()
        const row = {
          source_id:        s.id,
          brokerage_id:     s.brokerage_id,
          topic_title:      it.title,
          value_angle:      it.summary.slice(0, 300),
          source_url:       it.link,
          raw_data: {
            summary:        it.summary,
            published_date: it.published_date,
          },
          engagement_score: it.engagement_score,
          categories:       it.categories,
          topic_posted_at:  it.published_date,
          scraped_at:       new Date().toISOString(),
          expires_at:       new Date(Date.now() + 21 * 86_400_000).toISOString(),
        }
        if (existing.data) {
          await svc.from("content_topic_bank")
            .update({
              engagement_score: row.engagement_score,
              raw_data:         row.raw_data,
              scraped_at:       row.scraped_at,
              categories:       row.categories,
              value_angle:      row.value_angle,
            })
            .eq("id", (existing.data as { id: string }).id)
          updated++
        } else {
          const ins = await svc.from("content_topic_bank").insert(row)
          if (!ins.error) inserted++
        }
      }
      await svc.from("content_topic_sources").update({ last_run_at: new Date().toISOString() }).eq("id", s.id)
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

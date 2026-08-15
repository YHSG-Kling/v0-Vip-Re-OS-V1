/**
 * app/api/cron/content-intel-reddit/route.ts
 *
 * Wave 16 — daily Reddit content-intelligence scrape. Iterates every active
 * content_topic_sources row of source_type='reddit' and refreshes the
 * content_topic_bank with the week's top threads.
 *
 * Daily 06:00 UTC — fresh signal hits the bank before the podcast-weekly-auto
 * cron runs Wednesday + the newsletter-video-render cron runs every 5 min.
 *
 * Auth: CRON_SECRET.
 */
import { NextResponse, type NextRequest } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { fetchTopThreads, type RedditWindow } from "@/lib/content-intel/reddit-scraper"

export const dynamic = "force-dynamic"
export const maxDuration = 300
export const runtime = "nodejs"

interface SourceRow {
  id:            string
  source_config: { subreddit?: string; window?: RedditWindow }
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
  const { data: sources, error } = await svc
    .from("content_topic_sources")
    .select("id, source_config, brokerage_id, label")
    .eq("source_type", "reddit")
    .eq("is_active", true)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const results: Array<{ source_id: string; subreddit: string; fetched: number; inserted: number; updated: number }> = []

  for (const s of (sources ?? []) as SourceRow[]) {
    const sub = s.source_config?.subreddit ?? null
    const win: RedditWindow = (s.source_config?.window as RedditWindow) ?? "week"
    if (!sub) continue

    let fetched = 0, inserted = 0, updated = 0
    try {
      const threads = await fetchTopThreads({ subreddit: sub, window: win, limit: 25 })
      fetched = threads.length
      for (const t of threads) {
        // Upsert by (source_id, source_url) — the unique index handles
        // dedup; an existing row gets its score + raw_data refreshed.
        const existing = await svc.from("content_topic_bank")
          .select("id, status")
          .eq("source_id", s.id)
          .eq("source_url", t.permalink)
          .maybeSingle()

        const row = {
          source_id:        s.id,
          brokerage_id:     s.brokerage_id,
          topic_title:      t.title,
          value_angle:      null,
          source_url:       t.permalink,
          raw_data: {
            subreddit:  t.subreddit,
            upvotes:    t.upvotes,
            comments:   t.comments,
            url:        t.url,
            selftext:   t.selftext,
          },
          engagement_score: t.engagement_score,
          categories:       t.categories,
          topic_posted_at:  new Date(t.created_utc * 1000).toISOString(),
          scraped_at:       new Date().toISOString(),
          expires_at:       new Date(Date.now() + 21 * 86_400_000).toISOString(),
        }

        if (existing.data) {
          // Refresh score + raw_data; preserve current status (so an
          // already-used topic stays used).
          await svc.from("content_topic_bank")
            .update({
              engagement_score: row.engagement_score,
              raw_data:         row.raw_data,
              scraped_at:       row.scraped_at,
              categories:       row.categories,
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
      console.error(`[content-intel-reddit] ${sub} failed:`, (e as Error).message)
    }

    results.push({ source_id: s.id, subreddit: sub, fetched, inserted, updated })
  }

  // Stale sweep — flip topics past expires_at to 'stale' so the picker stops returning them.
  await svc.from("content_topic_bank")
    .update({ status: "stale" })
    .eq("status", "fresh")
    .lt("expires_at", new Date().toISOString())

  return NextResponse.json({
    ran_at: new Date().toISOString(),
    sources_processed: results.length,
    results,
  })
}

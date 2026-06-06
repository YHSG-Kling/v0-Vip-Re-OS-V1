/**
 * app/api/cron/content-intel-exa/route.ts
 *
 * Wave 17 — Exa neural-search ingest. Twice daily (06:30, 14:30 UTC), iterates
 * every active content_topic_sources row of source_type='youtube_search'
 * (we overload that bucket for ANY natural-language query Exa can answer —
 * "youtube_search" is the legacy name, the source_config decides what's
 * actually searched).
 *
 * Per source: runs exaSearch() with the configured query + withinDays
 * window, upserts each result into content_topic_bank keyed on result_url.
 *
 * Auth: CRON_SECRET.
 */
import { NextResponse, type NextRequest } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { exaSearch } from "@/lib/content-intel/exa-scraper"

export const dynamic = "force-dynamic"
export const maxDuration = 300
export const runtime = "nodejs"

interface SourceRow {
  id:            string
  source_config: { query?: string; withinDays?: number; category?: string; type?: "neural" | "keyword" | "auto" }
  brokerage_id:  string | null
  label:         string | null
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization")?.replace("Bearer ", "")
  const qs   = new URL(req.url).searchParams.get("secret")
  const expected = process.env.CRON_SECRET
  if (!expected) return NextResponse.json({ skipped: "CRON_SECRET not configured" })
  if (auth !== expected && qs !== expected) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!process.env.EXA_API_KEY) return NextResponse.json({ skipped: "EXA_API_KEY not configured" })

  const svc = createServiceClient()
  const { data: sources, error } = await svc.from("content_topic_sources")
    .select("id, source_config, brokerage_id, label")
    .eq("source_type", "youtube_search")  // overloaded for Exa queries
    .eq("is_active", true)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const results: Array<{ source_id: string; query: string; fetched: number; inserted: number; updated: number }> = []

  for (const s of (sources ?? []) as SourceRow[]) {
    const query = s.source_config?.query
    if (!query) continue
    let fetched = 0, inserted = 0, updated = 0
    try {
      const items = await exaSearch({
        query,
        withinDays: s.source_config?.withinDays ?? 7,
        category:   s.source_config?.category,
        type:       s.source_config?.type ?? "neural",
        numResults: 20,
      })
      fetched = items.length
      for (const it of items) {
        const existing = await svc.from("content_topic_bank")
          .select("id")
          .eq("source_id", s.id)
          .eq("source_url", it.url)
          .maybeSingle()
        const row = {
          source_id:        s.id,
          brokerage_id:     s.brokerage_id,
          topic_title:      it.title,
          value_angle:      it.summary.slice(0, 300),
          source_url:       it.url,
          raw_data: {
            summary:        it.summary,
            published_date: it.published_date,
            exa_result_id:  it.result_id,
          },
          engagement_score: it.engagement_score,
          categories:       it.categories,
          topic_posted_at:  it.published_date,
          scraped_at:       new Date().toISOString(),
          expires_at:       new Date(Date.now() + 14 * 86_400_000).toISOString(),
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
      console.error(`[content-intel-exa] "${query}" failed:`, (e as Error).message)
    }
    results.push({ source_id: s.id, query, fetched, inserted, updated })
  }

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

/**
 * app/api/cron/content-intel-apify/route.ts
 *
 * Wave 18 — Apify competitor & handle ingest. Daily 07:30 UTC.
 *
 * Iterates content_topic_sources rows of source_type='apify_actor'. Each
 * row's source_config carries the actor id + input payload + which fields
 * to map. The cron runs the actor synchronously (run-sync endpoint, 60s
 * timeout), normalizes the dataset, upserts into content_topic_bank by
 * (source_id, source_url).
 *
 * Brokerages enable competitor scraping by adding source_type='apify_actor'
 * rows pointing at their competitor @handles. The admin UI writes those
 * rows with the brokerage_id set so the topic feeds only this brokerage's
 * generators (per the m128 brokerage_id scoping).
 *
 * Auth: CRON_SECRET.
 */
import { NextResponse, type NextRequest } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { runApifyScrape } from "@/lib/content-intel/apify-scraper"

export const dynamic = "force-dynamic"
export const maxDuration = 300
export const runtime = "nodejs"

interface ApifySourceConfig {
  actor?:              string
  input?:              Record<string, unknown>
  title_field?:        string
  url_field?:          string
  engagement_fields?:  string[]
  /** Optional geo tag applied to every item this source ingests
   *  (e.g. an Instagram hashtag scraper for #miamirealestate would set
   *  geo_relevance.cities=['Miami']). */
  geo_relevance?:      { cities?: string[]; states?: string[]; zip_codes?: string[] }
}

interface SourceRow {
  id:            string
  source_config: ApifySourceConfig
  brokerage_id:  string | null
  label:         string | null
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization")?.replace("Bearer ", "")
  const qs   = new URL(req.url).searchParams.get("secret")
  const expected = process.env.CRON_SECRET
  if (!expected) return NextResponse.json({ skipped: "CRON_SECRET not configured" })
  if (auth !== expected && qs !== expected) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!process.env.APIFY_TOKEN) return NextResponse.json({ skipped: "APIFY_TOKEN not configured" })

  const svc = createServiceClient()
  const { data: sources, error } = await svc.from("content_topic_sources")
    .select("id, source_config, brokerage_id, label")
    .eq("source_type", "apify_actor")
    .eq("is_active", true)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const results: Array<{ source_id: string; actor: string; fetched: number; inserted: number; updated: number }> = []

  for (const s of (sources ?? []) as SourceRow[]) {
    const cfg = s.source_config ?? {}
    const actor      = cfg.actor
    const input      = cfg.input
    const titleField = cfg.title_field ?? "caption"
    const urlField   = cfg.url_field   ?? "url"
    if (!actor || !input) continue

    let fetched = 0, inserted = 0, updated = 0
    try {
      const items = await runApifyScrape({
        actor,
        input,
        title_field:        titleField,
        url_field:          urlField,
        engagement_fields:  cfg.engagement_fields,
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
            apify_item_id:  it.item_id,
            actor,
          },
          engagement_score: it.engagement_score,
          categories:       it.categories,
          topic_posted_at:  it.published_date,
          scraped_at:       new Date().toISOString(),
          expires_at:       new Date(Date.now() + 14 * 86_400_000).toISOString(),
          geo_relevance:    cfg.geo_relevance ?? null,
        }
        if (existing.data) {
          await svc.from("content_topic_bank")
            .update({
              engagement_score: row.engagement_score,
              raw_data:         row.raw_data,
              scraped_at:       row.scraped_at,
              categories:       row.categories,
              value_angle:      row.value_angle,
              geo_relevance:    row.geo_relevance,
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
      console.error(`[content-intel-apify] ${actor} failed:`, (e as Error).message)
    }
    results.push({ source_id: s.id, actor, fetched, inserted, updated })
  }

  return NextResponse.json({
    ran_at: new Date().toISOString(),
    sources_processed: results.length,
    results,
  })
}

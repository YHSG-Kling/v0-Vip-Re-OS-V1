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
 * window and files each result through THE ONE topic intake
 * (lib/content-intel/topic-intake.ts intakeTopicIdeas — wave 154, lane 154G1).
 *
 * Auth: CRON_SECRET.
 */
import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import { NextResponse, type NextRequest } from "next/server"
import { verifyCronAuth } from "@/lib/cron-auth"
import { decideCronRun } from "@/lib/kernel/cron-logging"
import { createServiceClient } from "@/lib/supabase/service"
import { exaSearch } from "@/lib/content-intel/exa-scraper"
import { intakeTopicIdeas } from "@/lib/content-intel/topic-intake"

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
  const denied = verifyCronAuth(req)
  if (denied) return denied
  const cronDoor = await decideCronRun({ cron_name: "content-intel-exa", cron_path: "/app/api/cron/content-intel-exa/route.ts" }) // cron decision door (155R1)
  if (cronDoor.held) return NextResponse.json({ success: true, held: true, decision: cronDoor.decision })
  if (!process.env.EXA_API_KEY) return NextResponse.json({ skipped: "EXA_API_KEY not configured" })

  const svc = createServiceClient()
  const { data: sources, error } = await svc.from("content_topic_sources")
    .select("id, source_config, brokerage_id, label")
    .eq("source_type", "youtube_search")  // overloaded for Exa queries
    .eq("is_active", true)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const results: Array<{ source_id: string; query: string; fetched: number; inserted: number; updated: number }> = []

  // ACTIVE-TERRITORY PRE-CHECK (wave 92, lane 92B — owner: "checking the active territories before
  // scrapping and pulling data will cutdown on runs"): ONE resolution, every skipped run counted.
  // A tenant's own topic source runs only for a live tenant; a PLATFORM source (brokerage_id null)
  // is not tenant-bound and always runs.
  const { resolveActivePullGate } = await import("@/lib/lead-pipeline/scrape-territories")
  const pullGate = await resolveActivePullGate(svc)
  for (const s of (sources ?? []) as SourceRow[]) {
    if (s.brokerage_id && !pullGate.check({ brokerageId: s.brokerage_id }).allowed) continue
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
      // THROUGH THE ONE INTAKE (wave 154, lane 154G1 — this route inserted directly and stored the page summary verbatim as
      // the angle at the batch-2 base). Stored now: the credited headline, link and date (rights public_citation) — the
      // summary is NOT stored; Exa's relevance score is a labeled proxy, or "unknown" when Exa returned none.
      const now = new Date()
      const r = await intakeTopicIdeas(svc, {
        brokerageId: s.brokerage_id, now,
        ideas: items.map((it) => ({
          sourceKind: "web_research", sourceId: s.id, title: it.title,
          angle: "Explain what this means for local buyers and sellers in ORIGINAL words; credit and link the source — never copy it.",
          categories: it.categories, sourceUrl: it.url, publishedAt: it.published_date, observedAt: now.toISOString(),
          evidence: it.relevance_measured
            ? { kind: "proxy" as const, metric: "exa_search_relevance", value: it.engagement_score, unit: "score_0_100", note: `search relevance to "${query}" — not engagement, not search volume` }
            : { kind: "unknown" as const, metric: null, value: null, unit: null, note: "Exa returned no relevance score" },
          rights: "public_citation" as const,
          brief: { transport: "exa", exa_result_id: it.result_id, query },
        })),
      })
      inserted = r.inserted
      updated = r.merged
      if (!r.ok) console.error(`[content-intel-exa] "${query}" intake: ${r.refused ?? r.errors.slice(0, 3).join("; ")}`)
      const { error: lastRunErr } = await svc.from("content_topic_sources").update({ last_run_at: now.toISOString() }).eq("id", s.id).select("id")
      if (lastRunErr) console.error(`[content-intel-exa] last_run_at not recorded for ${s.id}: ${lastRunErr.message}`)
    } catch (e) {
      console.error(`[content-intel-exa] "${query}" failed:`, (e as Error).message)
    }
    results.push({ source_id: s.id, query, fetched, inserted, updated })
  }

  await sentinelWrite(svc, svc.from("content_topic_bank")
    .update({ status: "stale" })
    .eq("status", "fresh")
    .lt("expires_at", new Date().toISOString()), { table: "content_topic_bank", flow: "content_topic_bank_write", reason: "analytics/cache/annotation row: its loss does not change what the caller reports — logged, never silent" })

  return NextResponse.json({
    territory_gate: pullGate.tally,
    ran_at: new Date().toISOString(),
    sources_processed: results.length,
    results,
  })
}

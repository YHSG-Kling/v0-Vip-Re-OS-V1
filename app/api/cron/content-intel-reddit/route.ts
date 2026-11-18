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
 * WAVE 154 (lane 154C — owner R1 / R9): threads go through THE ONE intake (lib/content-intel/topic-intake.ts) as REWORDED
 * topics — the thread's own title and selftext are fenced, reworded in memory (lib/content-intel/public-chatter-topics.ts)
 * and discarded (this route used to store both verbatim). Upvotes + comments are MEASURED public counts in their own unit.
 *
 * Auth: CRON_SECRET.
 */
import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import { NextResponse, type NextRequest } from "next/server"
import { verifyCronAuth } from "@/lib/cron-auth"
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
  const denied = verifyCronAuth(req)
  if (denied) return denied

  const svc = createServiceClient()
  const { data: sources, error } = await svc
    .from("content_topic_sources")
    .select("id, source_config, brokerage_id, label")
    .eq("source_type", "reddit")
    .eq("is_active", true)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const results: Array<{ source_id: string; subreddit: string; fetched: number; inserted: number; updated: number; excluded: number; held: number; error?: string }> = []
  const { intakeTopicIdeas } = await import("@/lib/content-intel/topic-intake")
  const { deriveRewordedTopic, fenceUntrusted, observationDigest } = await import("@/lib/content-intel/public-chatter-topics")

  // ACTIVE-TERRITORY PRE-CHECK (wave 92, lane 92B — owner: "checking the active territories before
  // scrapping and pulling data will cutdown on runs"): a tenant's own topic source runs only for a
  // live tenant; a PLATFORM source (brokerage_id null) is not tenant-bound and always runs.
  const { resolveActivePullGate } = await import("@/lib/lead-pipeline/scrape-territories")
  const pullGate = await resolveActivePullGate(svc)
  for (const s of (sources ?? []) as SourceRow[]) {
    if (s.brokerage_id && !pullGate.check({ brokerageId: s.brokerage_id }).allowed) continue
    const sub = s.source_config?.subreddit ?? null
    const win: RedditWindow = (s.source_config?.window as RedditWindow) ?? "week"
    if (!sub) continue

    let fetched = 0, inserted = 0, updated = 0, excluded = 0, held = 0
    let runError: string | undefined
    try {
      const threads = await fetchTopThreads({ subreddit: sub, window: win, limit: 25 })
      fetched = threads.length
      const now = new Date()
      const ideas = []
      for (const t of threads) {
        // The thread's words are untrusted and never stored: fenced, reworded, discarded.
        const fenced = fenceUntrusted(`${t.title}. ${t.selftext ?? ""}`)
        const d = await deriveRewordedTopic(fenced, { geoLabel: null, sourceKind: "reddit_thread" })
        if (d.status === "excluded") { excluded++; continue }
        if (d.status === "held") { held++; continue }
        ideas.push({
          sourceKind: "reddit_thread", sourceId: s.id, title: d.title, angle: d.angle, categories: [...new Set([...d.categories, ...(t.categories ?? [])])],
          sourceUrl: t.permalink, publishedAt: new Date(t.created_utc * 1000).toISOString(), observedAt: now.toISOString(),
          evidence: { kind: "measured" as const, metric: "reddit_upvotes_plus_comments", value: (t.upvotes ?? 0) + (t.comments ?? 0), unit: "count", note: `r/${t.subreddit} public counts` },
          rights: "public_read_reworded" as const,
          brief: { observation_key: observationDigest(fenced), transport: "reddit_api", consumer_question: d.consumerQuestion, topic_concept: d.title, theme_keys: d.themeKeys, subreddit: t.subreddit, rewording: d.status },
        })
      }
      // Upsert by the intake's dedup key; an already-used topic stays used; a replay is one observation.
      const r = await intakeTopicIdeas(svc, { brokerageId: s.brokerage_id, ideas, now })
      inserted = r.inserted
      updated = r.merged
      excluded += r.excluded.length
      if (!r.ok) runError = r.refused ?? r.errors.slice(0, 3).join("; ")
      const { error: lastRunErr } = await svc.from("content_topic_sources").update({ last_run_at: now.toISOString() }).eq("id", s.id).select("id")
      if (lastRunErr) runError = `${runError ? `${runError}; ` : ""}last_run_at not recorded: ${lastRunErr.message}`
    } catch (e) {
      runError = (e as Error).message
      console.error(`[content-intel-reddit] ${sub} failed:`, (e as Error).message)
    }

    results.push({ source_id: s.id, subreddit: sub, fetched, inserted, updated, excluded, held, ...(runError ? { error: runError } : {}) })
  }

  // Stale sweep — flip topics past expires_at to 'stale' so the picker stops returning them.
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

/**
 * app/api/cron/content-intel-apify/route.ts
 *
 * Wave 18 — Apify competitor & handle ingest. Daily 07:30 UTC.
 *
 * Iterates content_topic_sources rows of source_type='apify_actor'. Each
 * row's source_config carries the actor id + input payload + which fields
 * to map. The cron runs the actor synchronously (run-sync endpoint, 60s
 * timeout) and files what it found in content_topic_bank.
 *
 * Brokerages enable competitor scraping by adding source_type='apify_actor'
 * rows pointing at their competitor @handles. The admin UI writes those
 * rows with the brokerage_id set so the topic feeds only this brokerage's
 * generators (per the m128 brokerage_id scoping).
 *
 * WAVE 154 (lane 154C — owner R1 / R3 / R9): every item now goes through THE ONE intake (lib/content-intel/topic-intake.ts
 * intakeTopicIdeas) as a REWORDED topic — the post's own caption is never the stored title (this route used to file it
 * verbatim, with an invented 20-point engagement floor). Two source kinds are IDEAS ONLY and use their own normalizers
 * (lib/content-intel/public-chatter-topics.ts): public Facebook group questions (`apify/facebook-groups-scraper`) and Meta Ad
 * Library creatives (`apify/facebook-ads-scraper`). Before ANY actor call a source must pass, in order: an active row (the
 * select — an inactive source makes zero calls) → the tenant's active-territory gate → its rights / visibility / no-login check
 * (apifyIdeaSourceProblem — PENDING_RIGHTS sources make no call) → its run budget (source_config.max_run_usd against the
 * actor's documented per-item price × resultsLimit). Every skip is reported with a human resolution path. Nothing here
 * imports or reaches the acquisition side door (social-sourcer, ingestRawSourceBatch, the AI ISA) — scripts/
 * public-chatter-topics-guard.ts walks this route's import graph.
 *
 * Auth: CRON_SECRET.
 */
import { NextResponse, type NextRequest } from "next/server"
import { verifyCronAuth } from "@/lib/cron-auth"
import { decideCronRun } from "@/lib/kernel/cron-logging"
import { createServiceClient } from "@/lib/supabase/service"
import { apifyToken } from "@/lib/env/aliases"
import { runApifyScrape, apifySocialIdeas } from "@/lib/content-intel/apify-scraper"

export const dynamic = "force-dynamic"
export const maxDuration = 300
export const runtime = "nodejs"

interface ApifySourceConfig {
  actor?:              string
  input?:              Record<string, unknown>
  title_field?:        string
  url_field?:          string
  engagement_fields?:  string[]
  /** Optional geo tag applied to every item this source ingests (the territory the tenant configured). */
  geo_relevance?:      { cities?: string[]; states?: string[]; zip_codes?: string[] }
  /** Idea sources (Facebook): the recorded rights status, the group's verified visibility, and the per-run budget. */
  rights?:             string | null
  visibility?:         string | null
  max_run_usd?:        number | null
}

interface SourceRow {
  id:            string
  source_config: ApifySourceConfig
  brokerage_id:  string | null
  label:         string | null
}

const RESOLUTION = "Marketing → Content intelligence → Sources: record the source's rights / visibility / budget, or switch the source off"

export async function GET(req: NextRequest) {
  const denied = verifyCronAuth(req)
  if (denied) return denied
  const cronDoor = await decideCronRun({ cron_name: "content-intel-apify", cron_path: "/app/api/cron/content-intel-apify/route.ts" }) // cron decision door (155R1)
  if (cronDoor.held) return NextResponse.json({ success: true, held: true, decision: cronDoor.decision })
  // ONE SPELLING (§6): APIFY_API_TOKEN is the survivor; APIFY_TOKEN accepted for
  // one release through lib/env/aliases.ts.
  if (!apifyToken()) return NextResponse.json({ skipped: "APIFY_API_TOKEN not configured", status: "disconnected_key", resolution: "Settings → Integrations → Apify: connect the key (an owner action)" })

  const svc = createServiceClient()
  const { data: sources, error } = await svc.from("content_topic_sources")
    .select("id, source_config, brokerage_id, label")
    .eq("source_type", "apify_actor")
    .eq("is_active", true)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const { intakeTopicIdeas } = await import("@/lib/content-intel/topic-intake")
  const { apifyIdeaActorFor, apifyIdeaSourceProblem, apifyIdeaBudgetProblem, normalizeApifyIdeaItems } = await import("@/lib/content-intel/public-chatter-topics")
  const results: Array<{ source_id: string; actor: string; status: string; fetched: number; inserted: number; merged: number; excluded: number; held: number; reason?: string; resolution?: string }> = []

  // ACTIVE-TERRITORY PRE-CHECK (wave 92, lane 92B — owner: "checking the active territories before
  // scrapping and pulling data will cutdown on runs"): ONE resolution, every skipped run counted.
  // A tenant's own topic source runs only for a live tenant; a PLATFORM source (brokerage_id null)
  // is not tenant-bound and always runs.
  const { resolveActivePullGate } = await import("@/lib/lead-pipeline/scrape-territories")
  const pullGate = await resolveActivePullGate(svc)
  for (const s of (sources ?? []) as SourceRow[]) {
    if (s.brokerage_id && !pullGate.check({ brokerageId: s.brokerage_id }).allowed) continue
    const cfg = s.source_config ?? {}
    const actor = cfg.actor
    const input = cfg.input
    if (!actor || !input) continue
    const ideaActor = apifyIdeaActorFor(actor)
    const row = { source_id: s.id, actor, status: "ok", fetched: 0, inserted: 0, merged: 0, excluded: 0, held: 0 } as (typeof results)[number]

    // Rights / visibility / no-login BEFORE any call (an idea source with no recorded rights makes no call).
    const problem = apifyIdeaSourceProblem(cfg)
    if (problem) { results.push({ ...row, status: "held_rights", reason: problem, resolution: RESOLUTION }); continue }
    // Budget BEFORE any call — idea actors only (their per-item price is documented); no budget recorded → no call.
    const overBudget = apifyIdeaBudgetProblem(cfg)
    if (overBudget) { results.push({ ...row, status: "held_budget", reason: overBudget, resolution: RESOLUTION }); continue }
    if (!s.brokerage_id && ideaActor) { results.push({ ...row, status: "held_rights", reason: "an idea source is per tenant — a platform-wide Facebook source is not run", resolution: RESOLUTION }); continue }

    try {
      const run = await runApifyScrape({ actor, input })
      if (!run.ok) { results.push({ ...row, status: "failed", reason: run.error ?? "actor run failed", resolution: "Settings → Integrations → Apify: check the key and the actor's run log" }); continue }
      row.fetched = run.items.length
      const now = new Date()
      const geo = cfg.geo_relevance ? { city: cfg.geo_relevance.cities?.[0] ?? null, state: cfg.geo_relevance.states?.[0] ?? null, zip: cfg.geo_relevance.zip_codes?.[0] ?? null, label: cfg.geo_relevance.cities?.[0] ?? null } : null
      let ideas
      if (ideaActor) {
        const n = await normalizeApifyIdeaItems(actor, run.items, { geo, now, sourceId: s.id })
        ideas = n?.ideas ?? []
        row.excluded += n?.excluded.length ?? 0
        row.held += n?.held.length ?? 0
        // Meta Ad Library items ALSO get their competitor_ads row so the competitor screen shows them (wave 154, lane 154G1 —
        // lane 154C PARTIAL 4). Ideas only: no ad wording, engagement NULL. The page id matches the tenant's own watchlist
        // (competitor_brokerages.facebook_page_id) when it can; page_id itself is not a competitor_ads column and is dropped.
        const mirror = n?.competitorAds ?? []
        if (mirror.length && s.brokerage_id) {
          const { data: watch, error: watchErr } = await svc.from("competitor_brokerages").select("id, facebook_page_id").eq("brokerage_id", s.brokerage_id).in("facebook_page_id", [...new Set(mirror.map((m) => m.page_id))])
          if (watchErr) row.reason = `${row.reason ? `${row.reason}; ` : ""}watchlist read refused (competitor_id left empty): ${watchErr.message}`
          const byPage = new Map(((watch ?? []) as Array<{ id: string; facebook_page_id: string | null }>).map((w) => [String(w.facebook_page_id), w.id]))
          // NOT an upsert: the live unique index uq_competitor_ads_source_provider_id is PARTIAL (WHERE provider_ad_id IS NOT
          // NULL) — a bare ON CONFLICT cannot infer it — and GLOBAL, so one tenant's write must never land on another
          // tenant's row. Read this ad's row first; update it only when it is THIS tenant's; insert when absent; when another
          // tenant holds it, say so (owner SQL in the lane notes makes the key per tenant).
          const problems: string[] = []
          const brokerageId = s.brokerage_id
          const writeMirror = async (): Promise<void> => {
          for (const { page_id, ...m } of mirror) {
            const rowOut = { ...m, brokerage_id: brokerageId, competitor_id: byPage.get(page_id) ?? null }
            // TENANT-PINNED READ (wave 154, m987): this tenant's own row for the ad, never another tenant's. Until the owner drops
            // the old GLOBAL index, a second tenant's insert of the same ad is refused by the database (23505) and reported below —
            // the first tenant's row is never read, updated or overwritten from here.
            const { data: have, error: haveErr } = await svc.from("competitor_ads").select("id, brokerage_id").eq("brokerage_id", brokerageId).eq("source_platform", "facebook").eq("provider_ad_id", m.provider_ad_id).maybeSingle()
            if (haveErr) { problems.push(`read ${m.provider_ad_id}: ${haveErr.message}`); continue }
            const held = have as { id: string; brokerage_id: string } | null
            const w = held
              ? await svc.from("competitor_ads").update({ last_seen_at: m.last_seen_at, ad_delivery_stop: m.ad_delivery_stop, raw_payload: m.raw_payload, categories: m.categories, competitor_id: rowOut.competitor_id }).eq("id", held.id).eq("brokerage_id", brokerageId).select("id")
              : await svc.from("competitor_ads").insert(rowOut).select("id")
            if (w.error || (w.data ?? []).length !== 1) problems.push(`write ${m.provider_ad_id}: ${(w.error as { code?: string } | null)?.code === "23505" ? "held — another tenant already stores this ad and the global index has not been dropped (owner SQL)" : w.error?.message ?? "no row"}`)
          }
          }
          // LAW 5 — the mirror write leaves evidence (one row per source per run hour; a replay writes nothing twice).
          const { withActionLedger } = await import("@/lib/kernel/action-ledger")
          await withActionLedger(
            {
              // Wave 154 (lane 154L, canary L7a): three segments — the two-segment "intel.meta_ad_library_mirror" was REFUSED by
              // the ledger's domain.entity.action rule, so no competitor_ads mirror row was ever written.
              brokerageId, action: "intel.meta_ad_library.mirror", actor: { type: "manager", managerKey: "campaign_orchestrator" },
              subject: { type: "content_topic_source", id: s.id }, idempotencyKey: `meta_ad_mirror:${s.id}:${now.toISOString().slice(0, 13)}`, riskClass: "LOW_RISK_WRITE",
              systemSource: "content-intel-apify", reasonDetail: "Meta Ad Library items shown on the competitor screen — ideas only, no ad wording", detail: { ads: mirror.length },
            },
            async () => { await writeMirror(); return problems.length },
            { settle: (n) => ({ status: n === 0 ? "executed" as const : "failed" as const, outcome: `${mirror.length - n} of ${mirror.length} competitor_ads rows written`, error: n ? problems.slice(0, 3).join("; ") : null }),
              replay: (claim) => { if (claim.kind === "refused") problems.push(`action ledger refused the mirror write — nothing written: ${claim.error}`); return problems.length } },
            { client: svc },
          )
          if (problems.length) { row.status = "partial"; row.reason = `${row.reason ? `${row.reason}; ` : ""}competitor_ads mirror: ${problems.slice(0, 3).join("; ")}` }
        }
      } else {
        const n = await apifySocialIdeas(run.items, { title_field: cfg.title_field, url_field: cfg.url_field, engagement_fields: cfg.engagement_fields, geo, sourceId: s.id, now })
        ideas = n.ideas
        row.excluded += n.excluded
        row.held += n.held
      }
      // Replays and duplicate actor results are ONE observation at the intake (its dedup + observation keys).
      const r = await intakeTopicIdeas(svc, { brokerageId: s.brokerage_id, ideas, now })
      row.inserted = r.inserted
      row.merged = r.merged
      row.excluded += r.excluded.length
      if (!r.ok) { row.status = "partial"; row.reason = r.refused ?? r.errors.slice(0, 3).join("; ") }
      const { error: lastRunErr } = await svc.from("content_topic_sources").update({ last_run_at: now.toISOString() }).eq("id", s.id).select("id")
      if (lastRunErr) { row.status = "partial"; row.reason = `${row.reason ? `${row.reason}; ` : ""}last_run_at not recorded: ${lastRunErr.message}` }
    } catch (e) {
      row.status = "failed"
      row.reason = (e as Error).message
      console.error(`[content-intel-apify] ${actor} failed:`, (e as Error).message)
    }
    results.push(row)
  }

  return NextResponse.json({
    territory_gate: pullGate.tally,
    ran_at: new Date().toISOString(),
    sources_processed: results.length,
    results,
  })
}

/**
 * app/api/cron/content-intel-community/route.ts
 *
 * Wave 154 (lane 154G1 — finishing lane 154C's PARTIAL 1; owner rulings R1 / R2): the SCHEDULED caller of the Nextdoor
 * public-post TOPIC research. Daily (lib/kernel/cron-dispatch.ts CRON_REGISTRY), per tenant:
 *   1. reads ACTIVE content_topic_sources rows of source_type 'manual' that list public post URLs in
 *      source_config.community_post_urls (the tenant's own configuration — nothing is discovered here);
 *   2. checks the tenant against the active-territory pull gate (a lapsed tenant makes no request);
 *   3. calls researchCommunityPostTopics (lib/content-intel/public-chatter-topics.ts): every URL goes through the
 *      checkpointed page transport under the community_topic_research purpose (a non-public URL or a sign-in wall is
 *      refused before / at the request), the visible text is reworded IN MEMORY and discarded, and only the reworded topic
 *      plus minimal provenance reaches THE ONE intake (lib/content-intel/topic-intake.ts). Never a person, never a lead.
 *
 * SPEND: no paid request without a recorded per-run budget (source_config.max_run_usd); a source without one is HELD and
 * makes no call. A shared per-tick fetch budget bounds the whole run. Auth: CRON_SECRET.
 */
import { NextResponse, type NextRequest } from "next/server"
import { verifyCronAuth } from "@/lib/cron-auth"
import { createServiceClient } from "@/lib/supabase/service"

export const dynamic = "force-dynamic"
export const maxDuration = 300
export const runtime = "nodejs"

/** Page fetches one tick may make across every tenant (backpressure; each fetch is a paid transport request). */
const TICK_FETCHES = 40
/** URLs one source may submit per run. */
const URLS_PER_SOURCE = 10

interface CommunitySourceRow {
  id: string
  brokerage_id: string | null
  label: string | null
  source_config: { community_post_urls?: unknown; max_run_usd?: unknown; geo_relevance?: { cities?: string[]; states?: string[]; zip_codes?: string[] } | null } | null
}

export async function GET(req: NextRequest) {
  const denied = verifyCronAuth(req)
  if (denied) return denied

  const svc = createServiceClient()
  const { data: sources, error } = await svc.from("content_topic_sources")
    .select("id, brokerage_id, label, source_config")
    .eq("source_type", "manual")
    .eq("is_active", true)
  if (error) return NextResponse.json({ error: `content_topic_sources read refused: ${error.message}` }, { status: 500 })

  const { resolveActivePullGate } = await import("@/lib/lead-pipeline/scrape-territories")
  const pullGate = await resolveActivePullGate(svc)
  const { researchCommunityPostTopics } = await import("@/lib/content-intel/public-chatter-topics")
  const tickBudget = { fetchesLeft: TICK_FETCHES }
  const results: Array<{ source_id: string; status: string; urls: number; fetched: number; inserted: number; merged: number; excluded: number; held: number; cost_usd: number; reason?: string }> = []

  for (const s of (sources ?? []) as CommunitySourceRow[]) {
    const urls = Array.isArray(s.source_config?.community_post_urls) ? (s.source_config!.community_post_urls as unknown[]).filter((u): u is string => typeof u === "string" && /^https:\/\//.test(u)).slice(0, URLS_PER_SOURCE) : []
    if (urls.length === 0) continue // a manual source with no post URLs is a hand-seed bucket, not a research source
    const row = { source_id: s.id, status: "ok", urls: urls.length, fetched: 0, inserted: 0, merged: 0, excluded: 0, held: 0, cost_usd: 0 } as (typeof results)[number]
    if (!s.brokerage_id) { results.push({ ...row, status: "held", reason: "community topic research is per tenant — a platform-wide source is not run" }); continue }
    if (!pullGate.check({ brokerageId: s.brokerage_id }).allowed) { results.push({ ...row, status: "skipped_inactive_tenant" }); continue }
    const budget = typeof s.source_config?.max_run_usd === "number" && (s.source_config.max_run_usd as number) > 0 ? (s.source_config.max_run_usd as number) : null
    if (budget === null) { results.push({ ...row, status: "held_budget", reason: "no per-run budget recorded (source_config.max_run_usd) — no paid request without one" }); continue }
    let spent = 0
    const g = s.source_config?.geo_relevance ?? null
    try {
      const brokerageId = s.brokerage_id
      // LAW 5 — the run leaves evidence (who: the campaign orchestrator on the tenant's own source; why: the configured
      // topic research; what it cost and what happened: the settlement). One run per source per day (idempotency key).
      const { withActionLedger } = await import("@/lib/kernel/action-ledger")
      const day = new Date().toISOString().slice(0, 10)
      const ran = await withActionLedger(
        {
          brokerageId, action: "intel.community_topic_research", actor: { type: "manager", managerKey: "campaign_orchestrator" },
          subject: { type: "content_topic_source", id: s.id }, idempotencyKey: `community_topics:${s.id}:${day}`, riskClass: "LOW_RISK_WRITE",
          systemSource: "content-intel-community", reasonDetail: "scheduled public-post TOPIC research on the tenant's configured URLs — reworded topics only, never a person",
          detail: { urls: urls.length, budget_usd: budget },
        },
        async () => ({ r: (await researchCommunityPostTopics(svc, {
          brokerageId, urls,
          geo: g ? { cities: g.cities ?? [], states: g.states ?? [], zip_codes: g.zip_codes ?? [], label: g.cities?.[0] ?? null } : null,
        }, {
          snapshot: {
            ledgerClient: svc, tickBudget,
            spendGate: (estimateUsd: number) => spent + estimateUsd <= budget
              ? (spent += estimateUsd, { allowed: true, reason: `within the source's $${budget} per-run budget` })
              : { allowed: false, reason: `the source's $${budget} per-run budget would be exceeded ($${spent.toFixed(4)} + $${estimateUsd})` },
          },
        })) as Awaited<ReturnType<typeof researchCommunityPostTopics>> | null, skipped: null as string | null }),
        {
          settle: (x) => ({ status: x.r && (!x.r.intake || x.r.intake.ok) ? "executed" as const : "failed" as const, outcome: x.r ? `topics ${x.r.intake?.inserted ?? 0} new / ${x.r.intake?.merged ?? 0} merged; ${x.r.held.length} held` : "no run", costUsd: x.r?.costUsd ?? null, error: x.r?.intake && !x.r.intake.ok ? (x.r.intake.refused ?? x.r.intake.errors.slice(0, 2).join("; ")) : null }),
          replay: (claim) => ({ r: null, skipped: claim.kind === "refused" ? `action ledger refused the run — nothing fetched: ${claim.error}` : `already ran today (${claim.kind})` }),
        },
        { client: svc },
      )
      if (!ran.r) { results.push({ ...row, status: ran.skipped?.startsWith("action ledger refused") ? "refused" : "skipped_replay", reason: ran.skipped ?? undefined }); continue }
      const r = ran.r
      row.fetched = r.fetched
      row.held = r.held.length + r.derived.heldTopics.length
      row.excluded = r.derived.excluded.length + (r.intake?.excluded.length ?? 0)
      row.inserted = r.intake?.inserted ?? 0
      row.merged = r.intake?.merged ?? 0
      row.cost_usd = r.costUsd
      if (r.intake && !r.intake.ok) { row.status = "partial"; row.reason = r.intake.refused ?? r.intake.errors.slice(0, 3).join("; ") }
      const { error: lastRunErr } = await svc.from("content_topic_sources").update({ last_run_at: new Date().toISOString() }).eq("id", s.id).eq("brokerage_id", s.brokerage_id).select("id")
      if (lastRunErr) { row.status = "partial"; row.reason = `${row.reason ? `${row.reason}; ` : ""}last_run_at not recorded: ${lastRunErr.message}` }
    } catch (e) {
      row.status = "failed"
      row.reason = (e as Error).message
      console.error(`[content-intel-community] source ${s.id} failed:`, (e as Error).message)
    }
    results.push(row)
  }

  return NextResponse.json({ territory_gate: pullGate.tally, ran_at: new Date().toISOString(), sources_processed: results.length, fetches_left: tickBudget.fetchesLeft, results })
}

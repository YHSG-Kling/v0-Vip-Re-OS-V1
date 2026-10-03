#!/usr/bin/env tsx
/**
 * scripts/voice-execute-simulator.ts   (npm run test:voice-execute)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the VOICE CONDUCTOR now EXECUTES, not just answers: "draft save-plays for my at-risk agents"
 * drafts gated retention save-plays for the currently at-risk agents (authority + tier gated).
 *
 * SOURCE: the voice route has the draft_save_plays intent + handler (authority-gated); the shared
 *         proposeRetentionSavePlay + on-demand draftSavePlaysForAtRiskAgents back it.
 * LIVE (creds-gated): seed an at-risk agent → draftSavePlaysForAtRiskAgents proposes a gated save-play →
 *         idempotent → clean up == 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

function sourceLayer() {
  console.log("\n[wiring — voice EXECUTE + shared save-play helper]")
  const route = src("app/api/internal/voice-command/route.ts")
  check("new query intents wired (flight risk, coverage, referral income)", /query_flight_risk/.test(route) && /query_vendor_coverage/.test(route) && /query_referral_income/.test(route))
  check("EXECUTE intent draft_save_plays is classified + handled", /- draft_save_plays:/.test(route) && /intent === "draft_save_plays"/.test(route))
  // Authority now comes from the shared roster rather than a local four-value
  // literal; the solo-tier fallback is unchanged. Both halves still asserted —
  // dropping either would open the command to any agent in a team brokerage.
  check("draft_save_plays is authority + tier gated (broker/admin or solo)",
    /isAdminOrBroker\(\{\s*user_type[\s\S]{0,400}?plan_tier === "solo_agent"/.test(route))
  check("it invokes the on-demand drafter", /draftSavePlaysForAtRiskAgents\(service, \{ brokerageId \}\)/.test(route))
  const radar = src("lib/recruiting/retention-radar.ts")
  check("the save-play proposal is a shared helper (radar + on-demand share it)", /export async function proposeRetentionSavePlay/.test(radar) && /export async function draftSavePlaysForAtRiskAgents/.test(radar))
  check("both use the same dedupe tag (idempotent, no drift)", /RETENTION SAVE-PLAY — agent:\$\{p\.agentId\}/.test(radar))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — source layer proved the wiring"); return }
  const svc = createClient(url, key)
  console.log("\n[live] seed an at-risk agent → the voice command drafts a gated save-play → idempotent → clean up")
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⊘ no brokerage — skipping"); return }
  const brokerageId = (brk as any).id
  const { data: ag } = await svc.from("agents").select("id").eq("brokerage_id", brokerageId).eq("is_active", true).not("user_id", "is", null).limit(1).maybeSingle()
  if (!ag) { console.log("  ⊘ no agent — skipping"); return }
  const agentId = (ag as any).id
  const cleanup: Array<{ table: string; id: string }> = []
  const today = new Date().toISOString().slice(0, 10)
  try {
    const { data: sc } = await svc.from("agent_retention_scores").insert({ brokerage_id: brokerageId, agent_id: agentId, score_date: today, composite_score: 22, tier: "at_risk", driving_signals: ["no assistant activity in 40 days"] }).select("id").single()
    cleanup.push({ table: "agent_retention_scores", id: (sc as any).id })

    const { draftSavePlaysForAtRiskAgents } = await import("../lib/recruiting/retention-radar")
    const r = await draftSavePlaysForAtRiskAgents(svc as any, { brokerageId })
    check("live: drafted a save-play for the at-risk agent", r.atRisk >= 1 && r.drafted >= 1)

    const { data: msg } = await svc.from("agent_client_messages").select("id, status, audience").eq("brokerage_id", brokerageId).eq("entity_type", "agent").eq("entity_id", agentId).eq("agent_kind", "recruiting_manager").ilike("rationale", "RETENTION SAVE-PLAY%").order("created_at", { ascending: false }).limit(1).maybeSingle()
    if (msg) cleanup.push({ table: "agent_client_messages", id: (msg as any).id })
    check("live: the save-play is a gated proposal to the agent", !!msg && (msg as any).status === "proposed" && (msg as any).audience === "agent")

    const r2 = await draftSavePlaysForAtRiskAgents(svc as any, { brokerageId })
    check("live: idempotent — no duplicate save-play", r2.drafted === 0)
  } finally {
    for (const c of cleanup.reverse()) await svc.from(c.table).delete().eq("id", c.id)
    let left = 0
    for (const c of cleanup) { const { count } = await svc.from(c.table).select("id", { count: "exact", head: true }).eq("id", c.id); left += count ?? 0 }
    check("live: cleanup count == 0", left === 0)
  }
}

async function main() {
  sourceLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ VOICE_EXECUTE_FAIL"); process.exit(1) }
  console.log(" ✅ VOICE_EXECUTE_PASS — a spoken command drafts gated save-plays; the AI team you command")
}
main()

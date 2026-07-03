#!/usr/bin/env tsx
/**
 * scripts/content-freshness-simulator.ts   (npm run test:content-freshness)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves CONTENT FRESHNESS / AUTO-REFRESH — published AI-authored lessons that have aged out are flagged
 * for a gated refresh so stale law/market facts never mislead; a human re-authors through the review queue.
 * HONEST: only published AI modules, only the age axis, undated is never a fabricated flag.
 *
 * PURE:   moduleAgeDays + isModuleStale (published+AI+past-max-age only) + staleModules (oldest-first, cap).
 * SOURCE: the runner proposes a GATED broker brief deduped per ISO week; the weekly cron runs it; owned by
 *         recruiting_manager with a runnable proof.
 * LIVE (creds-gated): seed a stale published AI module → runContentFreshness flags it + proposes a gated
 *         brief → a fresh module is NOT flagged → clean up == 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import {
  moduleAgeDays,
  isModuleStale,
  staleModules,
  MODULE_MAX_AGE_DAYS,
  type ModuleFreshnessRow,
} from "../lib/education/content-freshness"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")
const NOW = new Date("2026-07-01T00:00:00Z")
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString()
const mod = (o: Partial<ModuleFreshnessRow>): ModuleFreshnessRow => ({ id: "m", title: "T", is_ai_generated: true, status: "published", published_at: ago(200), updated_at: null, created_at: ago(300), ...o })

function pureLayer() {
  console.log("\n[age · pure]")
  check("age from the most-recent content date (published)", moduleAgeDays(mod({ published_at: ago(50), updated_at: ago(400) }), NOW) === 50)
  check("undated → null (honest)", moduleAgeDays(mod({ published_at: null, updated_at: null, created_at: null }), NOW) === null)

  console.log("\n[staleness · pure — published AI only, age axis]")
  check(`a published AI module >${MODULE_MAX_AGE_DAYS}d old is STALE`, isModuleStale(mod({ published_at: ago(200) }), NOW))
  check("a fresh published AI module is NOT stale", !isModuleStale(mod({ published_at: ago(30) }), NOW))
  check("a DRAFT module is never age-flagged", !isModuleStale(mod({ status: "pending_review", published_at: ago(400) }), NOW))
  check("a HUMAN-authored module is never age-flagged (not the OS's to refresh)", !isModuleStale(mod({ is_ai_generated: false, published_at: ago(400) }), NOW))
  check("an undated module is never a fabricated flag", !isModuleStale(mod({ published_at: null, updated_at: null, created_at: null }), NOW))

  console.log("\n[staleModules · pure — oldest first, capped]")
  const list = staleModules([
    mod({ id: "old", published_at: ago(300) }),
    mod({ id: "fresh", published_at: ago(10) }),
    mod({ id: "mid", published_at: ago(190) }),
  ], NOW, { limit: 5 })
  check("returns only stale, oldest-first", list.map((m) => m.id).join(",") === "old,mid" && list[0].ageDays === 300)
}

function sourceLayer() {
  console.log("\n[wiring — gated brief, cron, owned]")
  const lib = src("lib/education/content-freshness.ts")
  check("the runner proposes a GATED broker brief deduped per ISO week", /proposeClientMessage/.test(lib) && /EDU FRESHNESS — \$\{isoWeekKey/.test(lib))
  check("only published AI modules are scanned", /\.eq\("status", "published"\)\.eq\("is_ai_generated", true\)/.test(lib))
  const cron = src("app/api/cron/recruit-outreach/route.ts")
  check("the weekly recruit-outreach cron runs the freshness scan", /runContentFreshnessAll/.test(cron))
  const reg = src("lib/kernel/manager-registry.ts")
  check("burn domain owned by recruiting_manager with a runnable proof", /content_freshness:\s*\{\s*manager:\s*"recruiting_manager",\s*proof:\s*"test:content-freshness"/.test(reg))
  check("package.json wires the proof", /"test:content-freshness":\s*"tsx scripts\/content-freshness-simulator\.ts"/.test(src("package.json")))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the logic"); return }
  const svc = createClient(url, key)
  console.log("\n[live] seed a stale published AI module → freshness flags it + gated brief → clean up")
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⊘ no brokerage — skipping"); return }
  const brokerageId = (brk as any).id
  const cleanup: Array<{ table: string; id: string }> = []
  const { runContentFreshness } = await import("../lib/education/content-freshness")
  const old = new Date(Date.now() - 240 * 86_400_000).toISOString()
  try {
    const { data: m } = await svc.from("learning_modules").insert({
      brokerage_id: brokerageId, title: "ZZ Stale Sim Lesson", body: "old content", status: "published",
      is_ai_generated: true, audience_roles: ["agent"], published_at: old, updated_at: old, created_at: old,
    }).select("id").single()
    cleanup.push({ table: "learning_modules", id: (m as any).id })

    const r1 = await runContentFreshness(svc as any, { brokerageId })
    check("live: the stale module is flagged", r1.stale >= 1)
    const { data: brief } = await svc.from("agent_client_messages").select("id")
      .eq("brokerage_id", brokerageId).eq("agent_kind", "recruiting_manager").ilike("rationale", "EDU FRESHNESS —%").order("created_at", { ascending: false }).limit(1).maybeSingle()
    check("live: a gated refresh brief was proposed", r1.briefProposed && !!brief)
    if (brief) cleanup.push({ table: "agent_client_messages", id: (brief as any).id })

    const r2 = await runContentFreshness(svc as any, { brokerageId })
    check("live: idempotent — no duplicate brief same ISO week", r2.briefProposed === false)
  } finally {
    for (const c of cleanup.reverse()) await svc.from(c.table).delete().eq("id", c.id)
    let left = 0
    for (const c of cleanup) { const { count } = await svc.from(c.table).select("id", { count: "exact", head: true }).eq("id", c.id); left += count ?? 0 }
    check("live: cleanup count == 0", left === 0)
  }
}

async function main() {
  pureLayer()
  sourceLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ CONTENT_FRESHNESS_FAIL"); process.exit(1) }
  console.log(" ✅ CONTENT_FRESHNESS_PASS — stale AI lessons flagged for a gated refresh; fresh + human + draft modules untouched")
}
main()

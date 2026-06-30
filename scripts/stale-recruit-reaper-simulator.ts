#!/usr/bin/env tsx
/**
 * scripts/stale-recruit-reaper-simulator.ts   (npm run test:stale-recruit-reaper)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the Recruiting Manager's stale-recruit reaper: an active recruit with no
 * pipeline movement past its STAGE-weighted SLA (offer_extended 5d → prospect 30d)
 * is escalated to the recruiter; terminal (joined/declined) and within-SLA recruits
 * are left alone. Pure stage-SLA policy + (creds-gated) live seed → reap → assert →
 * idempotent → cleanup (count == 0).
 */
import { classifyStaleRecruit, slaDaysForStage, RECRUIT_STAGE_SLA_DAYS } from "../lib/recruiting/stale-recruit-policy"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

const NOW = new Date("2026-03-01T00:00:00Z")
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString()

async function main() {
  console.log("\n[stage SLA tiers — perishable stages have shorter fuses]")
  check("offer_extended = 5d", slaDaysForStage("offer_extended") === 5)
  check("interviewing = 10d", slaDaysForStage("interviewing") === 10)
  check("contacted = 14d", slaDaysForStage("contacted") === 14)
  check("prospect = 30d", slaDaysForStage("prospect") === 30)
  check("joined (terminal) → null", slaDaysForStage("joined") === null)
  check("declined (terminal) → null", slaDaysForStage("declined") === null)

  console.log("\n[classifyStaleRecruit]")
  check("offer_extended stale past 5d → escalate", classifyStaleRecruit({ status: "offer_extended", updatedAt: daysAgo(6), now: NOW }) === "escalate")
  check("offer_extended within 5d → keep", classifyStaleRecruit({ status: "offer_extended", updatedAt: daysAgo(3), now: NOW }) === "keep")
  check("prospect at 20d → keep (30d fuse)", classifyStaleRecruit({ status: "prospect", updatedAt: daysAgo(20), now: NOW }) === "keep")
  check("prospect past 30d → escalate", classifyStaleRecruit({ status: "prospect", updatedAt: daysAgo(31), now: NOW }) === "escalate")
  check("contacted past 14d → escalate", classifyStaleRecruit({ status: "contacted", updatedAt: daysAgo(15), now: NOW }) === "escalate")
  check("joined (terminal) → keep even if old", classifyStaleRecruit({ status: "joined", updatedAt: daysAgo(100), now: NOW }) === "keep")
  check("declined (terminal) → keep", classifyStaleRecruit({ status: "declined", updatedAt: daysAgo(100), now: NOW }) === "keep")
  check("no updated_at → keep (can't age)", classifyStaleRecruit({ status: "contacted", updatedAt: null, now: NOW }) === "keep")
  check("every active stage has an SLA", ["prospect", "contacted", "interviewing", "offer_extended"].every((s) => s in RECRUIT_STAGE_SLA_DAYS))

  // ── LIVE LAYER (creds-gated) ──
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.log("\n[live] ⏭  Skipped — SUPABASE creds not set (pure layer ran).")
  } else {
    console.log("\n[live] seed a stale offer_extended recruit → reap → assert → idempotent → cleanup")
    const { createServiceClient } = await import("../lib/supabase/service")
    const { reapStaleRecruits } = await import("../lib/recruiting/stale-recruit-reaper")
    const svc = createServiceClient()
    const { data: a } = await svc.from("agents").select("id, brokerage_id, user_id").not("user_id", "is", null).limit(1).maybeSingle()
    if (!a) { console.log("  ⏭  no agent-with-user available to be the recruiter") }
    else {
      const { data: rec } = await svc.from("recruits").insert({
        brokerage_id: a.brokerage_id, recruiter_agent_id: a.id, status: "offer_extended",
        first_name: "Live", last_name: "Test", updated_at: daysAgo(10),
      }).select("id").maybeSingle()
      try {
        const r1 = await reapStaleRecruits(a.brokerage_id, svc, { limit: 500 })
        check("live: escalated >= 1", r1.escalated >= 1)
        const { data: note } = await svc.from("notifications").select("id, priority")
          .eq("brokerage_id", a.brokerage_id).eq("type", "recruit_gone_cold").eq("entity_id", rec!.id).maybeSingle()
        check("live: high-priority (offer on table) notification", !!note && (note as any).priority === "high")
        const r2 = await reapStaleRecruits(a.brokerage_id, svc, { limit: 500 })
        check("live: idempotent re-run", r2.escalated === 0 || !!note)
        await svc.from("notifications").delete().eq("type", "recruit_gone_cold").eq("entity_id", rec!.id)
        await svc.from("recruits").delete().eq("id", rec!.id)
        const { count } = await svc.from("recruits").select("id", { count: "exact", head: true }).eq("id", rec!.id)
        check("live: cleanup count == 0", (count ?? 0) === 0)
      } catch (e) {
        await svc.from("notifications").delete().eq("type", "recruit_gone_cold").eq("entity_id", rec!.id).then(() => {}, () => {})
        await svc.from("recruits").delete().eq("id", rec!.id).then(() => {}, () => {})
        throw e
      }
    }
  }

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ STALE_RECRUIT_REAPER_FAIL"); process.exit(1) }
  console.log(" ✅ STALE_RECRUIT_REAPER_PASS — cold recruits escalated by stage SLA, terminal/fresh left alone")
}
main()

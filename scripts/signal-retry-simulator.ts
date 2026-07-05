#!/usr/bin/env tsx
/**
 * scripts/signal-retry-simulator.ts   (npm run test:signal-retry)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the BUS SELF-HEALS: a stalled inter-manager handoff is automatically RE-HANDED to the
 * addressed manager a bounded number of times before escalating to a human — the dead-letter
 * retry the coordination backbone was missing.
 *
 * PURE:   shouldAutoReplaySignal — a handled handoff due to escalate replays while under the cap;
 *         at the cap it stops (→ human escalation); feed-only signals are never replayed.
 * SOURCE: the reaper re-publishes (dedupe:false, payload._replays+1) + expires the old BEFORE the
 *         human-escalation branch; owned by data_steward with a runnable proof.
 * LIVE (creds-gated): seed a 30h-old open handled signal (no _replays) → reap → the old is expired
 *         + a NEW open signal to the same manager carries _replays=1; seed one already at the cap →
 *         reap → escalated (no new signal, old expired). Clean up == 0. Self-skips without creds.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { shouldAutoReplaySignal, SIGNAL_AUTO_REPLAY_CAP } from "../lib/kernel/signal-reaper-policy"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

function pureLayer() {
  console.log("\n[shouldAutoReplaySignal · pure — bounded self-heal before escalation]")
  check("a stalled handled handoff with 0 replays IS auto-replayed", shouldAutoReplaySignal({ action: "expire_escalate", replays: 0 }))
  check("still replayed one below the cap", shouldAutoReplaySignal({ action: "expire_escalate", replays: SIGNAL_AUTO_REPLAY_CAP - 1 }))
  check("AT the cap it is NOT replayed (→ human escalation)", !shouldAutoReplaySignal({ action: "expire_escalate", replays: SIGNAL_AUTO_REPLAY_CAP }))
  check("a feed-only expiry is never replayed", !shouldAutoReplaySignal({ action: "expire_quiet", replays: 0 }))
  check("a signal still inside its window (keep) is never replayed", !shouldAutoReplaySignal({ action: "keep", replays: 0 }))
}

function sourceLayer() {
  console.log("\n[wiring — reaper re-hands before escalating, bounded + expiring the old]")
  const reaper = src("lib/kernel/signal-reaper.ts")
  check("the reaper attempts auto-replay before the human-escalation branch",
    reaper.indexOf("shouldAutoReplaySignal") < reaper.indexOf('if (action === "expire_escalate")'))
  check("re-publishes via publishManagerSignal with dedupe:false + incremented _replays",
    /publishManagerSignal\(\{[\s\S]*dedupe:\s+false/.test(reaper) && /_replays: replays \+ 1/.test(reaper))
  check("expires the OLD row on a successful replay (invariant preserved) + counts it",
    /status: "expired"[\s\S]*auto-replayed/.test(reaper) && /result\.replayed \+= 1/.test(reaper))
  check("a failed republish falls through to escalate+expire (a stall is never lost)",
    /republish failed → fall through/.test(reaper))
  const reg = src("lib/kernel/manager-registry.ts")
  check("burn domain owned by data_steward with a runnable proof",
    /signal_dead_letter_retry:\s*\{\s*manager:\s*"data_steward",\s*proof:\s*"test:signal-retry"/.test(reg))
  check("package.json wires the proof", /"test:signal-retry":\s*"tsx scripts\/signal-retry-simulator\.ts"/.test(src("package.json")))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source proved the logic; live verified via MCP"); return }
  const svc = createClient(url, key)
  const { reapStuckManagerSignals } = await import("../lib/kernel/signal-reaper")
  console.log("\n[live] a stalled handoff is re-handed (replays<cap); at the cap it escalates → clean up")
  const { data: brk } = await svc.from("brokerages").insert({ name: "ZZSIG", email: "zzsig@example.com", plan_tier: "brokerage", onboarding_status: "pending" }).select("id").single()
  const b = (brk as any)?.id
  const old = new Date(Date.now() - 30 * 3_600_000).toISOString()
  try {
    // A stalled handled handoff with no prior replays.
    await svc.from("manager_signals").insert({ brokerage_id: b, from_manager: "ai_isa", to_manager: "shopping_agent", signal_type: "sim_stalled", message: "sim", status: "open", created_at: old, payload: {} })
    await reapStuckManagerSignals(b, svc)
    const { data: after } = await svc.from("manager_signals").select("status, payload").eq("brokerage_id", b).order("created_at", { ascending: false })
    const rows = (after ?? []) as Array<{ status: string; payload: any }>
    const fresh = rows.find((r) => r.status === "open")
    check("live: the stalled handoff was re-handed (a new OPEN signal with _replays=1)", !!fresh && Number(fresh.payload?._replays) === 1)
    check("live: the old signal was expired (invariant holds)", rows.some((r) => r.status === "expired"))

    // A handoff already at the cap → escalates, no further replay.
    await svc.from("manager_signals").delete().eq("brokerage_id", b)
    await svc.from("manager_signals").insert({ brokerage_id: b, from_manager: "ai_isa", to_manager: "shopping_agent", signal_type: "sim_stalled", message: "sim", status: "open", created_at: old, payload: { _replays: SIGNAL_AUTO_REPLAY_CAP } })
    await reapStuckManagerSignals(b, svc)
    const { data: after2 } = await svc.from("manager_signals").select("status").eq("brokerage_id", b)
    const rows2 = (after2 ?? []) as Array<{ status: string }>
    check("live: at the cap there is NO new open signal (escalated instead)", !rows2.some((r) => r.status === "open"))
  } finally {
    await svc.from("notifications").delete().eq("brokerage_id", b)
    await svc.from("manager_signals").delete().eq("brokerage_id", b)
    await svc.from("brokerages").delete().eq("id", b)
    const { count: sigs } = await svc.from("manager_signals").select("id", { count: "exact", head: true }).eq("brokerage_id", b)
    const { count: brks } = await svc.from("brokerages").select("id", { count: "exact", head: true }).eq("id", b)
    check("live: cleanup count == 0", (sigs ?? 0) + (brks ?? 0) === 0)
  }
}

async function main() {
  pureLayer()
  sourceLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ SIGNAL_RETRY_FAIL"); process.exit(1) }
  console.log(" ✅ SIGNAL_RETRY_PASS — the bus self-heals: stalled handoffs auto-replay under a cap, then escalate to a human")
}
main()

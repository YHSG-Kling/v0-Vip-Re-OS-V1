#!/usr/bin/env tsx
/**
 * scripts/voice-billing-rail-simulator.ts   (npm run test:voice-billing-rail)
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE CANONICAL VOICE BILLING RAIL = usage_logs (VAPI retirement, steps B+C).
 * The Twilio-native lane wrote NO per-call billing row, so tenant voice minutes
 * were invisible to the phone card / P&L / quota (which the meter read from the
 * LEGACY vapi_voice_calls). This proves: (B) the Twilio status route now records a
 * usage_logs 'voice_call' row per completed call, idempotent on the CallSid; and
 * (C) loadVoiceUsage meters from usage_logs, not vapi_voice_calls.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { rollupVoiceUsage } from "../lib/voice/twilio-tenancy"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

console.log("\n── Step B: the Twilio status route bills into usage_logs, idempotently ──")
{
  const r = src("app/api/voice/twilio/status/route.ts")
  check("it inserts a usage_logs 'voice_call' row", /from\("usage_logs"\)\.insert\(\{[\s\S]*?usage_type: "voice_call"/.test(r))
  check("cost is the twilio_voice platform rate (not a VAPI vendor cost)", r.includes('estimatePlatformVendorCost("twilio_voice"'))
  check("it is idempotent on the CallSid (no double-bill on a re-posted callback)", /\.contains\("metadata", \{ call_sid: callSid \}\)/.test(r))
  check("it only bills a completed call with a real duration", /callStatus === "completed" && Number\.isFinite\(duration\) && duration > 0/.test(r))
}

console.log("\n── Step C: the meter reads usage_logs, not the legacy vapi_voice_calls ──")
{
  const t = src("lib/voice/twilio-tenancy.ts")
  check("loadVoiceUsage reads usage_logs voice_call rows", /from\("usage_logs"\)[\s\S]*?usage_type", "voice_call"/.test(t))
  check("loadVoiceUsage NO LONGER reads vapi_voice_calls", !/from\("vapi_voice_calls"\)/.test(t))
  check("units_used is mapped to minutes for the rollup", /minutes_billed: c\.units_used/.test(t))
}

console.log("\n── the pure rollup still folds minutes + cost correctly ──")
{
  const u = rollupVoiceUsage("2026-07", [{ minutes_billed: 3, cost_cents: 6 }, { minutes_billed: 2, cost_cents: 4 }], [{ is_active: true }])
  check("minutes sum", u.minutes === 5)
  check("call-cost sum", u.callCostCents === 10)
  check("active-number cost folds in", u.numberCostCents === 115 && u.totalCostCents === 125)
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — source + pure layers proved the rail"); return }
  const svc = createClient(url, key)
  console.log("\n[live] a seeded usage_logs voice_call is metered by loadVoiceUsage → cleanup")
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⊘ no brokerage — skipping"); return }
  const brokerageId = (brk as any).id
  const month = new Date().toISOString().slice(0, 7)
  const tag = "ZZBILLRAILTEST"
  try {
    await svc.from("usage_logs").insert({ brokerage_id: brokerageId, usage_type: "voice_call", units_used: 3, cost_cents: 6, recorded_at: new Date().toISOString(), metadata: { call_sid: tag, engine: "twilio" } })
    const { loadVoiceUsage } = await import("../lib/voice/twilio-tenancy")
    const usage = await loadVoiceUsage(svc as any, brokerageId, month)
    check("live: the meter counts the seeded 3 minutes", usage.minutes >= 3)
    check("live: the meter counts the seeded 6¢", usage.callCostCents >= 6)
  } finally {
    await svc.from("usage_logs").delete().eq("brokerage_id", brokerageId).eq("usage_type", "voice_call").contains("metadata", { call_sid: tag })
    const { count } = await svc.from("usage_logs").select("id", { count: "exact", head: true }).eq("brokerage_id", brokerageId).contains("metadata", { call_sid: tag })
    check("live: cleanup count == 0", (count ?? 0) === 0)
  }
}

async function main() {
  await liveLayer()
  console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)); console.log(" ❌ VOICE_BILLING_RAIL_FAIL"); process.exit(1) }
  console.log(" ✅ VOICE_BILLING_RAIL_PASS — usage_logs is the single voice billing rail; Twilio minutes are billed")
}
main()

#!/usr/bin/env tsx
/**
 * scripts/cadence-learning-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the SELF-TUNING CADENCE: the over-touch frequency cap learns each brokerage's rhythm
 * from real engagement — an engaged audience can hear from us a little more, a cooling audience
 * hears from us less — WITHIN HARD SAFETY BOUNDS (never below the floor, never above the ceiling;
 * the consent/opt-out/DNC/quiet-hours gates are separate and always apply).
 *
 * Layer 1 (pure, always runs): the bounded learned-policy matrix — the safety-critical core.
 * Layer 2 (live, SUPABASE_SERVICE_ROLE_KEY-gated): seeds an engaged brokerage + a contact AT the
 *   base cap, then proves evaluateDeconflict({learn:true}) LOOSENS (blocked→allowed) where the
 *   base policy blocks, driven by real touchpoint engagement. Seeds reverse-deleted. No mocks.
 *
 * Run: npx tsx scripts/cadence-learning-simulator.ts   (npm run test:cadence-learning)
 */
import { computeLearnedCadence, getEngagementSignals, MIN_SAMPLE, type ChannelPolicy } from "../lib/kernel/deconflict/cadence-policy"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function report() {
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Self-tuning cadence verified — learns the rhythm, never breaches the safety bounds.")
  console.log(" CADENCE_LEARNING_PASS")
}

const EMAIL: ChannelPolicy = { maxTouches: 3, windowDays: 14 } // mirrors DEFAULT_POLICY.email

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Self-tuning cadence simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · bounded learned-policy matrix]")
  check("thin sample → base policy (don't tune on noise)", computeLearnedCadence(EMAIL, { engagementRate: 0.9, sample: MIN_SAMPLE - 1 }).adjusted === false)
  const high = computeLearnedCadence(EMAIL, { engagementRate: 0.6, sample: 40 })
  check("high engagement → loosened to 5/14d", high.adjusted === true && high.policy.maxTouches === 5 && high.policy.windowDays === 14)
  const low = computeLearnedCadence(EMAIL, { engagementRate: 0.05, sample: 40 })
  check("low engagement → tightened to 2/14d (protect the relationship)", low.adjusted === true && low.policy.maxTouches === 2)
  check("normal band → base policy unchanged", computeLearnedCadence(EMAIL, { engagementRate: 0.3, sample: 40 }).adjusted === false)
  check("loosen NEVER exceeds the ceiling (≤ base+2 and ≤ 2× base)", high.policy.maxTouches <= Math.min(EMAIL.maxTouches * 2, EMAIL.maxTouches + 2))
  check("tighten NEVER drops below the floor (1)", computeLearnedCadence({ maxTouches: 1, windowDays: 7 }, { engagementRate: 0.02, sample: 40 }).policy.maxTouches === 1)
  const ceil1 = computeLearnedCadence({ maxTouches: 1, windowDays: 7 }, { engagementRate: 0.8, sample: 40 })
  check("a 1-cap channel loosens at most to 2", ceil1.policy.maxTouches === 2)
  check("windowDays is never changed by learning", high.policy.windowDays === EMAIL.windowDays && low.policy.windowDays === EMAIL.windowDays)

  console.log("\n[Layer 2 · live: an engaged brokerage's cap loosens (blocked→allowed)]")
  const hasCreds =
    !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    return report()
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { evaluateDeconflict } = await import("../lib/kernel/deconflict/index")
  const supabase = createServiceClient()

  const { data: brokerage } = await supabase.from("brokerages").select("id").limit(1).maybeSingle()
  const { data: agent } = brokerage
    ? await supabase.from("agents").select("id").eq("brokerage_id", (brokerage as any).id).limit(1).maybeSingle()
    : { data: null }
  if (!brokerage || !agent) { console.log("  ⏭  Skipped — need a real brokerage + agent."); return report() }
  const brokerageId = (brokerage as any).id
  const agentId = (agent as any).id
  const stamp = Date.now()
  const recent = new Date().toISOString()

  const mk = async (suffix: string) => {
    const { data } = await supabase.from("contacts").insert({
      brokerage_id: brokerageId, agent_id: agentId, first_name: "ZZCad", last_name: suffix,
      email: `zz-cad-${suffix}-${stamp}@example.com`, contact_type: "buyer", source: "test",
    }).select("id").single()
    return (data as any)?.id as string
  }
  const testId = await mk("test")     // sits exactly at the base cap (3 sent)
  const engagedId = await mk("engaged") // drives brokerage engagement high (30 opened)

  // Test contact: exactly 3 email touches (= base cap of 3 → blocked at base).
  for (let i = 0; i < 3; i++) {
    await supabase.from("marketing_campaign_touchpoints").insert({
      brokerage_id: brokerageId, contact_id: testId, channel: "email", status: "sent", sent_at: recent, source: "manual", campaign_id: null,
    }).then(() => {}, () => {})
  }
  // Engaged contact: 30 opened email touches → brokerage engagement ≈ 91% over a 33 sample → loosen to 5.
  for (let i = 0; i < 30; i++) {
    await supabase.from("marketing_campaign_touchpoints").insert({
      brokerage_id: brokerageId, contact_id: engagedId, channel: "email", status: "opened", sent_at: recent, opened_at: recent, source: "manual", campaign_id: null,
    }).then(() => {}, () => {})
  }

  try {
    const signals = await getEngagementSignals(supabase, brokerageId, "email", 30)
    check("engagement signal read from the live ledger (sample ≥ 20, high rate)", signals.sample >= 20 && signals.engagementRate >= 0.5, `sample=${signals.sample} rate=${signals.engagementRate.toFixed(2)}`)

    const base = await evaluateDeconflict({ brokerageId, channel: "email", contactId: testId, skipLog: true })
    check("base policy BLOCKS the contact at the cap (3 ≥ 3)", base.allowed === false, `allowed=${base.allowed} touches=${base.touchesInWindow} max=${base.policyMax}`)

    const learned = await evaluateDeconflict({ brokerageId, channel: "email", contactId: testId, skipLog: true, learn: true })
    check("self-tuning LOOSENS for the engaged audience (now allowed)", learned.allowed === true && learned.policyMax > base.policyMax, `allowed=${learned.allowed} max=${learned.policyMax}`)
  } finally {
    await supabase.from("marketing_campaign_touchpoints").delete().in("contact_id", [testId, engagedId])
    await supabase.from("contacts").delete().in("id", [testId, engagedId])
    const { count } = await supabase.from("contacts").select("id", { count: "exact", head: true }).in("id", [testId, engagedId])
    check("cleanup: seeds removed (count == 0)", (count ?? 0) === 0)
  }

  report()
}

main().catch((e) => { console.error(e); process.exit(1) })

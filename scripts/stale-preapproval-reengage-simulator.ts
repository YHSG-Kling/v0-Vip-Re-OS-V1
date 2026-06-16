#!/usr/bin/env tsx
/**
 * scripts/stale-preapproval-reengage-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves STALE PRE-APPROVAL RE-ENGAGE — verified white space (financing-pit-stop watches
 * pre_approval_expires_at ONLY for buyers in an ACTIVE deal; a quiet pre-contract buyer whose
 * pre-approval lapsed falls through every net). Pure window/quiet engine, honest (cash buyers
 * and in-deal buyers are skipped); the runner proposes ONE gated re-engage + routes expired
 * cases to the AI ISA for a re-qualification call.
 *
 * Layer 1 (pure): the verdict matrix (expired/expiring/not_eligible) + quiet gate + copy.
 * Layer 2 (live, gated): seed a real quiet buyer + an expired non-cash pre-approval profile →
 *   run re-engage → assert a gated buyer proposal + an ai_isa bus signal; a cash buyer is NOT
 *   re-engaged; re-run idempotent. Seeds cleaned up. No mocks.
 *
 * Run: npx tsx scripts/stale-preapproval-reengage-simulator.ts   (npm run test:stale-preapproval)
 */
import { planPreApprovalReengage, QUIET_DAYS } from "../lib/lead-pipeline/stale-preapproval-reengage"

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
  console.log(" ✅ Stale pre-approval re-engage verified — expired+quiet caught, cash/in-deal/active skipped, gated + ISA call.")
  console.log(" STALE_PREAPPROVAL_PASS")
  process.exit(0)
}

const NOW = "2026-06-16T12:00:00.000Z"
const dateDaysAway = (d: number) => new Date(new Date(NOW).getTime() + d * 86_400_000).toISOString().slice(0, 10)
const tsDaysAgo = (d: number) => new Date(new Date(NOW).getTime() - d * 86_400_000).toISOString()

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Stale pre-approval re-engage simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · verdict + quiet gate]")
  const expired = planPreApprovalReengage({ preApprovalExpiresAt: dateDaysAway(-10), now: NOW, lastContactedAt: tsDaysAgo(30), buyerName: "Sam" })
  check("expired + quiet → eligible, expired, recommend call", expired.eligible && expired.urgency === "expired" && expired.recommendCall)
  check("agent brief flags can't-make-a-competitive-offer", expired.agentBrief.toLowerCase().includes("competitive offer"))

  const expiring = planPreApprovalReengage({ preApprovalExpiresAt: dateDaysAway(7), now: NOW, lastContactedAt: tsDaysAgo(30) })
  check("expiring soon + quiet → eligible, expiring, no rush call", expiring.eligible && expiring.urgency === "expiring" && !expiring.recommendCall)

  // Quiet gate: recently contacted → their agent is on it, skip.
  const recent = planPreApprovalReengage({ preApprovalExpiresAt: dateDaysAway(-10), now: NOW, lastContactedAt: tsDaysAgo(3) })
  check(`contacted < ${QUIET_DAYS}d ago → not eligible (don't over-touch)`, !recent.eligible)
  // Never contacted → quiet by definition.
  check("never contacted → quiet → eligible", planPreApprovalReengage({ preApprovalExpiresAt: dateDaysAway(-5), now: NOW, lastContactedAt: null }).eligible)

  // HONEST skips.
  check("cash buyer → not eligible (no pre-approval)", !planPreApprovalReengage({ preApprovalExpiresAt: dateDaysAway(-5), now: NOW, isCashBuyer: true }).eligible)
  check("in active deal → not eligible (pit-stop owns it)", !planPreApprovalReengage({ preApprovalExpiresAt: dateDaysAway(-5), now: NOW, inActiveDeal: true, lastContactedAt: null }).eligible)
  check("healthy runway → not eligible", !planPreApprovalReengage({ preApprovalExpiresAt: dateDaysAway(60), now: NOW, lastContactedAt: null }).eligible)
  check("no expiry on file → not eligible", !planPreApprovalReengage({ preApprovalExpiresAt: null, now: NOW }).eligible)

  console.log("\n[Layer 2 · live: an expired-pre-approval quiet buyer is re-engaged + routed, idempotently]")
  const hasCreds =
    !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    return report()
  }
  const { createServiceClient } = await import("../lib/supabase/service")
  const { runStalePreApprovalReengage } = await import("../lib/lead-pipeline/stale-preapproval-reengage-runner")
  const svc = createServiceClient()
  const { data: brokerage } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brokerage) { console.log("  ⏭  Skipped — need a real brokerage."); return report() }
  const brokerageId = (brokerage as any).id
  const uuid = () => (globalThis.crypto ?? require("node:crypto").webcrypto).randomUUID()
  const stampGen = async (req: { goal: string }) => ({ subject: "ZZGEN", body: `ZZGEN ${req.goal}` })

  const buyerId = uuid()
  const cashId = uuid()
  const profileId = uuid()
  const cashProfileId = uuid()
  try {
    await svc.from("contacts").insert({ id: buyerId, brokerage_id: brokerageId, first_name: "ZZ", last_name: "Quiet", contact_type: "buyer", last_contacted_at: tsDaysAgo(40) })
    await svc.from("contacts").insert({ id: cashId, brokerage_id: brokerageId, first_name: "ZZ", last_name: "Cash", contact_type: "buyer", last_contacted_at: tsDaysAgo(40) })
    await svc.from("buyer_financial_profiles").insert({ id: profileId, brokerage_id: brokerageId, contact_id: buyerId, is_cash_buyer: false, pre_approval_expires_at: dateDaysAway(-10) })
    // Cash buyer with an expired date → must NOT be re-engaged.
    await svc.from("buyer_financial_profiles").insert({ id: cashProfileId, brokerage_id: brokerageId, contact_id: cashId, is_cash_buyer: true, pre_approval_expires_at: dateDaysAway(-10) })

    const r1 = await runStalePreApprovalReengage({ brokerageId, now: NOW, copyGenerator: stampGen }, svc)
    check("the expired+quiet buyer is re-engaged + call routed", r1.reengaged >= 1 && r1.callsRouted >= 1, JSON.stringify(r1))

    const { count: msgCount } = await svc.from("agent_client_messages").select("id", { count: "exact", head: true })
      .eq("entity_id", buyerId).eq("audience", "buyer")
    check("a gated buyer re-engagement proposal was created", (msgCount ?? 0) >= 1)
    const { count: cashMsg } = await svc.from("agent_client_messages").select("id", { count: "exact", head: true }).eq("entity_id", cashId)
    check("the CASH buyer was NOT re-engaged (honest)", (cashMsg ?? 0) === 0)
    const { count: sigCount } = await svc.from("manager_signals").select("id", { count: "exact", head: true })
      .eq("entity_id", buyerId).eq("signal_type", "stale_preapproval_reengage")
    check("an ai_isa re-qualification bus signal was published", (sigCount ?? 0) >= 1)

    const r2 = await runStalePreApprovalReengage({ brokerageId, now: NOW, copyGenerator: stampGen }, svc)
    check("re-run is idempotent (no duplicate re-engage)", r2.reengaged === 0)
  } finally {
    await svc.from("manager_signals").delete().eq("entity_id", buyerId).then(() => {}, () => {})
    await svc.from("agent_client_messages").delete().in("entity_id", [buyerId, cashId]).then(() => {}, () => {})
    await svc.from("buyer_financial_profiles").delete().in("id", [profileId, cashProfileId]).then(() => {}, () => {})
    await svc.from("contacts").delete().in("id", [buyerId, cashId]).then(() => {}, () => {})
    const { count } = await svc.from("buyer_financial_profiles").select("id", { count: "exact", head: true }).in("id", [profileId, cashProfileId])
    check("cleanup: seeded profiles removed (count == 0)", (count ?? 0) === 0)
  }
  report()
}

main().catch((e) => { console.error(e); process.exit(1) })

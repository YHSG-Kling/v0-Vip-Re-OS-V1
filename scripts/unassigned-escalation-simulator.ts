#!/usr/bin/env tsx
/**
 * scripts/unassigned-escalation-simulator.ts   (npm run test:unassigned-escalation)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves a qualified lead that can't be assigned reaches a HUMAN — no silent orphan.
 *
 * When the assignment cascade finds no eligible agent the qualified+consented lead was
 * left ownerless and invisible. escalateUnassignedQualifiedLead now alerts the brokerage
 * broker/admins (activate an agent / fix the rules), falling through to platform staff if
 * the brokerage has no admin, deduped to one alert per lead per day.
 *
 * Layer 1 (pure): missing ids ⇒ no escalation.
 * Layer 2 (live, gated): broker present ⇒ broker alerted; brokerage with no admin ⇒
 *   platform staff alerted; re-running is deduped. Reverse-delete; cleanup == 0.
 */
import { randomUUID } from "node:crypto"
import { createRequire } from "module"
const _require = createRequire(import.meta.url)
try {
  const soPath = _require.resolve("server-only")
  _require.cache[soPath] = { id: soPath, filename: soPath, loaded: true, exports: {} } as any
} catch { /* nothing to shim */ }

import { escalateUnassignedQualifiedLead, UNASSIGNED_LEAD_NOTIFICATION_TYPE } from "../lib/lead-assignment/unassigned-escalation"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

async function pureLayer(): Promise<void> {
  console.log("\n[Layer 1 · guards]")
  const r = await escalateUnassignedQualifiedLead({} as any, { leadId: "", brokerageId: "" })
  check("missing lead/brokerage ⇒ no escalation, no throw", r.escalated === false && r.target === "none")
}

async function liveLayer(): Promise<void> {
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live]  ⊘ skipped (no SUPABASE creds) — pure layer proved the guards")
    return
  }
  console.log("\n[Layer 2 · live — broker alerted → dedup; no-admin brokerage → platform fallback]")
  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const tag = `unassign-sim-${randomUUID().slice(0, 8)}`
  const brokerageA = randomUUID()  // has a broker
  const brokerageB = randomUUID()  // has NO admin
  const brokerUserId = randomUUID()
  const platformUserId = randomUUID()
  const leadA = randomUUID()
  const leadB = randomUUID()
  try {
    await svc.from("brokerages").insert([{ id: brokerageA, name: `${tag} A` }, { id: brokerageB, name: `${tag} B` }])
    await svc.from("users").insert([
      { id: brokerUserId, brokerage_id: brokerageA, email: `${tag}-broker@example.com`, user_type: "broker" },
      { id: platformUserId, email: `${tag}-super@example.com`, user_type: "superadmin" },
    ])

    // Brokerage A has a broker → broker is alerted.
    const rA = await escalateUnassignedQualifiedLead(svc, { leadId: leadA, brokerageId: brokerageA, reason: "no eligible agent", score: 82 })
    check("brokerage with a broker ⇒ escalates to brokerage_admin", rA.escalated === true && rA.target === "brokerage_admin")
    const { data: nA } = await svc.from("notifications").select("user_id, priority")
      .eq("type", UNASSIGNED_LEAD_NOTIFICATION_TYPE).eq("entity_id", leadA).maybeSingle()
    check("the broker received a HIGH unassigned-lead alert", !!nA && (nA as any).user_id === brokerUserId && (nA as any).priority === "high")

    // Re-running for the same lead is deduped.
    const rA2 = await escalateUnassignedQualifiedLead(svc, { leadId: leadA, brokerageId: brokerageA, reason: "no eligible agent", score: 82 })
    check("re-escalating the same lead is deduped (one alert/day)", rA2.escalated === false && rA2.reason === "already escalated today")

    // Brokerage B has NO admin → falls through to platform staff.
    const rB = await escalateUnassignedQualifiedLead(svc, { leadId: leadB, brokerageId: brokerageB, reason: "no agents in brokerage", score: 70 })
    check("brokerage with no admin ⇒ falls through to platform", rB.escalated === true && rB.target === "platform")
    const { data: nB } = await svc.from("notifications").select("user_id")
      .eq("type", UNASSIGNED_LEAD_NOTIFICATION_TYPE).eq("entity_id", leadB).maybeSingle()
    check("platform staff received the no-admin escalation", !!nB && (nB as any).user_id === platformUserId)
  } finally {
    await svc.from("notifications").delete().in("entity_id", [leadA, leadB])
    await svc.from("users").delete().in("id", [brokerUserId, platformUserId])
    await svc.from("brokerages").delete().in("id", [brokerageA, brokerageB])
    const { count } = await svc.from("notifications").select("id", { count: "exact", head: true }).in("entity_id", [leadA, leadB])
    check("cleanup complete (no test rows remain)", (count ?? 0) === 0)
  }
}

async function main(): Promise<void> {
  await pureLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ UNASSIGNED_ESCALATION_FAIL"); process.exit(1) }
  console.log(" ✅ UNASSIGNED_ESCALATION_PASS — a qualified lead with no agent reaches a human (cascade top rungs closed)")
}

main().catch((e) => { console.error(e); process.exit(1) })

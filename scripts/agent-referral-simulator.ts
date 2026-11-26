#!/usr/bin/env tsx
/**
 * scripts/agent-referral-simulator.ts   (npm run test:agent-referral)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves AGENT-TO-AGENT CLIENT REFERRALS with the money. An agent refers a relocating client to another
 * agent in the same brokerage; when that deal closes the referring agent earns a fee, booked on the
 * canonical commission_distributions rail (distribution_type 'referral'). Directory feeds the map.
 *
 * PURE:   computeReferralFee (deal commission × fee %, clamped, honest $0).
 * SOURCE: createAgentReferral writes an agent→agent referral; the WATERFALL (stage 03b, wave 143 lane 143C) books the fee
 *         as a conserved deduction on the canonical rail; the referral-closer no longer books anything;
 *         the directory lists same-brokerage agents by location; the UI is wired.
 * LIVE (creds-gated): create a referral → close the deal → the closer closes the referral and books NO distribution
 *         (the fee is the waterfall's: proved end to end, in memory, by test:agreement-waterfall section D) → clean up == 0.
 *
 * WAVE 143 (lane 143C) - THIS PROOF PINNED A WAYPOINT. It asserted the referral-closer inserts the 'referral' distribution
 * after the close. That row was deducted from nobody and sat outside the conservation identity, so the rule is re-asserted
 * on the survivor: ONE writer of distribution_type 'referral' (waterfall stage 03b), fee base = the adjusted gross, one
 * referral pays one deal (referrals.transaction_id compare-and-swap in stage 11).
 */
import { readFileSync } from "node:fs"
import { stripComments } from "./strip-comments"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { computeReferralFee } from "../lib/referrals/agent-referral"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

function pureLayer() {
  console.log("\n[computeReferralFee · pure]")
  check("25% of a $10,000 commission → $2,500", computeReferralFee(10000, 25) === 2500)
  check("$0 commission earns $0 (honest)", computeReferralFee(0, 25) === 0)
  check("null inputs → 0, never NaN", computeReferralFee(null, null) === 0)
  check("fee clamped to [0,100]", computeReferralFee(10000, 250) === 10000 && computeReferralFee(10000, -5) === 0)
  check("cents rounded", computeReferralFee(3333.33, 25) === 833.33)
}

function sourceLayer() {
  console.log("\n[wiring — referral record, close-credit, directory, UI]")
  const lib = src("lib/referrals/agent-referral.ts")
  check("createAgentReferral writes an agent→agent referral (referring + receiving)", /referring_agent_id: input\.referringAgentId/.test(lib) && /agent_id: input\.receivingAgentId/.test(lib))
  check("can't refer to yourself", /referringAgentId === input\.receivingAgentId/.test(lib))
  check("directory lists same-brokerage agents with location (for the map)", /listReferralAgents[\s\S]*?location_id[\s\S]*?locations:location_id/.test(lib))
  const closer = src("lib/agents/referral-closer.ts")
  const stage = src("lib/commission/waterfall/03b-referral-deduction.ts")
  const BOOKS = /from\(\s*["']commission_distributions["']\s*\)\s*\.insert\(/
  check("the WATERFALL books the fee to the referring agent on the canonical rail (distribution_type 'referral', agent = referring_agent_id)", /distribution_type:\s*'referral'/.test(stage) && /agent_id:\s*pick\.referral\.referring_agent_id/.test(stage))
  check("the referral-closer no longer inserts a distribution (ONE writer of the 'referral' type)", !BOOKS.test(stripComments(closer)) && BOOKS.test(`await supabase.from("commission_distributions").insert({})`))
  check("one referral pays one deal: the stage reads the link and stage 11 claims it compare-and-swap (WHERE transaction_id IS NULL)", /transaction_id/.test(stage) && /\.is\('transaction_id', null\)/.test(src("lib/commission/waterfall/11-validate-persist.ts")))
  const client = src("app/dashboard/agent/referral-network/referral-network-client.tsx")
  check("the UI shows the directory + earnings + a working refer form", /Referral network/.test(client) && /createAgentReferralAction/.test(client) && /Referral income earned/.test(client))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the logic"); return }
  const svc = createClient(url, key)
  console.log("\n[live] create referral → close deal → referring agent credited → idempotent → clean up")
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⊘ no brokerage — skipping"); return }
  const brokerageId = (brk as any).id
  const { data: ags } = await svc.from("agents").select("id").eq("brokerage_id", brokerageId).limit(2)
  if (!ags || ags.length < 2) { console.log("  ⊘ need 2 agents — skipping"); return }
  const referring = (ags as any[])[0].id, receiving = (ags as any[])[1].id
  const { data: contact } = await svc.from("contacts").select("id").eq("brokerage_id", brokerageId).limit(1).maybeSingle()
  const { data: txn } = await svc.from("transactions").select("id").eq("brokerage_id", brokerageId).limit(1).maybeSingle()
  if (!contact || !txn) { console.log("  ⊘ no contact/transaction — skipping"); return }
  const contactId = (contact as any).id, txnId = (txn as any).id
  const cleanup: Array<{ table: string; id: string }> = []
  // Snapshot the transaction so we can restore it.
  const { data: origTxn } = await svc.from("transactions").select("status, commission_amount, contact_id").eq("id", txnId).single()
  try {
    const { createAgentReferral } = await import("../lib/referrals/agent-referral")
    const created = await createAgentReferral(svc as any, { brokerageId, referringAgentId: referring, receivingAgentId: receiving, contactId, feePct: 25 })
    check("live: created the agent-to-agent referral", created.ok && !!created.referralId)
    if (created.referralId) cleanup.push({ table: "referrals", id: created.referralId })

    // Make the transaction a closed deal on this contact with a known commission.
    await svc.from("transactions").update({ status: "closed", commission_amount: 8000, contact_id: contactId }).eq("id", txnId)

    const { closeReferralOnDealClose } = await import("../lib/agents/referral-closer")
    await closeReferralOnDealClose(svc as any, { transactionId: txnId, brokerageId })

    // WAVE 143: closing the referral books NO distribution - the fee is the waterfall's (conserved, off the top).
    const { count: closerRows } = await svc.from("commission_distributions").select("id", { count: "exact", head: true })
      .eq("transaction_id", txnId).eq("agent_id", referring).eq("distribution_type", "referral").is("commission_id", null)
    check("live: the referral-closer booked NO free-standing 'referral' distribution", (closerRows ?? 0) === 0)
  } finally {
    // Restore the transaction, then delete seeded rows.
    if (origTxn) await svc.from("transactions").update({ status: (origTxn as any).status, commission_amount: (origTxn as any).commission_amount, contact_id: (origTxn as any).contact_id }).eq("id", txnId)
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
  if (fail > 0) { console.log(" ❌ AGENT_REFERRAL_FAIL"); process.exit(1) }
  console.log(" ✅ AGENT_REFERRAL_PASS — agent-to-agent referrals tracked; the fee is the waterfall's conserved deduction to the referrer")
}
main()

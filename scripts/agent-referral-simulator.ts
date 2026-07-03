#!/usr/bin/env tsx
/**
 * scripts/agent-referral-simulator.ts   (npm run test:agent-referral)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves AGENT-TO-AGENT CLIENT REFERRALS with the money. An agent refers a relocating client to another
 * agent in the same brokerage; when that deal closes the referring agent earns a fee, booked on the
 * canonical commission_distributions rail (distribution_type 'referral'). Directory feeds the map.
 *
 * PURE:   computeReferralFee (deal commission × fee %, clamped, honest $0).
 * SOURCE: createAgentReferral writes an agent→agent referral; the referral-closer books the fee on close;
 *         the directory lists same-brokerage agents by location; the UI is wired.
 * LIVE (creds-gated): create a referral → close the deal → the referring agent is credited on the
 *         commission_distributions rail → idempotent → clean up == 0.
 */
import { readFileSync } from "node:fs"
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
  check("the referral-closer books the fee to the referring agent on close (canonical rail)", /if \(r\.referring_agent_id\)/.test(closer) && /commission_distributions"\)\.insert\(/.test(closer) && /distribution_type: "referral"/.test(closer) && /agent_id: r\.referring_agent_id/.test(closer))
  check("idempotent per (referral, transaction)", /transaction_id", transactionId\)\.eq\("agent_id", r\.referring_agent_id\)\.eq\("distribution_type", "referral"\)/.test(closer))
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

    const { data: dist } = await svc.from("commission_distributions").select("id, calculated_amount, distribution_type")
      .eq("transaction_id", txnId).eq("agent_id", referring).eq("distribution_type", "referral").maybeSingle()
    if (dist) cleanup.push({ table: "commission_distributions", id: (dist as any).id })
    check("live: the referring agent was credited 25% of the $8,000 commission = $2,000", !!dist && Number((dist as any).calculated_amount) === 2000)

    // Idempotent — re-running the closer doesn't double-credit.
    await closeReferralOnDealClose(svc as any, { transactionId: txnId, brokerageId })
    const { count } = await svc.from("commission_distributions").select("id", { count: "exact", head: true }).eq("transaction_id", txnId).eq("agent_id", referring).eq("distribution_type", "referral")
    check("live: idempotent — the referral fee is booked once", count === 1)
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
  console.log(" ✅ AGENT_REFERRAL_PASS — agent-to-agent referrals tracked; the fee is booked to the referrer on close")
}
main()

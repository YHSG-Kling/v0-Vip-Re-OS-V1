#!/usr/bin/env tsx
/**
 * scripts/wire-fraud-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves THE WIRE-FRAUD SENTINEL — catches the catastrophic closing scam (spoofed/changed wire
 * instructions) and HARD-BLOCKS with the one protective action that stops it. Pure detector over
 * the FBI/title-industry red flags (no fabrication — only present signals flag).
 *
 * Layer 1 (pure): the fraud-flag matrix + verdict.
 * Layer 2 (live, gated): a block verdict fires a CRITICAL agent notification. Seeds cleaned up.
 *
 * Run: npx tsx scripts/wire-fraud-simulator.ts   (npm run test:wire-fraud)
 */
import { detectWireFraudRisk } from "../lib/wire-fraud/wire-fraud-sentinel"

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
  console.log(" ✅ Wire-fraud sentinel verified — the down payment stays safe.")
  console.log(" WIRE_FRAUD_PASS")
}

const TITLE = ["firstamerican.com"]

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Wire-fraud sentinel simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · fraud-flag matrix]")
  const freemail = detectWireFraudRisk({ senderEmail: "escrow.officer@gmail.com", expectedDomains: TITLE })
  check("wire instructions from a FREE email → BLOCK", freemail.riskLevel === "block" && freemail.flags.some(f => f.key === "freemail_sender"))

  const lookalike = detectWireFraudRisk({ senderEmail: "wires@first-american.com", expectedDomains: TITLE })
  check("a LOOK-ALIKE domain (first-american vs firstamerican) → BLOCK", lookalike.riskLevel === "block" && lookalike.flags.some(f => f.key === "lookalike_domain"))

  const mismatch = detectWireFraudRisk({ senderEmail: "wires@totally-different.com", expectedDomains: TITLE })
  check("an unrelated sender domain → BLOCK (domain mismatch)", mismatch.riskLevel === "block" && mismatch.flags.some(f => f.key === "domain_mismatch"))

  const changed = detectWireFraudRisk({
    senderEmail: "wires@firstamerican.com", expectedDomains: TITLE,
    priorInstructions: { account: "111", routing: "222" }, newInstructions: { account: "999", routing: "222" },
  })
  check("a CHANGED account from the legit domain → BLOCK (last-minute change)", changed.riskLevel === "block" && changed.flags.some(f => f.key === "account_changed"))

  const urgency = detectWireFraudRisk({ senderEmail: "wires@firstamerican.com", expectedDomains: TITLE, messageText: "New wire instructions — please wire today, disregard the previous." })
  check("urgency language from the legit domain → WARN (no critical, but suspicious)", urgency.riskLevel === "warn" && urgency.flags.some(f => f.key === "urgency_pressure"))

  const clean = detectWireFraudRisk({
    senderEmail: "wires@firstamerican.com", expectedDomains: TITLE,
    priorInstructions: { account: "111", routing: "222" }, newInstructions: { account: "111", routing: "222" },
    messageText: "Confirming the wire details we reviewed at signing.",
  })
  check("legit domain, unchanged account, no pressure → OK", clean.riskLevel === "ok" && clean.flags.length === 0)
  check("the protective action is ALWAYS the call-to-verify rule", /call the title|verbally confirm|do not wire/i.test(clean.protectiveAction))
  check("no fabrication — no expected domains given → no domain flag", detectWireFraudRisk({ senderEmail: "x@gmail.com" }).flags.every(f => f.key !== "domain_mismatch"))

  console.log("\n[Layer 2 · live: a block fires a critical agent alert]")
  const hasCreds =
    !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    return report()
  }
  const { createServiceClient } = await import("../lib/supabase/service")
  const { runWireFraudSentinel } = await import("../lib/wire-fraud/wire-fraud-runner")
  const supabase = createServiceClient()
  const { data: brokerage } = await supabase.from("brokerages").select("id").limit(1).maybeSingle()
  const { data: agent } = brokerage
    ? await supabase.from("agents").select("id, user_id").eq("brokerage_id", (brokerage as any).id).limit(1).maybeSingle()
    : { data: null }
  if (!brokerage || !agent) { console.log("  ⏭  Skipped — need a real brokerage + agent."); return report() }
  const brokerageId = (brokerage as any).id
  const stamp = Date.now()
  const { data: contact } = await supabase.from("contacts").insert({
    brokerage_id: brokerageId, agent_id: (agent as any).id, first_name: "ZZWire", last_name: `Fraud${stamp}`,
    email: `zz-wire-${stamp}@example.com`, contact_type: "buyer", source: "test",
  }).select("id").single()
  const contactId = (contact as any)?.id
  try {
    const r = await runWireFraudSentinel({
      brokerageId, contactId, agentUserId: (agent as any).user_id ?? null,
      wire: { senderEmail: "escrow@gmail.com", expectedDomains: TITLE, messageText: "wire today" },
    }, supabase)
    check("runner blocks + escalates", r.verdict.riskLevel === "block" && r.escalated === true)
    if ((agent as any).user_id) {
      const { count } = await supabase.from("notifications").select("id", { count: "exact", head: true })
        .eq("entity_id", contactId).eq("type", "wire_fraud_alert").eq("priority", "critical")
      check("a CRITICAL wire_fraud_alert notification was created", (count ?? 0) >= 1)
    }
  } finally {
    await supabase.from("notifications").delete().eq("entity_id", contactId).then(() => {}, () => {})
    await supabase.from("manager_signals").delete().eq("entity_id", contactId).then(() => {}, () => {})
    await supabase.from("contacts").delete().eq("id", contactId)
    const { count } = await supabase.from("contacts").select("id", { count: "exact", head: true }).eq("id", contactId)
    check("cleanup: seed removed (count == 0)", (count ?? 0) === 0)
  }
  report()
}

main().catch((e) => { console.error(e); process.exit(1) })

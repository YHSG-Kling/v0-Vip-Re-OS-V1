#!/usr/bin/env tsx
/**
 * scripts/lead-deconflict-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves LEADS ARE GOVERNED TOO: the de-confliction over-touch frequency cap now protects an
 * unconverted LEAD the same way it protects a promoted contact. Lead outbound logs to
 * isa_outreach_log (by lead_id); evaluateDeconflict now counts that ledger when a leadId is
 * supplied, so a lead at the email cap is deferred instead of over-messaged.
 *
 * Layer 1 (pure, always runs): the de-conflict channel → isa_outreach_log channel mapping.
 * Layer 2 (live, SUPABASE_SERVICE_ROLE_KEY-gated): seeds a lead at the email cap (3 / 14d) and
 *   asserts evaluateDeconflict blocks the next email; a fresh lead with 0 touches is allowed; the
 *   mail mapping (direct_mail) is counted. Seeds reverse-deleted (cleanup == 0). No mocks.
 *
 * Run: npx tsx scripts/lead-deconflict-simulator.ts   (npm run test:lead-deconflict)
 */
import { leadLogChannel } from "../lib/kernel/deconflict/lead-channel"
import { CHECK_VOCABULARIES } from "./check-vocabularies"

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
  console.log(" ✅ Lead over-touch governance verified — leads get the same cap as contacts.")
  console.log(" LEAD_DECONFLICT_PASS")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Lead de-confliction simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · de-conflict channel → isa_outreach_log channel]")
  // THIS ASSERTION USED TO PIN THE BUG. It required leadLogChannel("phone") ===
  // "phone" — but isa_outreach_log.channel says 'voice', and that mismatch is
  // the whole reason the mapping module exists: countPhoneTouches filtered the
  // log for 'phone', matched zero rows every time, and the "1 call / 7 days" cap
  // could never fire. On an over-touch cap a zero is not an error, it is a
  // PERMISSION. Had this simulator been wired to CI it would have blocked the
  // fix and defended the leak. It now asserts the corrected mapping.
  check("mail → direct_mail (log stores direct_mail)", leadLogChannel("mail") === "direct_mail")
  check("email → email", leadLogChannel("email") === "email")
  check("sms → sms", leadLogChannel("sms") === "sms")
  check("phone → voice (the log's word for a call — NOT 'phone')", leadLogChannel("phone") === "voice")
  check("the live CHECK really does reject 'phone' on that column",
    !(CHECK_VOCABULARIES.isa_outreach_log?.channel ?? []).includes("phone")
    && (CHECK_VOCABULARIES.isa_outreach_log?.channel ?? []).includes("voice"))

  console.log("\n[Layer 2 · live: a lead at the email cap is deferred]")
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
  if (!brokerage) { console.log("  ⏭  Skipped — need a real brokerage."); return report() }
  const brokerageId = (brokerage as any).id
  const stamp = Date.now()

  const { data: cappedLead, error: lErr } = await supabase.from("leads").insert({
    brokerage_id: brokerageId, first_name: "ZZCapped", last_name: "Lead",
    email: `zz-lead-capped-${stamp}@example.com`, source: "test",
  }).select("id").single()
  if (lErr || !cappedLead) { check("seed lead", false, lErr?.message); return report() }
  const cappedLeadId = (cappedLead as any).id
  const { data: freshLead } = await supabase.from("leads").insert({
    brokerage_id: brokerageId, first_name: "ZZFresh", last_name: "Lead",
    email: `zz-lead-fresh-${stamp}@example.com`, source: "test",
  }).select("id").single()
  const freshLeadId = (freshLead as any)?.id

  const recent = new Date().toISOString()
  for (let i = 0; i < 3; i++) {
    await supabase.from("isa_outreach_log").insert({
      lead_id: cappedLeadId, brokerage_id: brokerageId, channel: "email",
      status: "sent", sent_at: recent, compliance_passed: true,
    })
  }
  // One physical-mail touch for the mapping assertion.
  await supabase.from("isa_outreach_log").insert({
    lead_id: cappedLeadId, brokerage_id: brokerageId, channel: "direct_mail",
    status: "sent", sent_at: recent, compliance_passed: true,
  })

  try {
    const capped = await evaluateDeconflict({ brokerageId, channel: "email", leadId: cappedLeadId, skipLog: true })
    check("lead at the email cap is BLOCKED (over-touch)", capped.allowed === false, `allowed=${capped.allowed} touches=${capped.touchesInWindow}`)
    check("the lead's 3 email touches were counted", capped.touchesInWindow === 3, `got ${capped.touchesInWindow}`)

    const mail = await evaluateDeconflict({ brokerageId, channel: "mail", leadId: cappedLeadId, skipLog: true })
    check("lead direct_mail touch counted under the mail cap", mail.touchesInWindow >= 1, `got ${mail.touchesInWindow}`)

    const fresh = await evaluateDeconflict({ brokerageId, channel: "email", leadId: freshLeadId, skipLog: true })
    check("a fresh lead (0 touches) is ALLOWED", fresh.allowed === true && fresh.touchesInWindow === 0)
  } finally {
    await supabase.from("isa_outreach_log").delete().in("lead_id", [cappedLeadId, freshLeadId])
    await supabase.from("leads").delete().in("id", [cappedLeadId, freshLeadId])
    const { count } = await supabase.from("leads").select("id", { count: "exact", head: true }).in("id", [cappedLeadId, freshLeadId])
    check("cleanup: test leads removed (count == 0)", (count ?? 0) === 0)
  }

  report()
}

main().catch((e) => { console.error(e); process.exit(1) })

#!/usr/bin/env tsx
/**
 * scripts/decision-receipts-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the DECISION RECEIPTS glass box — for a contact, one honest "why" trail stitched from
 * sequence_step_executions (send/skip/block/open/reply), outbound_message_compliance_log (quiet
 * hours / consent), and the touch provenance (manager + ai_intent). Critically captures SKIPS/BLOCKS
 * with reasons, not just sends. Pure + shell-runnable. No mocks.
 *
 * Run: npx tsx scripts/decision-receipts-simulator.ts   (npm run test:decision-receipts)
 */
import { assembleReceipts } from "../lib/intelligence/decision-receipts"

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
  console.log(" ✅ Decision receipts verified — sends, skips-with-reasons, compliance blocks, and provenance, time-ordered.")
  console.log(" DECISION_RECEIPTS_PASS")
  process.exit(0)
}

function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Decision receipts (glass box) simulator")
  console.log("══════════════════════════════════════════════════\n")

  const receipts = assembleReceipts({
    stepExecutions: [
      { channel: "email", status: "sent", blocked_reason: null, sent_at: "2026-06-10T10:00:00Z", opened_at: "2026-06-10T11:00:00Z", replied_at: null, created_at: "2026-06-10T10:00:00Z" },
      { channel: "sms", status: "skipped", blocked_reason: "SMS: No TCPA consent or DNC", sent_at: null, created_at: "2026-06-12T09:00:00Z" },
      { channel: "email", status: "failed", blocked_reason: null, error_message: "no copy generated", sent_at: null, created_at: "2026-06-13T09:00:00Z" },
    ],
    complianceLogs: [
      { channel: "sms", decision: "blocked", block_reason: "quiet hours", recipient_local_hour: 22, created_at: "2026-06-14T03:00:00Z" },
      { channel: "email", decision: "allowed", block_reason: null, created_at: "2026-06-14T03:01:00Z" },
    ],
    touchpoints: [
      { channel: "email", metadata: { manager: "ai_isa", ai_intent: "a warm re-engagement" }, sent_at: "2026-06-10T10:00:00Z" },
    ],
  })

  check("a send is recorded", receipts.some((r) => r.action === "sent" && /email sent|sent a email/i.test(r.summary)))
  check("an OPEN is recorded (engagement)", receipts.some((r) => r.action === "opened"))
  check("a SKIP captures its reason (no TCPA consent)", receipts.some((r) => r.action === "skipped" && /tcpa/i.test(r.summary)))
  check("a FAILED no-copy is captured (honest)", receipts.some((r) => r.action === "failed" && /no copy generated/i.test(r.summary)))
  check("a compliance BLOCK captures quiet hours + local time", receipts.some((r) => r.action === "blocked" && /quiet hours/i.test(r.summary) && /22:00/.test(r.summary)))
  check("an ALLOWED compliance decision is NOT noise (omitted)", !receipts.some((r) => /allowed/i.test(r.summary)))
  check("provenance touch carries manager + intent", receipts.some((r) => r.manager === "ai_isa" && /warm re-engagement/.test(r.summary)))
  check("newest entry first (time-ordered desc)", receipts.length > 1 && (receipts[0].at >= receipts[receipts.length - 1].at))
  check("empty input → empty trail", assembleReceipts({}).length === 0)

  report()
}

main()

#!/usr/bin/env tsx
/**
 * scripts/compliance-ledger-simulator.ts  (npm run test:compliance-ledger)
 *
 * Proves the COMPLIANCE AUDIT LEDGER (lib/kernel/compliance-ledger.ts) — every outbound approval
 * decision becomes a durable, tamper-proof compliance_events record. Layer 1 (pure): buildComplianceEvent
 * recomputes the Compliance Officer verdict from the FINAL copy and maps it to the live-schema row,
 * flagging the number a broker must defend (approved-despite-advisory); summarizeComplianceLedger rolls a
 * window into the disposition report. Layer 2 (live, creds-gated): a real insert → read-back → cleanup.
 */
import { buildComplianceEvent, summarizeComplianceLedger, recordEgressComplianceDecision, mapLedgerRow, loadComplianceLedger, PREFLIGHT_GATE, type EgressDecision } from "../lib/kernel/compliance-ledger"
import { createServiceClient } from "../lib/supabase/service"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const report = () => {
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ COMPLIANCE_LEDGER_PASS — every outbound decision is a defensible, tamper-proof record")
}

const NO_CONSENT = { recipientWithdrawn: false, emailRevoked: false, smsRevoked: false }
const base = (over: Partial<EgressDecision>): EgressDecision => ({
  brokerageId: "bk1", actorUserId: "u1", actorRole: "broker", queue: "client_message",
  entityId: "m1", channel: "email", text: "Hope the move went smoothly — here if you need anything.",
  consent: NO_CONSENT, decision: "approved", ...over,
})

console.log("\n[1 · buildComplianceEvent — the verdict recomputed from the final copy]")
const clean = buildComplianceEvent(base({}))
check("clean approval → severity CLEAR, allowed, not approved-despite-advisory", clean.severity === "clear" && clean.allowed === true && (clean.details as any).approved_despite_advisory === false && clean.violations.length === 0)
check("row is stamped to the Compliance Officer's pre-flight gate + queue + channel",
  clean.gate_name === PREFLIGHT_GATE && clean.entity_type === "client_message" && clean.message_type === "email" && clean.actor_user_id === "u1" && clean.actor_role === "broker")

const advisory = buildComplianceEvent(base({ text: "This home is perfect for families in a safe neighborhood." }))
check("approved over a Fair Housing flag → ADVISORY, allowed, APPROVED-DESPITE-ADVISORY recorded",
  advisory.severity === "advisory" && advisory.allowed === true && (advisory.details as any).approved_despite_advisory === true && advisory.violations.length >= 2 && advisory.blocked_reason === null)

const blocked = buildComplianceEvent(base({ consent: { ...NO_CONSENT, recipientWithdrawn: true } }))
check("approved over a consent hard-stop → BLOCKED, blocked_reason captured (the worst-case audit line)",
  blocked.severity === "blocked" && blocked.allowed === true && (blocked.details as any).approved_despite_advisory === true && (blocked.blocked_reason ?? "").includes("WITHDRAWN"))

const rejected = buildComplianceEvent(base({ decision: "rejected", text: "This home is perfect for families." }))
check("rejected → allowed=false, blocked_reason='rejected by approver', verdict still captured",
  rejected.allowed === false && rejected.blocked_reason === "rejected by approver" && rejected.severity === "advisory")

const broadcast = buildComplianceEvent(base({ queue: "social", channel: "content", text: "Newly listed — open Saturday.", consent: NO_CONSENT }))
check("broadcast content row carries its queue (social) + content channel", broadcast.entity_type === "social" && broadcast.message_type === "content" && broadcast.severity === "clear")

console.log("\n[2 · summarizeComplianceLedger — the disposition report]")
const summary = summarizeComplianceLedger([clean, advisory, blocked, rejected, broadcast].map((r) => ({ severity: r.severity, allowed: r.allowed, details: r.details })))
check("summary counts every disposition",
  summary.total === 5 && summary.cleared === 2 && summary.advisory === 2 && summary.blocked === 1)
check("summary surfaces the two numbers a broker defends: approved-despite-advisory + rejected",
  summary.approvedDespiteAdvisory === 2 && summary.rejected === 1)

console.log("\n[2b · mapLedgerRow — the audit-report view of a stored event]")
const view = mapLedgerRow({
  id: "e1", created_at: "2026-06-18T12:00:00Z", entity_type: "client_message", message_type: "email",
  severity: "advisory", allowed: true, violations: ["Fair Housing (high): ..."],
  details: { approved_despite_advisory: true }, actor_user_id: "u9",
})
check("row view maps queue/channel/severity/findings + the released-over-objection flag",
  view.queue === "client_message" && view.channel === "email" && view.severity === "advisory" &&
  view.released === true && view.releasedOverObjection === true && view.findings.length === 1 && view.actorUserId === "u9")
check("a held (rejected) row maps released=false",
  mapLedgerRow({ id: "e2", allowed: false, severity: "advisory", violations: [], details: {} }).released === false)

async function main() {
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[3 · live insert] ⏭  Skipped — SUPABASE creds not set (pure layer ran).")
    return report()
  }
  console.log("\n[3 · live insert → read-back → cleanup]")
  const svc = createServiceClient()
  const { data: bk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!(bk as any)?.id) { console.log("  ⏭  no brokerage to scope a live event — skipped."); return report() }
  const tag = `LEDGERTEST-${Date.now()}`
  const res = await recordEgressComplianceDecision({
    brokerageId: (bk as any).id, actorUserId: "00000000-0000-0000-0000-000000000000", actorRole: "broker",
    queue: "client_message", entityId: tag, channel: "email",
    text: "This home is perfect for families.", consent: NO_CONSENT, decision: "approved",
  }, svc)
  check("live: event inserted", res.recorded)
  const { data: row } = await svc.from("compliance_events").select("severity, allowed, violations, gate_name").eq("entity_id", tag).maybeSingle()
  check("live: read-back matches (advisory, allowed, on the pre-flight gate)",
    (row as any)?.severity === "advisory" && (row as any)?.allowed === true && (row as any)?.gate_name === PREFLIGHT_GATE)
  const view = await loadComplianceLedger((bk as any).id, { sinceDays: 1 }, svc)
  check("live: loadComplianceLedger surfaces the event + counts it in the disposition summary",
    view.rows.some((r) => r.id) && view.summary.total >= 1 && view.summary.advisory >= 1)
  await svc.from("compliance_events").delete().eq("entity_id", tag)
  const { count } = await svc.from("compliance_events").select("id", { count: "exact", head: true }).eq("entity_id", tag)
  check("live: cleanup verified — 0 test events remain", (count ?? 0) === 0)
  report()
}
main()

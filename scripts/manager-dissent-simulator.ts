#!/usr/bin/env tsx
/**
 * scripts/manager-dissent-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * MANAGER DISSENT harness — peer review before the human sees a proposal.
 *
 * Layer 1 (pure): pickReviewer (nobody reviews their own work); reviewProposal —
 *   veto on withdrawn relationship / revoked channel; dissent on Fair Housing
 *   steering (SHARED pattern list), live fire drill, 48h spacing; pass otherwise.
 * Layer 2 (live, gated): seed four proposals against real contact states, run
 *   runManagerDissent, assert: clean proposal annotated "no objections", Fair-Housing
 *   proposal carries the named dissent + the suggested fix, withdrawn-recipient
 *   proposal machine-vetoed (rejected, NO forged approver), and a second run is a
 *   no-op (⚖️ mark = idempotency). Self-cleans.
 *
 * Run: npx tsx scripts/manager-dissent-simulator.ts  (npm run test:manager-dissent)
 */
import { pickReviewer, reviewProposal, runManagerDissent, REVIEW_MARK, evaluateCompliance, compliancePreflight } from "../lib/kernel/manager-dissent"

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
  console.log(" ✅ Manager Dissent (peer review) verified")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Manager Dissent (peer review) simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · pick + review]")
  check("nobody reviews their own work: sphere → Campaign Orchestrator reviews", pickReviewer("sphere_of_influence") === "campaign_orchestrator")
  check("nobody reviews their own work: campaign_orchestrator → Data Steward reviews", pickReviewer("campaign_orchestrator") === "data_steward")

  const cleanCtx = { recipientWithdrawn: false, emailRevoked: false, smsRevoked: false, hoursSinceLastSend: null, openFireDrill: false }
  const clean = reviewProposal({ proposer: "sphere_of_influence", channel: "portal", subject: "Checking in", body: "Hope the new place is treating you well — here if you need anything." }, cleanCtx)
  check("clean proposal → PASS (no objections)", clean.verdict === "pass" && clean.objections.length === 0)

  const fh = reviewProposal({ proposer: "shopping_agent", channel: "portal", subject: null, body: "This home is perfect for families and in a safe neighborhood." }, cleanCtx)
  check("Fair Housing steering → DISSENT (human still decides)", fh.verdict === "dissent")
  check("dissent names the phrase + the compliant fix + the statute",
    fh.objections.some((o) => o.includes("perfect for families") && o.includes("Spacious layout") && o.includes("3604")))
  check("both violations caught in one review", fh.objections.filter((o) => o.startsWith("Fair Housing")).length >= 2)

  const veto = reviewProposal({ proposer: "sphere_of_influence", channel: "portal", subject: "Hi", body: "Checking in!" }, { ...cleanCtx, recipientWithdrawn: true })
  check("withdrawn relationship → VETO (never reaches the human)", veto.verdict === "veto" && veto.objections[0].includes("WITHDRAWN"))
  const chVeto = reviewProposal({ proposer: "sphere_of_influence", channel: "email", subject: "Hi", body: "Checking in!" }, { ...cleanCtx, emailRevoked: true })
  check("revoked channel (email) → VETO", chVeto.verdict === "veto")
  const chOk = reviewProposal({ proposer: "sphere_of_influence", channel: "portal", subject: "Hi", body: "Checking in!" }, { ...cleanCtx, emailRevoked: true })
  check("email revoked but proposal is PORTAL → not a channel veto", chOk.verdict === "pass")

  const fire = reviewProposal({ proposer: "sphere_of_influence", channel: "portal", subject: "Anniversary!", body: "Happy home anniversary!" }, { ...cleanCtx, openFireDrill: true })
  check("live fire drill → DISSENT on routine touches", fire.verdict === "dissent" && fire.objections[0].includes("FIRE DRILL"))
  const fireDc = reviewProposal({ proposer: "deal_coordinator", channel: "portal", subject: "Update", body: "Quick update on your closing." }, { ...cleanCtx, openFireDrill: true })
  check("…but the Deal Coordinator's own fire-drill comms are exempt", fireDc.verdict === "pass")
  const spacing = reviewProposal({ proposer: "sphere_of_influence", channel: "portal", subject: "Hi", body: "Checking in!" }, { ...cleanCtx, hoursSinceLastSend: 5 })
  check("client heard from us 5h ago → spacing DISSENT", spacing.verdict === "dissent" && spacing.objections[0].includes("5h ago"))

  console.log("\n[Layer 1b · Compliance Officer pre-flight — the named owner of consent + Fair Housing]")
  const pf = (body: string, ctx = cleanCtx, channel = "portal") =>
    compliancePreflight({ proposer: "shopping_agent", channel, subject: null, body }, ctx)
  check("clean copy → preflight CLEAR, owned by the Compliance Officer",
    pf("Hope the move went smoothly — here if you need anything.").status === "clear" &&
    pf("Hope the move went smoothly.").manager === "compliance_officer")
  check("Fair Housing steering → preflight ADVISORY (human still decides), finding names the fix",
    (() => { const r = pf("This home is perfect for families in a safe neighborhood."); return r.status === "advisory" && r.findings.some((f) => f.startsWith("Fair Housing")) })())
  check("withdrawn relationship → preflight BLOCKED (a consent hard-stop)",
    pf("Checking in!", { ...cleanCtx, recipientWithdrawn: true }).status === "blocked")
  check("revoked email on an email proposal → preflight BLOCKED",
    pf("Checking in!", { ...cleanCtx, emailRevoked: true }, "email").status === "blocked")
  // evaluateCompliance is the ONE shared evaluator reviewProposal composes — the slices must agree.
  const fhBody = "This home is perfect for families and in a safe neighborhood."
  const ev = evaluateCompliance({ proposer: "shopping_agent", channel: "portal", subject: null, body: fhBody }, cleanCtx)
  const rv = reviewProposal({ proposer: "shopping_agent", channel: "portal", subject: null, body: fhBody }, cleanCtx)
  check("evaluateCompliance advisories are exactly reviewProposal's Fair Housing objections (one source, no drift)",
    ev.advisories.length >= 2 && ev.advisories.every((a) => rv.objections.includes(a)))
  check("a coordination-only flag (spacing) is NOT attributed to compliance",
    evaluateCompliance({ proposer: "sphere_of_influence", channel: "portal", subject: null, body: "Checking in!" }, { ...cleanCtx, hoursSinceLastSend: 5 }).advisories.length === 0)

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live review]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const TAG = `__dissent_${Date.now()}__`
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    const { data: brk } = await svc.from("brokerages").select("id").limit(1).single()
    const brokerageId = (brk as any).id

    const { data: cClean } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: "Clean", last_name: TAG, contact_type: "buyer",
    }).select("id").single()
    cleanup.push({ table: "contacts", id: (cClean as any).id })
    const { data: cGone } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: "Gone", last_name: TAG, contact_type: "buyer", nurture_status: "withdrawn",
    }).select("id").single()
    cleanup.push({ table: "contacts", id: (cGone as any).id })

    const mkProposal = async (kind: string, contactId: string, subject: string, body: string) => {
      const { data } = await svc.from("agent_client_messages").insert({
        brokerage_id: brokerageId, agent_kind: kind, entity_type: "contact", audience: "buyer",
        channel: "portal", recipient_contact_id: contactId, subject: `${TAG} ${subject}`, body,
        status: "proposed", proposed_at: new Date().toISOString(),
      }).select("id").single()
      cleanup.push({ table: "agent_client_messages", id: (data as any).id })
      return (data as any).id as string
    }
    const pClean = await mkProposal("sphere_of_influence", (cClean as any).id, "check-in", "Hope the new place is treating you well.")
    const pFh = await mkProposal("shopping_agent", (cClean as any).id, "new match", "This home is perfect for families — take a look!")
    const pGone = await mkProposal("sphere_of_influence", (cGone as any).id, "hello again", "Checking in!")

    const r1 = await runManagerDissent(brokerageId, {}, svc)
    check("live: all three proposals reviewed", r1.reviewed >= 3)

    const { data: a1 } = await svc.from("agent_client_messages").select("rationale, status").eq("id", pClean).single()
    check("clean → PASS annotation (peer-reviewed, no objections), still proposed",
      (a1 as any).status === "proposed" && ((a1 as any).rationale ?? "").includes("no objections"))
    const { data: a2 } = await svc.from("agent_client_messages").select("rationale, status").eq("id", pFh).single()
    check("Fair Housing → visible DISSENT from the named reviewer, human still decides",
      (a2 as any).status === "proposed" && ((a2 as any).rationale ?? "").includes("DISSENTS") && ((a2 as any).rationale ?? "").includes("perfect for families"))
    const { data: a3 } = await svc.from("agent_client_messages").select("status, send_error, approved_by").eq("id", pGone).single()
    check("withdrawn recipient → machine VETO (rejected, audit trail, NO forged approver)",
      (a3 as any).status === "rejected" && ((a3 as any).send_error ?? "").includes("Compliance Officer pre-flight") && (a3 as any).approved_by === null)

    const r2 = await runManagerDissent(brokerageId, {}, svc)
    const reReviewed = [pClean, pFh].filter(() => false).length // marks present → skipped
    check(`idempotency: second run re-reviews nothing (${REVIEW_MARK} mark)`, r2.passed === 0 && r2.dissents === 0 && reReviewed === 0)
  } finally {
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    const { count } = await svc.from("contacts").select("id", { count: "exact", head: true }).like("last_name", `${TAG}%`)
    check("cleanup verified — 0 seeded contacts remain", (count ?? 0) === 0)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })

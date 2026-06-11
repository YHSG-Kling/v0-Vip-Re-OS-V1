#!/usr/bin/env tsx
/**
 * scripts/voice-delegation-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * VOICE DELEGATION harness — the post-call flow: agent hangs up, speaks, the team
 * executes ON THE EXISTING RAILS (gate + sequences), never around them.
 *
 * Layer 1 (pure): composeFollowUp (dictation wins; default is warm, no pressure);
 *   pickSequence (active only; nurture-type preferred; none → null).
 * Layer 2 (live, gated): seed a contact + an active sequence; voiceFollowUp →
 *   gate message proposed AND approved BY THE AGENT (real human id, full audit),
 *   portal channel for a contact with no email; voiceStartMarketing → active
 *   enrollment (enrolled_by = agent), second call refuses to double-enroll;
 *   a WITHDRAWN contact refuses BOTH. Self-cleans.
 *
 * Run: npx tsx scripts/voice-delegation-simulator.ts  (npm run test:voice-delegation)
 */
import { composeFollowUp, pickSequence, voiceFollowUp, voiceStartMarketing } from "../lib/kernel/voice-delegation"

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
  console.log(" ✅ Voice delegation verified — spoken instruction, governed execution")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Voice delegation simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · compose + pick]")
  const dictated = composeFollowUp("Jordan", "Thanks for the call — inspection report comes Tuesday.")
  check("dictation wins verbatim", dictated.body === "Thanks for the call — inspection report comes Tuesday.")
  const dflt = composeFollowUp("Jordan", null)
  check("default follow-up: warm, named, zero pressure", dflt.body.includes("Jordan") && !/buy now|act fast|limited/i.test(dflt.body))
  const seqs = [
    { id: "a", name: "Blast", is_active: true, sequence_type: "promo" },
    { id: "b", name: "Spring Nurture", is_active: true, sequence_type: "nurture" },
    { id: "c", name: "Old", is_active: false, sequence_type: "nurture" },
  ]
  check("pickSequence: nurture-type preferred among ACTIVE", pickSequence(seqs)?.id === "b")
  check("pickSequence: inactive never picked; none active → null", pickSequence([seqs[2]]) === null)

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live delegation]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const TAG = `Voicedel${Date.now()}`
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    const { data: agent } = await svc.from("agents").select("id, user_id, brokerage_id").not("user_id", "is", null).not("brokerage_id", "is", null).limit(1).single()
    if (!agent) { console.log("  ⏭  Skipped — need an agent."); report(); return }
    const brokerageId = (agent as any).brokerage_id
    const agentUserId = (agent as any).user_id

    const { data: con } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: "Call", last_name: TAG, contact_type: "buyer",
    }).select("id").single()
    cleanup.push({ table: "contacts", id: (con as any).id })
    const { data: seq } = await svc.from("campaign_sequences").insert({
      brokerage_id: brokerageId, name: `${TAG} Nurture`, sequence_type: "nurture", is_active: true,
      trigger_event: "manual",
    }).select("id").single()
    cleanup.push({ table: "campaign_sequences", id: (seq as any).id })

    // FOLLOW-UP: the spoken instruction is the human approval (no email → portal).
    const f = await voiceFollowUp({ brokerageId, agentUserId, contactId: (con as any).id, dictation: `${TAG} inspection report comes Tuesday.` }, svc)
    if (f.messageId) cleanup.push({ table: "agent_client_messages", id: f.messageId })
    check("follow-up: executed from the voice command", f.ok)
    const { data: msg } = await svc.from("agent_client_messages")
      .select("status, approved_by, channel, body, rationale").eq("id", f.messageId ?? "").single()
    check("follow-up: approved BY THE AGENT (real human id, never forged)", (msg as any).approved_by === agentUserId)
    check("follow-up: dictation carried verbatim through the gate", ((msg as any).body ?? "").includes("inspection report comes Tuesday"))
    check("follow-up: portal channel picked (contact has no clean email)", (msg as any).channel === "portal")
    check("follow-up: rationale records VOICE DELEGATION (audit)", ((msg as any).rationale ?? "").includes("VOICE DELEGATION"))
    const { data: rtN } = await svc.from("notifications").select("id").eq("entity_id", f.messageId ?? "").eq("type", "approval_needed").maybeSingle()
    if (rtN) cleanup.push({ table: "notifications", id: (rtN as any).id })
    const { data: tu } = await svc.from("transparency_updates").select("id").eq("contact_id", (con as any).id).limit(5)
    for (const t of (tu ?? []) as any[]) cleanup.push({ table: "transparency_updates", id: t.id })

    // START MARKETING: governed enrollment + idempotency.
    const m1 = await voiceStartMarketing({ brokerageId, agentUserId, contactId: (con as any).id }, svc)
    if (m1.enrollmentId) cleanup.push({ table: "sequence_enrollments", id: m1.enrollmentId })
    check("marketing: enrolled in the active nurture sequence", m1.ok && m1.spoken.includes(`${TAG} Nurture`))
    const { data: enr } = await svc.from("sequence_enrollments").select("enrolled_by, status").eq("id", m1.enrollmentId ?? "").single()
    check("marketing: enrolled_by = the speaking agent, status active", (enr as any).enrolled_by === agentUserId && (enr as any).status === "active")
    const m2 = await voiceStartMarketing({ brokerageId, agentUserId, contactId: (con as any).id }, svc)
    check("marketing: second command refuses to double-enroll", m2.ok && m2.spoken.includes("already running"))

    // WITHDRAWN refuses both — the consent chain's promise holds against voice too.
    const { data: gone } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: "Gone", last_name: TAG, contact_type: "buyer", nurture_status: "withdrawn",
    }).select("id").single()
    cleanup.push({ table: "contacts", id: (gone as any).id })
    const fGone = await voiceFollowUp({ brokerageId, agentUserId, contactId: (gone as any).id }, svc)
    const mGone = await voiceStartMarketing({ brokerageId, agentUserId, contactId: (gone as any).id }, svc)
    check("withdrawn: follow-up REFUSED with the reason spoken", !fGone.ok && fGone.spoken.includes("withdrawn"))
    check("withdrawn: marketing REFUSED with the reason spoken", !mGone.ok && mGone.spoken.includes("withdrawn"))
  } finally {
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    const { count } = await svc.from("contacts").select("id", { count: "exact", head: true }).eq("last_name", TAG)
    check("cleanup verified — 0 seeded contacts remain", (count ?? 0) === 0)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })

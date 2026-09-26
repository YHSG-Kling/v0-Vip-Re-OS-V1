#!/usr/bin/env tsx
/**
 * scripts/reactivation-sequence-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves reactivation is now CONSOLIDATED into the real multi-channel sequencer (replacing the
 * hand-built ladders): an idempotent installer + an AI-ISA enroller that enrolls quiet contacts
 * AND leads, honors next_followup_at, and rides the sequencer's response-driven stop.
 *
 * Layer 1 (shell-runnable, pure): followupSuppresses gate (don't nag before "reach me later").
 * Layer 2 (live, creds-gated): ensureReactivationSequence is idempotent (same id on re-call);
 *   runReactivationEnrollment enrolls a quiet contact + a quiet lead, skips a future-dated one,
 *   is idempotent on re-run; an inbound reply (stopSequencesOnResponse) unenrolls. Seeds cleaned up.
 *
 * Run: npx tsx scripts/reactivation-sequence-simulator.ts   (npm run test:reactivation-sequence)
 */
import { followupSuppresses } from "../lib/lead-pipeline/reactivation-cadence"
import { readFileSync } from "node:fs"
import { CHECK_VOCABULARIES } from "./check-vocabularies"

let passed = 0, failed = 0
/** Set once Layer 2 actually connects, so the closing banner cannot claim a layer that never ran. */
let liveRan = false
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function report() {
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(liveRan
    ? " ✅ Reactivation sequence verified — vocabulary, idempotent install, contact+lead enroll, future-intent skip, reply stops."
    : " ✅ Reactivation vocabulary + cadence gate verified. Layer 2 (live install/enroll/stop) DID NOT RUN — no SUPABASE creds.")
  console.log(" REACTIVATION_SEQUENCE_PASS")
  process.exit(0)
}

const NOW = "2026-06-16T12:00:00.000Z"
/**
 * The installer imports server-only at module scope, so it cannot be imported
 * from a plain tsx script. Read its two exported constants out of the source —
 * Layer 0 stays pure and runs with no credentials, which is the point: it is the
 * half of this simulator CI can actually execute.
 */
const INSTALLER_SRC = readFileSync("lib/lead-pipeline/reactivation-sequence-installer.ts", "utf8")
const constant = (name: string) =>
  new RegExp(`export const ${name} = "([^"]+)"`).exec(INSTALLER_SRC)?.[1] ?? ""
const REACTIVATION_TRIGGER = constant("REACTIVATION_TRIGGER")
const REACTIVATION_SEQUENCE_TYPE = constant("REACTIVATION_SEQUENCE_TYPE")

const dormantSince = (d: number) => new Date(new Date(NOW).getTime() - d * 86_400_000).toISOString()

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Reactivation sequence consolidation simulator")
  console.log("══════════════════════════════════════════════════")

  // The installer wrote trigger_event 'ai_isa_reactivation' and sequence_type
  // 'reactivation'. Neither is in the column's live CHECK, so every insert was
  // rejected and ensureReactivationSequence could NEVER install the sequence —
  // campaign_sequences was empty in production. Layer 2 only runs with creds, so
  // these two checks are what actually protects this in CI.
  console.log("\n[Layer 0 · the installer writes values the columns admit]")
  {
    const triggers = CHECK_VOCABULARIES.campaign_sequences?.trigger_event ?? []
    const types = CHECK_VOCABULARIES.campaign_sequences?.sequence_type ?? []
    check(`trigger_event '${REACTIVATION_TRIGGER}' is in the CHECK`, triggers.includes(REACTIVATION_TRIGGER))
    check(`sequence_type '${REACTIVATION_SEQUENCE_TYPE}' is in the CHECK`, types.includes(REACTIVATION_SEQUENCE_TYPE))
    check("the two rejected literals are gone for good",
      !triggers.includes("ai_isa_reactivation") && !types.includes("reactivation"))
  }

  console.log("\n[Layer 1 · future-intent gate]")
  check("future follow-up date → suppresses enrollment", followupSuppresses("2026-12-01T00:00:00.000Z", NOW) === true)
  check("past/none → no suppression", followupSuppresses("2026-01-01T00:00:00.000Z", NOW) === false && followupSuppresses(null, NOW) === false)

  console.log("\n[Layer 2 · live: install + enroll + future-skip + reply-stop]")
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) { console.log("  ⏭  Skipped — SUPABASE creds not set (Layers 0-1 ran)."); return report() }

  liveRan = true
  const { createServiceClient } = await import("../lib/supabase/service")
  const { ensureReactivationSequence } = await import("../lib/lead-pipeline/reactivation-sequence-installer")
  const { runReactivationEnrollment } = await import("../lib/lead-pipeline/reactivation-enroller")
  const { stopSequencesOnResponse } = await import("../lib/campaign-sequences/enrollment-engine")
  const svc = createServiceClient()
  const { data: brokerage } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brokerage) { console.log("  ⏭  Skipped — need a real brokerage."); return report() }
  const brokerageId = (brokerage as any).id
  const uuid = () => (globalThis.crypto ?? require("node:crypto").webcrypto).randomUUID()
  const quietContact = uuid(), quietLead = uuid(), futureContact = uuid(), agentId = uuid()
  let seqId: string | null = null

  try {
    // Idempotent install.
    const i1 = await ensureReactivationSequence(brokerageId, svc)
    check("install creates (or finds) the sequence", !!i1.sequenceId, JSON.stringify(i1))
    seqId = i1.sequenceId
    const i2 = await ensureReactivationSequence(brokerageId, svc)
    check("re-install is idempotent (same sequence id, not created)", i2.sequenceId === seqId && i2.created === false)
    const { count: stepCount } = await svc.from("campaign_sequence_steps").select("id", { count: "exact", head: true }).eq("sequence_id", seqId!)
    check("sequence has multi-channel steps installed", (stepCount ?? 0) >= 3)

    // Seed: a quiet contact, a quiet lead, and a quiet-but-future-dated contact (must be skipped).
    await svc.from("contacts").insert({ id: quietContact, brokerage_id: brokerageId, first_name: "ZZ", last_name: "Quiet", contact_type: "buyer", agent_id: agentId, dnc_status: false, last_contacted_at: dormantSince(20) })
    await svc.from("contacts").insert({ id: futureContact, brokerage_id: brokerageId, first_name: "ZZ", last_name: "Later", contact_type: "buyer", agent_id: agentId, dnc_status: false, last_contacted_at: dormantSince(20), next_followup_at: "2026-12-01T00:00:00.000Z" })
    await svc.from("leads").insert({ id: quietLead, brokerage_id: brokerageId, first_name: "ZZ", last_name: "QuietLead", email: "zz.ql@example.com", ai_isa_owner: true, last_contacted_at: dormantSince(20) })

    const r1 = await runReactivationEnrollment({ brokerageId, now: NOW, limit: 500 }, svc)
    check("quiet contact + lead enrolled", r1.enrolledContacts >= 1 && r1.enrolledLeads >= 1, JSON.stringify(r1))

    const { data: cEnr } = await svc.from("sequence_enrollments").select("id, status").eq("sequence_id", seqId!).eq("contact_id", quietContact).maybeSingle()
    check("contact enrollment is active", (cEnr as any)?.status === "active")
    const { data: lEnr } = await svc.from("sequence_enrollments").select("id, status, lead_id").eq("sequence_id", seqId!).eq("lead_id", quietLead).maybeSingle()
    check("lead enrollment carries lead_id + active", (lEnr as any)?.status === "active" && (lEnr as any)?.lead_id === quietLead)
    const { data: fEnr } = await svc.from("sequence_enrollments").select("id").eq("sequence_id", seqId!).eq("contact_id", futureContact).maybeSingle()
    check("future-dated contact was NOT enrolled (honors next_followup_at)", !fEnr)

    // Re-run is idempotent (duplicate-active guard).
    const r2 = await runReactivationEnrollment({ brokerageId, now: NOW, limit: 500 }, svc)
    check("re-run does not double-enroll", r2.enrolledContacts === 0 && r2.enrolledLeads === 0, JSON.stringify(r2))

    // A reply terminates the sequence (response-driven stop).
    await stopSequencesOnResponse({ brokerageId, contactId: quietContact }, svc)
    const { data: cEnr2 } = await svc.from("sequence_enrollments").select("status").eq("id", (cEnr as any).id).maybeSingle()
    check("contact reply → enrollment unenrolled", (cEnr2 as any)?.status === "unenrolled")
  } finally {
    if (seqId) {
      await svc.from("sequence_enrollments").delete().eq("sequence_id", seqId).then(() => {}, () => {})
      await svc.from("campaign_sequence_steps").delete().eq("sequence_id", seqId).then(() => {}, () => {})
      await svc.from("campaign_sequences").delete().eq("id", seqId).then(() => {}, () => {})
    }
    await svc.from("contacts").delete().in("id", [quietContact, futureContact]).then(() => {}, () => {})
    await svc.from("leads").delete().eq("id", quietLead).then(() => {}, () => {})
    const { count } = await svc.from("campaign_sequences").select("id", { count: "exact", head: true }).eq("trigger_event", REACTIVATION_TRIGGER).eq("brokerage_id", brokerageId)
    check("cleanup: test sequence removed", (count ?? 0) === 0)
  }
  report()
}

main().catch((e) => { console.error(e); process.exit(1) })

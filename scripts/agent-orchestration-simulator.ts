#!/usr/bin/env tsx
/**
 * scripts/agent-orchestration-simulator.ts   (npm run test:agent-orchestration)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CONSENT GATE ON THE AGENT ACTION PLAN, AND THE ORPHAN MODULE THAT HELD IT.
 *
 * OWNER RULING (2026-08-24), verbatim:
 *
 *   "leads are not assigned to any agents until the lead has been qualified or a
 *    positive response came back from an ai isa's email or direct mail since
 *    these leads have not yet consented. so the action plan generator is
 *    incorrect. once the leads have been qualified or a positive response then
 *    they go through a gate to convert the lead to a contact which has already
 *    been built and all history, etc. stops on the lead record and continues on
 *    the contact record."
 *
 * WHAT THIS HARNESS LOCKS
 *
 *   Layer 1 — PURE. The consent gate (`resolveConsentBasis`), the merged
 *             three-state SLA posture on the LIVE survivor
 *             (lib/lead-governance/sla-monitor.ts `evaluateSLA`), and the
 *             first-contact clock. Every absence assertion carries its POSITIVE
 *             CONTROL (CLAUDE.md §2): a gate that refuses everything and a gate
 *             that refuses nothing both look like "no defect found", so each
 *             refusal check is paired with the admission it must still allow.
 *
 *   Layer 2 — STATIC CONFORMANCE, on COMMENT-STRIPPED source (CLAUDE.md §2 — a
 *             TOMBSTONE IS NOT A CALL SITE, and this file's own tombstones name
 *             `.from("leads")`, `agent_activity_monitor` and the retired timing
 *             string in prose). Every finder is proved against a SPECIMEN of the
 *             defect it hunts, so a broken regex cannot pass as a clean tree.
 *
 *   Layer 3 — LIVE ROUND TRIP against project hrvaqgvukzxfskkcrwbt: seeds a
 *             brokerage-owned contact plus an UNCONSENTED source lead and a
 *             QUALIFIED source lead, drives the REAL `generateAgentActionPlan`
 *             and `persistAgentActionPlan` through the REAL service client, reads
 *             the plan back through the agent dashboard's OWN query, and DELETES
 *             every row it made (including on failure). Requires
 *             SUPABASE_SERVICE_ROLE_KEY; SKIPS LOUDLY without it so Layers 1–2
 *             still run in CI. The skip is reported as a BLIND SPOT, never as a
 *             pass.
 *
 * Run:  npx tsx scripts/agent-orchestration-simulator.ts
 */
import { readFileSync, existsSync } from "node:fs"
import { walkTs } from "./runtime-roots"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { stripComments } from "./strip-comments"
import {
  resolveConsentBasis,
  hoursUntil,
  FIRST_CONTACT_SLA_HOURS,
} from "../lib/agent-orchestration/action-plan-generator"
import {
  evaluateSLA,
  APPROACHING_SLA_WINDOW_HOURS,
  type SLAPosture,
} from "../lib/lead-governance/sla-monitor"
import { POSITIVE_INTENT_LIFECYCLE_STATES } from "../lib/lead-assignment/rule-matcher"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const src = (rel: string) => (existsSync(join(root, rel)) ? readFileSync(join(root, rel), "utf8") : "")
/** Comment-stripped source — the ONE correct scanner (CLAUDE.md §2). */
const code = (rel: string) => stripComments(src(rel))

let passed = 0, failed = 0
const failures: string[] = []
const blindSpots: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString()
const hoursAgo = (n: number) => new Date(Date.now() - n * 60 * 60 * 1000).toISOString()

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 1 — THE CONSENT GATE (pure, no DB)
// ─────────────────────────────────────────────────────────────────────────────

function testConsentGate() {
  console.log("\n[Layer 1 · THE CONSENT GATE — resolveConsentBasis]")

  // ── REFUSALS. The states that mean "this person has not said yes". ─────────
  const raw = resolveConsentBasis({ id: "L1", lead_stage: "new", lifecycle_state: "raw" })
  check("REFUSAL · raw lead (pipeline birth state) → no agent action plan",
    raw.ok === false && raw.basis === null)

  const unconsented = resolveConsentBasis({ id: "L2", lead_stage: "new", lifecycle_state: "unconsented" })
  check("REFUSAL · lifecycle_state='unconsented' → no agent action plan",
    unconsented.ok === false)

  // THE ONE THE OWNER NAMED. The ISA is still ASKING; the attempt is not the
  // answer. This is the exact state the retired lib/lead-assignment/
  // assignment-eligibility.ts ADMITTED (`lead_stage !== 'new'`).
  const asking = resolveConsentBasis({ id: "L3", lead_stage: "contacted", lifecycle_state: "isa_qualifying" })
  check("REFUSAL · isa_qualifying — the ISA is still asking, the attempt is not the answer",
    asking.ok === false)

  const wound = resolveConsentBasis({ id: "L4", lead_stage: "contacted", lifecycle_state: "long_term_nurture" })
  check("REFUSAL · long_term_nurture (wound down after silence) → no plan", wound.ok === false)

  const scoredOnly = resolveConsentBasis({ id: "L5", lead_stage: "contacted", lifecycle_state: "unconsented" })
  check("REFUSAL · a lead the scorer touched but nobody answered → still refused",
    scoredOnly.ok === false)

  // ── POSITIVE CONTROLS. A gate that refuses EVERYTHING reports the same zero
  // as a gate that works. Prove both arms of the OR still open. ──────────────
  const qualified = resolveConsentBasis({ id: "L6", lead_stage: "qualified", lifecycle_state: "unconsented" })
  check("POSITIVE CONTROL · lead_stage='qualified' alone OPENS the gate (the ISA's verdict)",
    qualified.ok === true && qualified.basis === "qualified")

  const consented = resolveConsentBasis({ id: "L7", lead_stage: "new", lifecycle_state: "consented" })
  check("POSITIVE CONTROL · lifecycle_state='consented' alone OPENS the gate (their own reply)",
    consented.ok === true && consented.basis === "positive_intent")

  check("POSITIVE CONTROL · EVERY positive-intent state opens the gate",
    POSITIVE_INTENT_LIFECYCLE_STATES.every(
      (s) => resolveConsentBasis({ id: "L8", lead_stage: "new", lifecycle_state: s }).ok === true))

  const both = resolveConsentBasis({ id: "L9", lead_stage: "qualified", lifecycle_state: "consented" })
  check("POSITIVE CONTROL · qualified AND consented → open (the gate is an OR, never an AND)",
    both.ok === true)

  // ── DIRECT CAPTURE. No lead to gate; the contact IS the consented entity. ──
  const direct = resolveConsentBasis(null)
  check("direct capture (no originating lead) → allowed, basis 'direct_capture'",
    direct.ok === true && direct.basis === "direct_capture")

  // ── FAIL CLOSED on a shapeless row. ───────────────────────────────────────
  check("FAIL CLOSED · a lead row with neither field set → refused",
    resolveConsentBasis({ id: "L10" }).ok === false &&
    resolveConsentBasis({ id: "L11", lead_stage: null, lifecycle_state: null }).ok === false)

  // The refusal must SAY WHY — a caller that cannot report the closure will
  // silently drop the action instead.
  check("every refusal carries a reason a surface can show verbatim",
    [raw, unconsented, asking, wound, scoredOnly].every((v) => !v.ok && v.reason.length > 40))
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 1b — THE MERGED SLA POSTURE, ON THE LIVE SURVIVOR
// ─────────────────────────────────────────────────────────────────────────────

function testMergedSlaPosture() {
  console.log("\n[Layer 1b · MERGED from the retired agent-activity-monitor — evaluateSLA posture]")

  const posture = (lead: any): SLAPosture => evaluateSLA(lead).posture

  // RULE 1 — unassigned. Three states, not two. This is the capability the
  // survivor lacked: eleven hours before the miss looked identical to day one.
  check("RULE 1 · unassigned 1 day → within_sla",
    posture({ agent_id: null, stage_entered_at: daysAgo(1), created_at: daysAgo(1) }) === "within_sla")

  check(`RULE 1 · unassigned 6d18h (inside the ${APPROACHING_SLA_WINDOW_HOURS}h band) → approaching_sla`,
    posture({ agent_id: null, stage_entered_at: hoursAgo(6 * 24 + 18), created_at: hoursAgo(6 * 24 + 18) }) === "approaching_sla")

  check("RULE 1 · unassigned 9 days → breached_sla",
    posture({ agent_id: null, stage_entered_at: daysAgo(9), created_at: daysAgo(9) }) === "breached_sla")

  // POSITIVE CONTROL for the band: one hour EARLIER than the band must NOT be
  // 'approaching'. A band that swallows everything is not a band.
  check("POSITIVE CONTROL · unassigned 6d11h (one hour OUTSIDE the band) → still within_sla",
    posture({ agent_id: null, stage_entered_at: hoursAgo(6 * 24 + 11), created_at: hoursAgo(6 * 24 + 11) }) === "within_sla")

  // RULE 3 — isa_qualifying 14-day clock, same three states. Given an agent so
  // RULE 1 (unassigned) does not fire first, and no last_contacted_at so RULE 2
  // does not either: this isolates RULE 3's own band.
  check("RULE 3 · isa_qualifying 13d18h (6h left on the 14-day clock) → approaching_sla",
    posture({ agent_id: "A-1", last_contacted_at: null, lifecycle_state: "isa_qualifying", stage_entered_at: hoursAgo(13 * 24 + 18), created_at: hoursAgo(13 * 24 + 18) }) === "approaching_sla")

  check("RULE 3 · isa_qualifying 20 days → breached_sla",
    posture({ agent_id: null, lifecycle_state: "isa_qualifying", stage_entered_at: daysAgo(20), created_at: daysAgo(20) }) === "breached_sla")

  // MEASURED INTERACTION, locked so it cannot change silently: RULE 1 and RULE 3
  // both key on `stage_entered_at`, so an UNASSIGNED lead breaches RULE 1 at day
  // 7 and can never reach RULE 3's day-14 band. That is the survivor's
  // pre-existing shape, not something the merge introduced — recorded here so a
  // future change to either threshold is visible rather than absorbed.
  check("MEASURED · an unassigned isa_qualifying lead at 13d18h breaches RULE 1 before RULE 3's band",
    posture({ agent_id: null, lifecycle_state: "isa_qualifying", stage_entered_at: hoursAgo(13 * 24 + 18), created_at: hoursAgo(13 * 24 + 18) }) === "breached_sla")

  // hoursUntilDeadline is REPORTED, not merely computed — logEscalation writes it
  // into the escalation row's notes.
  const approaching = evaluateSLA({ agent_id: null, stage_entered_at: hoursAgo(6 * 24 + 18), created_at: hoursAgo(6 * 24 + 18) })
  check("approaching verdict names the hours left",
    approaching.hoursUntilDeadline !== null && approaching.hoursUntilDeadline! > 0 &&
    approaching.hoursUntilDeadline! <= APPROACHING_SLA_WINDOW_HOURS)

  // THE BAND DOES NOT ESCALATE. Binding escalationRequired to 'approaching'
  // would turn a warning into a broker notification and change what govern-lead
  // writes to `activities`.
  check("approaching_sla WARNS but does NOT escalate (escalationRequired stays breach-bound)",
    approaching.escalationRequired === false && approaching.isBreached === false)

  const breached = evaluateSLA({ agent_id: null, stage_entered_at: daysAgo(9), created_at: daysAgo(9) })
  check("POSITIVE CONTROL · a BREACH still escalates to the broker",
    breached.escalationRequired === true && breached.isBreached === true &&
    breached.escalationRecipient === "broker")

  // CONVERSION FINALITY still stops the lead clock — the merge must not have
  // reopened it. A converted lead owes the brokerage no LEAD SLA.
  const converted = evaluateSLA({
    id: "L-conv", contact_id: "C-1", agent_id: null,
    stage_entered_at: daysAgo(90), created_at: daysAgo(90),
  })
  check("CONVERSION FINALITY intact after the merge · converted lead → no clock, no escalation",
    converted.posture === "within_sla" && converted.hoursUntilDeadline === null &&
    converted.escalationRequired === false && converted.isBreached === false)

  // A lead running against NO rule reports null rather than a comforting zero.
  check("a lead matching no rule reports hoursUntilDeadline null, not 0",
    evaluateSLA({ agent_id: "A-1", last_contacted_at: null, stage_entered_at: daysAgo(2), created_at: daysAgo(2) }).hoursUntilDeadline === null)
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 1c — THE 48-HOUR FIRST-CONTACT CLOCK (merged onto the CONTACT)
// ─────────────────────────────────────────────────────────────────────────────

function testFirstContactClock() {
  console.log("\n[Layer 1c · MERGED first-contact SLA — hoursUntil / FIRST_CONTACT_SLA_HOURS]")

  check("the retired monitor's 48-hour window survived the merge unchanged",
    FIRST_CONTACT_SLA_HOURS === 48)

  const fresh = hoursUntil(hoursAgo(2), FIRST_CONTACT_SLA_HOURS)
  check("handed off 2h ago → ~46h left", fresh !== null && fresh > 45 && fresh <= 46)

  const overdue = hoursUntil(hoursAgo(60), FIRST_CONTACT_SLA_HOURS)
  check("POSITIVE CONTROL · handed off 60h ago → NEGATIVE (breached), not clamped to zero",
    overdue !== null && overdue < 0)

  check("FAIL CLOSED · no anchor → null, never a fabricated deadline",
    hoursUntil(null, FIRST_CONTACT_SLA_HOURS) === null &&
    hoursUntil(undefined, FIRST_CONTACT_SLA_HOURS) === null &&
    hoursUntil("not-a-date", FIRST_CONTACT_SLA_HOURS) === null)
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 2 — STATIC CONFORMANCE (comment-stripped; every finder positive-controlled)
// ─────────────────────────────────────────────────────────────────────────────

/** The defect specimens each finder below must still recognise. */
const SPECIMEN_LEAD_SUBJECT = `
  const { data: lead } = await supabase.from("leads").select("*").eq("id", leadId).single()
  return { leadId, agentId, suggestedTiming: "Within 2 hours of assignment" }
`
const SPECIMEN_LEAD_ID_ON_CONTACT_FK = `
  await supabase.from("activities").select("*").eq("contact_id", leadId)
`

const findLeadSubjectRead = (s: string) => /\.from\(\s*["']leads["']\s*\)\s*[\s\S]{0,200}?\.eq\(\s*["']id["']/.test(s)
const findAssignmentTiming = (s: string) => /within\s+\d+\s+hours?\s+of\s+assignment/i.test(s)
const findLeadIdOnContactFk = (s: string) => /\.eq\(\s*["']contact_id["']\s*,\s*leadId\s*\)/.test(s)

function testGeneratorSubject() {
  console.log("\n[Layer 2 · the action plan's SUBJECT is the CONTACT]")

  const gen = code("lib/agent-orchestration/action-plan-generator.ts")
  check("action-plan-generator.ts still exists (the capability was NOT deleted to move a number)",
    gen.length > 0)

  // Each absence assertion, and its POSITIVE CONTROL immediately after.
  check("the generator no longer reads a LEAD as its subject", !findLeadSubjectRead(gen))
  check("POSITIVE CONTROL · the lead-subject finder still recognises the defect",
    findLeadSubjectRead(SPECIMEN_LEAD_SUBJECT))

  check('the generator no longer times actions "of assignment"', !findAssignmentTiming(gen))
  check("POSITIVE CONTROL · the assignment-timing finder still recognises the defect",
    findAssignmentTiming(SPECIMEN_LEAD_SUBJECT))

  check("the generator no longer queries a contacts FK with a lead id", !findLeadIdOnContactFk(gen))
  check("POSITIVE CONTROL · the lead-id-on-contacts-FK finder still recognises the defect",
    findLeadIdOnContactFk(SPECIMEN_LEAD_ID_ON_CONTACT_FK))

  // What it must POSITIVELY do.
  check("the generator reads `contacts` as its subject", /\.from\(\s*["']contacts["']\s*\)/.test(gen))
  check("the generator runs the consent gate through the ONE canonical predicate",
    /evaluateAssignmentEligibility/.test(gen) &&
    /lead-assignment\/rule-matcher/.test(gen))
  check("the generator refuses a contact owned by a different agent",
    /not_this_agents_contact/.test(gen))
  check("the generator FAILS CLOSED without a tenant", /no_tenant/.test(gen))
  check("the generator FAILS CLOSED when the consent check itself is refused",
    /sourceLeadError/.test(gen) && /consent_gate_closed/.test(gen))
}

function testWriterHalfExists() {
  console.log("\n[Layer 2 · the agent_action_plan READER finally has a WRITER]")

  const dash = code("app/dashboard/agent/page.tsx")
  const gen = code("lib/agent-orchestration/action-plan-generator.ts")

  // The READER — this is the half that always existed.
  check("READER present: the agent dashboard selects activity_type='agent_action_plan'",
    /activity_type["'\s,]*\)?\s*,?\s*["']agent_action_plan["']/.test(dash) ||
    /["']agent_action_plan["']/.test(dash))

  // The WRITER — the half CLAUDE.md §1 case 2 says to BUILD.
  check("WRITER present: persistAgentActionPlan inserts activity_type='agent_action_plan'",
    /persistAgentActionPlan/.test(gen) &&
    /activity_type:\s*["']agent_action_plan["']/.test(gen))

  check("the writer states brokerage_id explicitly (activities.brokerage_id is NOT NULL)",
    /brokerage_id:\s*brokerageId/.test(gen))

  check("the writer anchors the row on the CONTACT (entity_type/entity_id + contact_id)",
    /entity_type:\s*["']contact["']/.test(gen) &&
    /entity_id:\s*plan\.contactId/.test(gen) &&
    /contact_id:\s*plan\.contactId/.test(gen))

  check("the writer READS its own error (supabase-js resolves refusals)",
    /const \{ data, error \} = await supabase\s*\n?\s*\.from\(["']activities["']\)/.test(gen) ||
    /\.insert\(rows\)\.select\(["']id["']\)/.test(gen))

  check("the writer is idempotent — a re-plan supersedes the previous pending plan",
    /status:\s*["']superseded["']/.test(gen))

  // POSITIVE CONTROL: the writer-finder must not pass on a file that has no
  // writer. The dashboard page is a reader only.
  check("POSITIVE CONTROL · the writer-finder reports FALSE on the reader-only file",
    !/activity_type:\s*["']agent_action_plan["']/.test(dash))
}

function testOrphanModuleResolved() {
  console.log("\n[Layer 2 · the ORPHAN MODULE is resolved — the barrel is imported]")

  const importers = tsFiles().filter((f) =>
    !f.startsWith("lib/agent-orchestration/") &&
    /@\/lib\/agent-orchestration/.test(code(f)))

  check(`lib/agent-orchestration is imported by live code (${importers.length} file(s): ${importers.join(", ") || "NONE"})`,
    importers.length > 0)

  check("the wiring lands on the CONVERSION path, not on an acquisition path",
    importers.some((f) => f.startsWith("lib/contact-promotion/")))

  // POSITIVE CONTROL for the importer scan: a name that genuinely appears
  // nowhere must come back 0, or the scan is matching everything.
  const ghost = tsFiles().filter((f) => /@\/lib\/this-module-does-not-exist/.test(code(f)))
  check("POSITIVE CONTROL · the importer scan reports 0 for a module that does not exist",
    ghost.length === 0)
}

function testDuplicatesRetiredWithTombstones() {
  console.log("\n[Layer 2 · duplicates deleted, each naming its survivor (CLAUDE.md §1)]")

  check("agent-activity-monitor.ts is gone",
    !existsSync(join(root, "lib/agent-orchestration/agent-activity-monitor.ts")))

  // The tombstone is PROSE — read it RAW, not stripped. A stripped read would
  // find nothing and this check would silently pass on a missing tombstone.
  const orchIndexRaw = src("lib/agent-orchestration/index.ts")
  check("its tombstone names the survivor at file:line",
    /lib\/lead-governance\/sla-monitor\.ts:\d+/.test(orchIndexRaw) &&
    /monitorAgentActivity/.test(orchIndexRaw))

  check("nothing in the tree still calls monitorAgentActivity",
    tsFiles().every((f) => !/\bmonitorAgentActivity\s*\(/.test(code(f))))

  check("assignment-eligibility.ts is gone",
    !existsSync(join(root, "lib/lead-assignment/assignment-eligibility.ts")))

  const assignIndexRaw = src("lib/lead-assignment/index.ts")
  check("its tombstone names the survivor at file:line",
    /lib\/lead-assignment\/rule-matcher\.ts:\d+/.test(assignIndexRaw))

  // DENOMINATOR AND EXCLUSION, stated (CLAUDE.md §2): the scan covers lib/ and
  // app/ — where definitions live — and excludes scripts/, because a guard whose
  // own REGEX LITERAL contains the name it hunts matches itself. That is not a
  // comment, so stripComments cannot remove it; naming the exclusion is the
  // honest fix, not a looser pattern.
  const defRe = /export (?:async )?function evaluateAssignmentEligibility/
  const defs = tsFiles().filter((f) => (f.startsWith("lib/") || f.startsWith("app/")) && defRe.test(code(f)))
  check(`exactly ONE evaluateAssignmentEligibility defined across lib/ + app/ — CLAUDE.md §6 (found: ${defs.join(", ") || "NONE"})`,
    defs.length === 1)

  // POSITIVE CONTROL: the definition finder must actually match the survivor.
  check("POSITIVE CONTROL · the definition finder DOES match rule-matcher.ts",
    /export function evaluateAssignmentEligibility/.test(code("lib/lead-assignment/rule-matcher.ts")))
}

function testSurvivorKeptItsCallers() {
  console.log("\n[Layer 2 · the merge did not break the survivor's live call site]")

  const govern = code("app/actions/lead-governance/govern-lead.ts")
  check("govern-lead.ts still calls evaluateSLA(lead)", /evaluateSLA\(\s*lead\s*\)/.test(govern))
  check("govern-lead.ts still escalates on escalationRequired",
    /escalationRequired/.test(govern) && /logEscalation\(/.test(govern))
  check("govern-lead.ts now reports the merged three-state posture",
    /slaStatus\.posture/.test(govern))

  const sla = code("lib/lead-governance/sla-monitor.ts")
  check("logEscalation records the posture in the escalation row",
    /posture:\s*slaStatus\.posture/.test(sla))
  check("the survivor still refuses to escalate a converted lead",
    /conversionVerdictForRow/.test(sla) && /assertLeadNotConverted/.test(sla))
}

// ─── file walker (shared) ────────────────────────────────────────────────────
let _files: string[] | null = null
function tsFiles(): string[] {
  if (_files) return _files
  // TOMBSTONE (orphan doctrine §1.1) — the private walker that stood here was one of
  // 82 copies of the same readdirSync walker. The survivor is
  // scripts/runtime-roots.ts:61 (`walkTs`), imported above. This one already walked
  // ROOT, so it was not blind to `proxy.ts`; it is DEDUPLICATED only, and every
  // exclusion below is this file's own, preserved so the corpus does not move.
  //
  // This file's private walker was the ONLY one of the 82 that had worked out that
  // `plugins/` is not application source. That knowledge is now in the survivor's
  // NON_RUNTIME_ROOTS with the tsconfig `exclude` that proves it, so it no longer
  // has to be rediscovered one walker at a time — but walkTs() is the raw recursion
  // and does not apply that list, so the skip is still spelled out here.
  const skip = new Set(["dist", "build", "plugins"])   // NEVER_WALK covers the rest
  const out = walkTs(root)
    .map((p) => p.replace(root + "/", ""))
    .filter((r) => !r.split("/").some((seg) => skip.has(seg)))
  _files = out
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 3 — LIVE ROUND TRIP (hrvaqgvukzxfskkcrwbt). Seeds, drives, cleans up.
// ─────────────────────────────────────────────────────────────────────────────

async function testLive() {
  console.log("\n[Layer 3 · LIVE round trip — real service client, real rows, full cleanup]")

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.NEXT_PUBLIC_SUPABASE_URL) {
    // A SKIP IS A BLIND SPOT, NOT A PASS (CLAUDE.md §2 — publish blind spots
    // beside the number).
    blindSpots.push(
      "Layer 3 (live round trip) did NOT run: SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_URL absent. " +
      "The consent gate, the agent-ownership refusal and the agent_action_plan write are covered by " +
      "Layers 1-2 only in this run.",
    )
    console.log("  ⚠ SKIPPED — no SUPABASE_SERVICE_ROLE_KEY. Reported as a blind spot, not a pass.")
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { generateAgentActionPlan, persistAgentActionPlan } = await import("../lib/agent-orchestration")
  const supabase = createServiceClient()

  const made = { leads: [] as string[], contacts: [] as string[], activities: [] as string[] }
  const TAG = `agent-orch-sim-${Date.now()}`

  const cleanup = async () => {
    if (made.activities.length) await supabase.from("activities").delete().in("id", made.activities).select("id")
    if (made.leads.length) await supabase.from("leads").delete().in("id", made.leads).select("id")
    if (made.contacts.length) await supabase.from("contacts").delete().in("id", made.contacts).select("id")
  }

  try {
    const { data: agent, error: agentErr } = await supabase
      .from("agents").select("id, brokerage_id").eq("is_active", true).not("brokerage_id", "is", null).limit(1).maybeSingle()
    if (agentErr || !agent) {
      blindSpots.push(`Layer 3 could not seed: no active agent with a brokerage (${agentErr?.message ?? "none found"}).`)
      console.log("  ⚠ SKIPPED — no seedable agent. Reported as a blind spot.")
      return
    }
    const brokerageId = agent.brokerage_id as string
    const agentId = agent.id as string

    // ── SEED: one contact, owned by that agent, in that tenant. ──────────────
    const { data: contact, error: cErr } = await supabase.from("contacts").insert({
      brokerage_id: brokerageId, agent_id: agentId,
      first_name: "SimTest", last_name: TAG,
      email: `${TAG}@example.invalid`,
      timeline: "1-3_months", lead_score: 72,
      notes: `TEST ROW ${TAG} — agent-orchestration-simulator, deleted at end of run`,
    }).select("id, created_at").single()
    if (cErr || !contact) throw new Error(`contact seed refused: ${cErr?.message}`)
    made.contacts.push(contact.id)

    // ── CASE A: an UNCONSENTED source lead reaches an agent action plan. ─────
    const { data: badLead, error: blErr } = await supabase.from("leads").insert({
      brokerage_id: brokerageId, agent_id: agentId, contact_id: contact.id,
      first_name: "SimTest", last_name: TAG,
      email: `${TAG}.bad@example.invalid`,
      lead_stage: "contacted", lifecycle_state: "isa_qualifying",
      converted_at: new Date().toISOString(),
      handed_to_agent_at: hoursAgo(2),
    }).select("id").single()
    if (blErr || !badLead) throw new Error(`unconsented lead seed refused: ${blErr?.message}`)
    made.leads.push(badLead.id)

    const refused = await generateAgentActionPlan(contact.id, agentId, brokerageId, supabase)
    check("LIVE · an UNCONSENTED (isa_qualifying) source lead is REFUSED an agent action plan",
      refused.ok === false && (refused as any).code === "consent_gate_closed",
      refused.ok ? "a plan was produced for an unconsented lead" : undefined)

    // ── CASE B: same contact, the lead now QUALIFIED. Positive control. ──────
    const { error: upErr } = await supabase.from("leads")
      .update({ lead_stage: "qualified", lifecycle_state: "consented" })
      .eq("id", badLead.id).eq("brokerage_id", brokerageId).select("id")
    if (upErr) throw new Error(`lead qualification update refused: ${upErr.message}`)

    const allowed = await generateAgentActionPlan(contact.id, agentId, brokerageId, supabase)
    check("LIVE POSITIVE CONTROL · once QUALIFIED, the same contact DOES get a plan",
      allowed.ok === true && (allowed as any).plan.recommendedActions.length > 0,
      allowed.ok ? undefined : (allowed as any).reason)

    if (allowed.ok) {
      check("LIVE · the plan names the CONTACT, not the lead",
        allowed.plan.contactId === contact.id && allowed.plan.sourceLeadId === badLead.id)
      check("LIVE · the plan records which arm of the gate opened",
        allowed.plan.consentBasis === "qualified" || allowed.plan.consentBasis === "positive_intent")
      check("LIVE · no action still says 'of assignment'",
        allowed.plan.recommendedActions.every((a) => !/of assignment/i.test(a.suggestedTiming)))

      // ── THE WRITER, AND THE DASHBOARD'S OWN READ OF IT. ───────────────────
      const persisted = await persistAgentActionPlan(supabase, allowed.plan, brokerageId)
      check("LIVE · persistAgentActionPlan wrote agent_action_plan rows",
        persisted.written === allowed.plan.recommendedActions.length,
        persisted.warnings.join("; "))

      const { data: readBack, error: rbErr } = await supabase
        .from("activities")
        .select("id, title, description, priority, contact_id")
        .eq("agent_id", agentId)
        .eq("activity_type", "agent_action_plan")
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(5)
      for (const r of readBack ?? []) made.activities.push(r.id)
      check("LIVE · the AGENT DASHBOARD's own query now returns the plan (was writerless)",
        !rbErr && (readBack ?? []).length > 0, rbErr?.message)
      check("LIVE · every returned row deep-links a CONTACT (ActionPlanCard's contact_id)",
        (readBack ?? []).every((r: any) => r.contact_id === contact.id))
    }

    // ── CASE C: the ownership refusal. ───────────────────────────────────────
    const wrongAgent = await generateAgentActionPlan(contact.id, "00000000-0000-0000-0000-000000000000", brokerageId, supabase)
    check("LIVE · a different agent is REFUSED this contact's plan",
      wrongAgent.ok === false && (wrongAgent as any).code === "not_this_agents_contact")

    // ── CASE D: fail closed with no tenant. ──────────────────────────────────
    const noTenant = await generateAgentActionPlan(contact.id, agentId, "", supabase)
    check("LIVE · FAIL CLOSED · no brokerage → refused, never an un-scoped read",
      noTenant.ok === false && (noTenant as any).code === "no_tenant")
  } catch (e: any) {
    check("LIVE layer completed without throwing", false, e?.message)
  } finally {
    await cleanup()
    // PROVE THE CLEANUP. A delete that matched nothing resolves exactly like one
    // that worked (CLAUDE.md §3), so the leftovers are COUNTED, not assumed.
    const { count: leftLeads } = await supabase.from("leads").select("id", { count: "exact", head: true }).ilike("last_name", `${TAG}%`)
    const { count: leftContacts } = await supabase.from("contacts").select("id", { count: "exact", head: true }).ilike("last_name", `${TAG}%`)
    const { count: leftPlans } = await supabase.from("activities").select("id", { count: "exact", head: true }).eq("activity_type", "agent_action_plan")
    check("LIVE CLEANUP · no test leads left behind", (leftLeads ?? 0) === 0)
    check("LIVE CLEANUP · no test contacts left behind", (leftContacts ?? 0) === 0)
    check("LIVE CLEANUP · no agent_action_plan rows left behind", (leftPlans ?? 0) === 0)
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("AGENT ORCHESTRATION SIMULATOR — the consent gate on the agent action plan")
  console.log("=".repeat(78))

  testConsentGate()
  testMergedSlaPosture()
  testFirstContactClock()
  testGeneratorSubject()
  testWriterHalfExists()
  testOrphanModuleResolved()
  testDuplicatesRetiredWithTombstones()
  testSurvivorKeptItsCallers()
  await testLive()

  console.log("\n" + "=".repeat(78))
  console.log(`PASSED: ${passed}   FAILED: ${failed}`)
  if (blindSpots.length) {
    console.log("\nBLIND SPOTS (a skip is not a pass):")
    for (const b of blindSpots) console.log("  ⚠ " + b)
  }
  if (failures.length) {
    console.log("\nFAILURES:")
    for (const f of failures) console.log("  ✗ " + f)
  }
  process.exit(failed > 0 ? 1 : 0)
}

main()

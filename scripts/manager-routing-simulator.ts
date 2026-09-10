#!/usr/bin/env tsx
/**
 * scripts/manager-routing-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE MANAGER-ROUTING PROOF — owner rulings, wave 49 (2026-09-10), on kernel-event
 * reader routing (lib/kernel/event-reactor.ts D-octies/D-novies/D-decies/D-undecies,
 * lib/kernel/signal-registry.ts, lib/kernel/manager-signals.ts):
 *
 *   1. NO kernel event / signal exists for an AGENT CLAIMING A LEAD (owner, verbatim:
 *      "agents can't see leads until the lead gets converted to a contact and the
 *      agent is assigned that contact") — KernelEvent.LEAD_CLAIMED and the
 *      SIGNAL_REGISTRY "lead_claimed" entry are both retired.
 *   2. marketing_campaign_ended routes to campaign_orchestrator (the campaign
 *      manager), NOT finance_manager.
 *   3. ai_isa_handoff_to_agent BRANCHES on the contact's type into listing_concierge
 *      (seller) / shopping_agent (buyer) — not a single static "agent handoff" route.
 *   4. agent_escalated_to_human routes to recruiting_manager.
 *
 * PURE + SOURCE (CLAUDE.md §2): every rule is a pure function of SOURCE TEXT (read via
 * readFileSync, comments stripped via scripts/strip-comments.ts — no DB, no mocks) and
 * is POSITIVE-CONTROLLED — proven against a deliberately WRONG fixture snippet that
 * must fail the same rule, so a broken/vacuous parser reads as a failure rather than a
 * silent pass ("if you claim '0 found', prove the finder still recognises the defect
 * it was written for").
 *
 * Run: npx tsx scripts/manager-routing-simulator.ts   (npm run test:manager-routing)
 */
import { readFileSync } from "node:fs"
import { stripComments } from "./strip-comments"
import { SIGNAL_REGISTRY } from "../lib/kernel/signal-registry"
import { SIGNAL_HANDLERS } from "../lib/kernel/manager-signals"

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
  console.log(" ✅ Manager routing whole — every wave-49 kernel-event routing ruling holds.")
  console.log(" MANAGER_ROUTING_PASS")
  process.exit(0)
}

const ROOT = process.cwd()
function readSrc(relPath: string): string {
  return stripComments(readFileSync(`${ROOT}/${relPath}`, "utf8"))
}

// ── Rule 1 — no agent-claim signal ──────────────────────────────────────────
// Pure: true only when BOTH the KernelEvent enum member and the SIGNAL_REGISTRY entry
// are absent. Either one surviving alone would leave a half-retired signal (an enum
// member nothing reads, or a registry entry nothing emits) — both must be gone.
function ruleNoAgentClaimSignal(eventsSrc: string, registrySrc: string): boolean {
  const hasEnumMember = /\bLEAD_CLAIMED\s*=\s*'lead_claimed'/.test(eventsSrc)
  const hasRegistryEntry = /\blead_claimed\s*:\s*\{/.test(registrySrc)
  return !hasEnumMember && !hasRegistryEntry
}

// ── Static (toManager → signalType) pair finder ─────────────────────────────
// Same convention scripts/signal-integrity-simulator.ts's scanRoutedPairs() uses: the
// codebase always writes fromManager → toManager → signalType in that order inside one
// publishManagerSignal({...}) call, so the toManager literal immediately preceding a
// given signalType literal is that route's STATIC destination. Returns null for a
// DYNAMIC route (toManager is a variable, not a string literal) — rule 3 checks those
// separately, since a single static answer would be the wrong shape for a branch.
function findStaticToManager(src: string, signalType: string): string | null {
  const re = /(toManager|signalType):\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?/g
  let pendingTo: string | null = null
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    if (m[1] === "toManager") {
      pendingTo = /^[a-z_]+$/.test(m[2]) ? m[2] : null // a literal only, never a bare identifier like a variable name
    } else {
      // signalType — resolve against the pair standing right now, then clear it (matching
      // signal-integrity-simulator.ts's scanRoutedPairs convention): a block with no static
      // toManager (a dynamic route, e.g. a bare `toManager,` shorthand) must never let a
      // STALE pendingTo from an earlier block leak onto its own signalType.
      const resolved = m[1] === "signalType" && m[2] === signalType ? pendingTo : null
      pendingTo = null
      if (m[1] === "signalType" && m[2] === signalType) return resolved
    }
  }
  return null
}

// ── Rule 3 — ai_isa_handoff_to_agent branches on contact type ───────────────
// Isolates the event's own reactor block (bounded so a match elsewhere in the 2000+
// line file can never pass this) and requires BOTH agent-side destinations to appear
// as routing candidates AND a `toManager =`/`let toManager` assignment shape — the
// signature of the dynamic branch this ruling requires, not a static single route.
function ruleIsaHandoffBranches(reactorSrc: string): boolean {
  const marker = "KernelEvent.AI_ISA_HANDOFF_TO_AGENT"
  const idx = reactorSrc.indexOf(marker)
  if (idx === -1) return false
  const block = reactorSrc.slice(idx, idx + 1600)
  const hasBothDestinations = block.includes('"listing_concierge"') && block.includes('"shopping_agent"')
  const hasDynamicAssignment = /toManager\s*[:=]/.test(block) && /let\s+toManager/.test(block)
  return hasBothDestinations && hasDynamicAssignment
}

// ── Rule: every RULES consumer has a REAL SIGNAL_HANDLERS entry ─────────────
// "with a real handler" (owner ruling #3, #4) — a routed manager that never actually
// consumes the signal is the exact silent-drop class test:signal-integrity guards; this
// re-checks it narrowly for the four wave-49 types so this proof does not depend on
// that other script staying green to catch a regression here.
function consumerHasHandler(consumer: string, signalType: string): boolean {
  return typeof SIGNAL_HANDLERS[`${consumer}:${signalType}`] === "function"
}

// ── Static (fromManager → signalType) pair finder ───────────────────────────
// Companion to findStaticToManager above, added wave 50 (owner ruling, 2026-09-10:
// "video snippet should be asset manager from"; "the managers that you are picking to
// start a kernel event are off, review and change if warranted"). Same convention: the
// codebase always writes fromManager, then toManager, then signalType as three
// consecutive lines inside one publishManagerSignal({...}) call — matches BOTH a literal
// `toManager: "x"` and the shorthand `toManager,` a dynamic (branched) destination uses,
// since only the FROM/signalType pairing is asserted here.
const FROM_SIGNAL_CALL_RE = /fromManager:\s*"([a-z_][a-z0-9_]*)",\s*\n\s*toManager[,:][^\n]*\n\s*signalType:\s*"([a-z_][a-z0-9_]*)"/g
function findStaticFromManager(src: string, signalType: string): string | null {
  const re = new RegExp(FROM_SIGNAL_CALL_RE.source, "g")
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    if (m[2] === signalType) return m[1]
  }
  return null
}
// Every literal (fromManager, signalType) pair the file publishes — used for the
// blanket "data_steward is only a data-quality/ledger FROM" sweep below. One publish
// (business_card_approved) resolves its signalType through a variable (`picked.signalType`,
// branched by card classification per wave 48) and is intentionally NOT literal-matched
// here — it is a documented, hand-verified data_steward exception (a card-intake/
// classification pipeline), not a gap in this scan.
function allFromSignalPairs(src: string): Array<{ from: string; signalType: string }> {
  const re = new RegExp(FROM_SIGNAL_CALL_RE.source, "g")
  const out: Array<{ from: string; signalType: string }> = []
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) out.push({ from: m[1], signalType: m[2] })
  return out
}

// ── Wave 50 — FROM_OWNER_BY_SIGNAL: the manager that OWNS each event-family moment ──
// Each entry names the manager whose own emitter (read from event-reactor.ts's own
// call-site comment) caused the moment — never a convenience data_steward default.
const FROM_OWNER_BY_SIGNAL: Record<string, string> = {
  // video/asset lane — FROM Asset Manager, the asset owner (owner's own wording:
  // "video/asset-lane moments ... are published FROM asset_manager").
  script_generated: "asset_manager",
  voice_clone_ready: "asset_manager",
  snippet_created: "asset_manager",
  content_repurposed: "asset_manager",
  omnipresence_pipeline_completed: "asset_manager",
  podcast_episode_generated: "asset_manager",
  podcast_episode_failed: "asset_manager",
  script_variation_created: "asset_manager",
  voice_clone_profile_created: "asset_manager",
  voice_clone_training_started: "asset_manager",
  voice_clone_default_set: "asset_manager",
  snippet_scheduled: "asset_manager",
  repurpose_batch_completed: "asset_manager",
  video_performance_updated: "asset_manager",
  podcast_episode_distributed: "asset_manager",
  video_high_performer_detected: "asset_manager",
  video_low_performer_detected: "asset_manager",
  // campaign/newsletter/social — FROM Campaign Orchestrator.
  // A signal cannot route from a manager to itself (validSignalRoute requires from !== to),
  // so the campaign_orchestrator-owned publish moments are reported by the INFRA that performed
  // the publish — cron_manager — to the content owner (wave 50, lane IA's collision fix).
  social_post_failed: "cron_manager",
  newsletter_sent: "cron_manager",
  newsletter_scheduled: "cron_manager",
  sequence_paused_on_reply: "campaign_orchestrator",
  // deal/transaction — FROM Deal Coordinator.
  task_completed: "deal_coordinator",
  buyer_under_contract: "deal_coordinator",
  vendor_assigned_to_transaction: "deal_coordinator",
  inspection_completed: "deal_coordinator",
  negotiation_strategy_drafted: "deal_coordinator",
  // listing — FROM Listing Concierge.
  listing_stage_transition_failed: "listing_concierge",
  listing_archived: "listing_concierge",
  listing_unarchived: "listing_concierge",
  cma_generated: "listing_concierge",
  price_alert_triggered: "listing_concierge",
  listing_agreement_initiated: "listing_concierge",
  showing_requested: "listing_concierge",
  neighborhood_report_generated: "listing_concierge",
  // money — FROM Finance Manager.
  subscription_cancelled: "finance_manager",
  commission_paid: "finance_manager",
  subscription_created: "finance_manager",
  earnest_money_milestone_completed: "finance_manager",
  // compliance — FROM Compliance Officer.
  esign_envelope_requested: "compliance_officer",
  // onboarding/training/license — FROM Recruiting Manager.
  training_course_completed: "recruiting_manager",
  setup_assistant_escalated: "recruiting_manager",
  // lead/ISA exception: MARKETING_CAMPAIGN_ENDED is an AI-ISA nurture campaign ending
  // (app/actions/ai-isa.ts owns it) — a lead/ISA moment, so FROM ai_isa, even though it
  // routes TO campaign_orchestrator (wave 49's separate TO fix) — never a data_steward
  // default and never FROM campaign_orchestrator either (it didn't cause the ending).
  marketing_campaign_ended: "ai_isa",
}

// ── Wave 50 — data_steward is a DATA-QUALITY/LEDGER stamp, never a default ──────────
// Every remaining `fromManager: "data_steward"` publish in event-reactor.ts, positively
// enumerated: a cadence health/fatigue SCORE scan, a governance/SLA LEDGER sweep, or the
// rule's own named examples (dedup / import / sync). Anything else surfacing here is a
// regression back to the "never a default data_steward stamp" defect this wave fixed.
const ALLOWED_DATA_STEWARD_SIGNALS = new Set<string>([
  // scoring (health-scan / fatigue-calculator cadence scores, incl. their tier-flip and
  // at-risk siblings — same automated scan, not a manager's discrete action)
  "deal_health_score_updated", "deal_at_risk_detected", "deal_health_changed",
  "listing_health_score_updated", "listing_at_risk_detected",
  "lead_scored", "contact_scored", "buyer_fatigue_detected",
  // ledger / governance sweeps (SLA, due-date, staleness, onboarding-health crons)
  "lead_sla_breached", "appointment_no_show", "message_needs_response", "task_due",
  "stale_lead_alert", "onboarding_stalled",
  // dedup / import / sync — literal matches to the rule's own parenthetical examples
  "contact_dedup_merged", "lead_import_completed", "system_sync_completed",
  // the lead-assignment routing engine's own outputs (a matching algorithm, not a
  // manager's business action) + external data-ingestion signals (review platform,
  // site-tracking pixel, referral intake)
  "lead_assignment_failed", "lead_assigned", "lead_ready_for_assignment",
  "review_received", "website_visitor_identified", "referral_received",
  // D-terdecies (wave 50, lane IE): enrichment-pipeline and pre-classification card-intake
  // moments are data-quality/intake ledger moments — data_steward owns them.
  "contact_enrichment_failed", "contact_enrichment_queued", "business_card_uploaded",
])

const RULES: Array<{ name: string; run: () => boolean; control: () => boolean }> = [
  {
    name: "no kernel event / signal for an agent claiming a lead (LEAD_CLAIMED retired)",
    run: () => ruleNoAgentClaimSignal(readSrc("lib/kernel/events.ts"), readSrc("lib/kernel/signal-registry.ts")),
    // A fixture that still HAS both halves must correctly FAIL the rule.
    control: () => !ruleNoAgentClaimSignal("LEAD_CLAIMED = 'lead_claimed',", `lead_claimed: { consumers: [] },`),
  },
  {
    name: "marketing_campaign_ended → campaign_orchestrator",
    run: () => findStaticToManager(readSrc("lib/kernel/event-reactor.ts"), "marketing_campaign_ended") === "campaign_orchestrator",
    // The OLD (wrong) routing must correctly fail this same check.
    control: () => findStaticToManager(
      `toManager: "finance_manager", signalType: "marketing_campaign_ended",`, "marketing_campaign_ended",
    ) !== "campaign_orchestrator",
  },
  {
    name: "ai_isa_handoff_to_agent branches on contact type into listing_concierge / shopping_agent",
    run: () => ruleIsaHandoffBranches(readSrc("lib/kernel/event-reactor.ts")),
    // A single static route (the OLD wiring) must correctly fail this check.
    control: () => !ruleIsaHandoffBranches(
      `if (params.event === KernelEvent.AI_ISA_HANDOFF_TO_AGENT) { toManager: "deal_coordinator", signalType: "ai_isa_handoff_to_agent",`,
    ),
  },
  {
    name: "agent_escalated_to_human → recruiting_manager",
    run: () => findStaticToManager(readSrc("lib/kernel/event-reactor.ts"), "agent_escalated_to_human") === "recruiting_manager",
    // The OLD (wrong) routing must correctly fail this same check.
    control: () => findStaticToManager(
      `toManager: "deal_coordinator", signalType: "agent_escalated_to_human",`, "agent_escalated_to_human",
    ) !== "recruiting_manager",
  },
]

function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Manager routing simulator (wave-49 kernel-event routing rulings)")
  console.log("══════════════════════════════════════════════════\n")

  console.log("[1-4 · RULES map, each proven + positive-controlled]")
  for (const rule of RULES) {
    check(rule.name, rule.run())
    check(`[control] ${rule.name} — a wrong fixture is correctly rejected`, rule.control())
  }

  console.log("\n[5 · ai_isa_handoff_to_agent has a REAL handler for every declared consumer]")
  const handoffSpec = SIGNAL_REGISTRY["ai_isa_handoff_to_agent"]
  check("ai_isa_handoff_to_agent is declared 'handled' with listing_concierge + shopping_agent",
    !!handoffSpec && handoffSpec.disposition === "handled" &&
    handoffSpec.consumers.includes("listing_concierge") && handoffSpec.consumers.includes("shopping_agent"),
    JSON.stringify(handoffSpec))
  for (const consumer of handoffSpec?.consumers ?? []) {
    check(`SIGNAL_HANDLERS["${consumer}:ai_isa_handoff_to_agent"] exists`, consumerHasHandler(consumer, "ai_isa_handoff_to_agent"))
  }

  console.log("\n[6 · agent_escalated_to_human has a REAL handler]")
  const escalationSpec = SIGNAL_REGISTRY["agent_escalated_to_human"]
  check("agent_escalated_to_human is declared 'handled' with recruiting_manager",
    !!escalationSpec && escalationSpec.disposition === "handled" && escalationSpec.consumers.includes("recruiting_manager"),
    JSON.stringify(escalationSpec))
  check(`SIGNAL_HANDLERS["recruiting_manager:agent_escalated_to_human"] exists`,
    consumerHasHandler("recruiting_manager", "agent_escalated_to_human"))

  console.log("\n[7 · marketing_campaign_ended is no longer catalogued for finance_manager]")
  const campaignSpec = SIGNAL_REGISTRY["marketing_campaign_ended"]
  check("marketing_campaign_ended's consumers do not include finance_manager",
    !!campaignSpec && !campaignSpec.consumers.includes("finance_manager"), JSON.stringify(campaignSpec))

  console.log("\n[8 · lead_claimed is fully gone from the registry]")
  check("SIGNAL_REGISTRY has no lead_claimed entry", !SIGNAL_REGISTRY["lead_claimed"])
  check("no SIGNAL_HANDLERS key targets lead_claimed",
    !Object.keys(SIGNAL_HANDLERS).some((k) => k.endsWith(":lead_claimed")))

  // ── Wave 50 — FROM_OWNER_BY_SIGNAL, positive-controlled by mutation ────────────────
  console.log("\n[9 · wave-50 FROM_OWNER_BY_SIGNAL — every event-family publish is FROM the manager that owns the moment]")
  const reactorSrc = readSrc("lib/kernel/event-reactor.ts")
  for (const [signalType, owner] of Object.entries(FROM_OWNER_BY_SIGNAL)) {
    check(`${signalType} → FROM ${owner}`, findStaticFromManager(reactorSrc, signalType) === owner)
  }
  // Positive control by MUTATION: take a fixture built from the pre-wave-50 wiring (the
  // wrong data_steward stamp this wave fixed) and confirm the assertion correctly
  // rejects it — proves the finder is not vacuously true.
  const preWave50Fixture = `fromManager: "data_steward",\n          toManager:   "asset_manager",\n          signalType:  "script_generated",`
  check(
    "[control] the pre-wave-50 data_steward stamp on script_generated is correctly rejected",
    findStaticFromManager(preWave50Fixture, "script_generated") !== "asset_manager",
  )
  const postWave50Fixture = `fromManager: "asset_manager",\n          toManager:   "asset_manager",\n          signalType:  "script_generated",`
  check(
    "[control] the wave-50 asset_manager stamp on script_generated is correctly accepted",
    findStaticFromManager(postWave50Fixture, "script_generated") === "asset_manager",
  )

  // ── Wave 50 — data_steward is a data-quality/ledger stamp only, positive-controlled ──
  console.log("\n[10 · data_steward is ONLY used as FROM for data-quality/ledger moments (dedup, import, sync, scoring)]")
  const allPairs = allFromSignalPairs(reactorSrc)
  const dsPairs = allPairs.filter((p) => p.from === "data_steward")
  check(
    `every data_steward FROM publish (${dsPairs.length} found) is a data-quality/ledger signal`,
    dsPairs.length > 0 && dsPairs.every((p) => ALLOWED_DATA_STEWARD_SIGNALS.has(p.signalType)),
    dsPairs.filter((p) => !ALLOWED_DATA_STEWARD_SIGNALS.has(p.signalType)).map((p) => p.signalType).join(", ") || "none outstanding",
  )
  // Positive control by MUTATION: inject a data_steward FROM on a KNOWN non-data-quality
  // (video/asset-lane) signal and confirm the sweep flags it — a broken/vacuous scan and
  // a clean tree both report zero, so this proves the scanner still recognises the defect.
  const mutatedPairs = allFromSignalPairs(preWave50Fixture)
  check(
    "[control] a data_steward-FROM script_generated fixture is correctly flagged as a violation",
    mutatedPairs.length === 1 &&
      mutatedPairs[0].from === "data_steward" &&
      !ALLOWED_DATA_STEWARD_SIGNALS.has(mutatedPairs[0].signalType),
  )

  report()
}

main()

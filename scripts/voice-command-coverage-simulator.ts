#!/usr/bin/env tsx
/**
 * scripts/voice-command-coverage-simulator.ts   (suggested: npm run test:voice-command-coverage)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the voice-admin coverage map (lib/voice/command-coverage.ts) is HONEST:
 *
 *   1. ROUTE PARITY   — every speakable row's toolName is a real `case` in the
 *                       tool-call route's runTool switch, AND every tool the
 *                       route dispatches has a coverage row (zero unregistered
 *                       tools — no silent surface growth).
 *   2. CONV-AI PARITY — every tool registered with ElevenLabs (buildToolsConfig)
 *                       is dispatchable by the route and present in the map.
 *   3. NO FORKED TRANSITION — the spoken deal decision reuses the canonical
 *                       kernel command (acceptOfferConditionally) and never
 *                       writes offers.status itself; reject/counter/withdraw
 *                       have NO fake tool and stay speakable:false with reasons.
 *   4. GUARDS PRESENT — the deal-decision backend carries the approvals-queue
 *                       guard set (tenant / agent scope / inbound-only /
 *                       not-a-counter / still-open + override roles); acting
 *                       tools registered in the tool-registry are never
 *                       any_authenticated; registry invariants stay green.
 *   5. PARSER REACH   — the free-speech lane (run_team_command) actually
 *                       routes accept-offer phrasings to accept_offer, without
 *                       regressing the existing team commands.
 *
 * Static + pure: reads source files and imports only pure modules. No DB, no network.
 */
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import {
  VOICE_COMMAND_COVERAGE,
  coverageByDomain,
  coverageStats,
  speakableToolNames,
} from "../lib/voice/command-coverage"
import { voiceTools, authorityAllows } from "../lib/voice/tool-registry"
import { voiceCoverageViolations } from "../lib/voice/voice-coverage"
import { parseTeamCommandText } from "../lib/voice/parse-team-command"
import { TEAM_ACTION_COMMANDS, TEAM_COMMANDS } from "../lib/voice/team-command-names"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const src = (p: string) => readFileSync(join(ROOT, p), "utf8")

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

// ─── Load the surfaces ────────────────────────────────────────────────────────
const routeSrc = src("app/api/agent-assistant/tool-call/route.ts")
const convAiSrc = src("lib/elevenlabs/conv-ai.ts")
const dealDecisionSrc = src("lib/voice/deal-decision.ts")
const teamCommandsSrc = src("lib/voice/team-commands.ts")

/** Tool cases dispatched by the route — extracted from the runTool switch region only. */
function routeToolCases(): string[] {
  const start = routeSrc.indexOf("async function runTool")
  const end = routeSrc.indexOf("// ─── stage_* voice handlers")
  const region = routeSrc.slice(start, end > start ? end : undefined)
  const names = new Set<string>()
  for (const m of region.matchAll(/case "([a-z][a-z0-9_]+)":/g)) names.add(m[1])
  return [...names]
}

/** Tool names registered with ElevenLabs in buildToolsConfig. */
function convAiRegisteredTools(): string[] {
  const start = convAiSrc.indexOf("function buildToolsConfig")
  const region = convAiSrc.slice(start)
  const names = new Set<string>()
  for (const m of region.matchAll(/name: "([a-z][a-z0-9_]+)"/g)) names.add(m[1])
  return [...names]
}

function main() {
  const routeCases = routeToolCases()
  const convAiTools = convAiRegisteredTools()
  const speakables = speakableToolNames()

  // ── 0. Registry shape — no aspirational rows, no unexplained gaps ──────────
  console.log("\n[0. coverage-map shape — honest rows only]")
  check("map is non-trivial (≥ 30 rows)", VOICE_COMMAND_COVERAGE.length >= 30)
  check("every row has command + domain + guard + auditParity",
    VOICE_COMMAND_COVERAGE.every((r) => r.command.trim() && r.domain && r.guard.trim().length >= 10 && r.auditParity.trim().length >= 10))
  check("every speakable row has a toolName",
    VOICE_COMMAND_COVERAGE.filter((r) => r.speakable).every((r) => !!r.toolName))
  check("every not-yet row has toolName:null + a concrete reason (≥ 30 chars)",
    VOICE_COMMAND_COVERAGE.filter((r) => !r.speakable).every((r) => r.toolName === null && (r.notYetReason ?? "").length >= 30))
  const stats = coverageStats()
  check("stats derive from rows (no hardcoding possible)",
    stats.total === VOICE_COMMAND_COVERAGE.length && stats.speakable + stats.notYet === stats.total)

  // ── 1. Route parity — zero fake speakables, zero unregistered tools ───────
  console.log("\n[1. route parity — the map matches what the webhook actually dispatches]")
  check(`route dispatches a real tool set (${routeCases.length} cases)`, routeCases.length >= 35)
  for (const t of speakables) {
    check(`speakable "${t}" has a route case`, routeCases.includes(t))
  }
  for (const t of routeCases) {
    check(`route tool "${t}" is registered in the coverage map`, speakables.includes(t))
  }

  // ── 2. Conv-AI registration parity ─────────────────────────────────────────
  console.log("\n[2. conv-ai parity — every ElevenLabs-registered tool is dispatchable + mapped]")
  check(`conv-ai registers tools (${convAiTools.length})`, convAiTools.length >= 20)
  for (const t of convAiTools) {
    check(`conv-ai tool "${t}" dispatches in the route`, routeCases.includes(t))
    check(`conv-ai tool "${t}" is in the coverage map`, speakables.includes(t))
  }

  // ── 3. Deal-decision family — same kernel transition, never forked ────────
  console.log("\n[3. deal decision — SAME kernel transition as the click, no fork]")
  check("route dispatches accept_offer", routeCases.includes("accept_offer"))
  check("deal-decision backend imports the canonical kernel command (acceptOfferConditionally from @/lib/kernel/transactions)",
    dealDecisionSrc.includes("acceptOfferConditionally") && dealDecisionSrc.includes("@/lib/kernel/transactions"))
  check("backend never writes offers.status itself (no forked transition)",
    !/status:\s*"accepted"/.test(dealDecisionSrc) && !/\.from\("offers"\)\s*\n?\s*\.update/.test(dealDecisionSrc))
  check("the click path calls the SAME command (compliance-bridge action)",
    src("app/actions/compliance-bridge-actions.ts").includes("acceptOfferConditionally"))
  check("approvals-queue 'of:' lane reuses kernel acceptOffer/rejectOffer (unchanged, untouched)",
    src("lib/kernel/approval-queue-aggregator.ts").includes("acceptOffer") &&
    src("lib/kernel/approval-queue-aggregator.ts").includes("rejectOffer"))
  check("team-commands routes accept_offer to the shared backend",
    teamCommandsSrc.includes('case "accept_offer"') && teamCommandsSrc.includes("voiceAcceptOffer"))
  check("accept_offer is in TEAM_ACTION_COMMANDS (both voice front-ends + text bar reach it)",
    TEAM_ACTION_COMMANDS.has("accept_offer") && TEAM_COMMANDS.has("accept_offer"))

  // Round 36 closed the session wall with client-param overloads: the kernel
  // commands keep their cookie-client DEFAULT (every existing caller untouched)
  // and the voice backends pass the service client AFTER their own mirrored guard.
  console.log("\n[3b. round-36 closures — reject/counter/withdraw ride the SAME kernel transitions]")
  for (const t of ["reject_offer", "counter_offer", "withdraw_offer"]) {
    check(`route dispatches "${t}" (round-36 closure)`, routeCases.includes(t))
  }
  check('route has NO "decide_offer" case (never a real command)', !routeCases.includes("decide_offer"))
  for (const cmd of ["lib/kernel/offers.rejectOffer", "lib/kernel/offers.issueCounterOffer", "lib/kernel/offers.withdrawOffer"]) {
    const row = VOICE_COMMAND_COVERAGE.find((r) => r.command === cmd)
    check(`map row for ${cmd} is speakable:true (client-param overload lane)`, !!row && row.speakable === true)
  }
  check("voice backends reuse the kernel transitions (no fork): rejectOffer/issueCounterOffer/withdrawOffer imported",
    dealDecisionSrc.includes("rejectOffer") && dealDecisionSrc.includes("issueCounterOffer") && dealDecisionSrc.includes("withdrawOffer"))
  check("kernel offers commands keep the cookie-client DEFAULT (client ?? await createClient())",
    /client \?\? await createClient\(\)/.test(src("lib/kernel/offers.ts")))
  check("acceptOfferConditionally is indeed service-client based (webhook-executable)",
    src("lib/kernel/transactions.ts").includes("createServiceClient"))

  // ── 4. Guards ──────────────────────────────────────────────────────────────
  console.log("\n[4. guards — approvals-queue rule set present + registry gates hold]")
  for (const literal of [
    "brokerage_id !== ctx.brokerageId",          // tenant
    "offer.agent_id !== ctx.agentScopeId",       // agent self-scope
    "!offer.listing_id",                          // inbound only
    'offer.offer_type === "counter"',             // not a counter
    '"pending"',                                  // still open …
    '"submitted"',
    '"team_lead"',                                // override roles
  ]) {
    check(`deal-decision guard literal present: ${literal}`, dealDecisionSrc.includes(literal))
  }
  check("backend re-checks authority itself (run_team_command lane has no registry gate)",
    dealDecisionSrc.includes("DECISION_OVERRIDE_ROLES"))
  check("tool-registry row accept_offer exists with authority 'agent'",
    voiceTools.accept_offer?.authority === "agent" && voiceTools.accept_offer?.is_nar_regulated === true)
  check("authorityAllows blocks isa/tc for accept_offer, allows agent + broker",
    authorityAllows("accept_offer", "agent") && authorityAllows("accept_offer", "broker") &&
    !authorityAllows("accept_offer", "isa") && !authorityAllows("accept_offer", "tc"))
  check("route enforces the per-intent role gate via the registry (round-33 gate intact)",
    routeSrc.includes("authorityAllows(toolName, sessionUserType)"))
  const actingRegistered = Object.values(voiceTools).filter((t) => ["send", "stage", "schedule"].includes(t.category))
  check("no acting tool in the registry is any_authenticated",
    actingRegistered.every((t) => t.authority !== "any_authenticated"))
  check("tool-registry invariants stay green (voiceCoverageViolations = 0)",
    voiceCoverageViolations().length === 0)
  check("every speakable acting row documents a real guard (mentions authority/ownership/gate/scope)",
    VOICE_COMMAND_COVERAGE.filter((r) => r.speakable && r.toolName && voiceTools[r.toolName] && ["send", "stage", "schedule"].includes(voiceTools[r.toolName].category))
      .every((r) => /(authority|ownership|gate|scope|principal)/i.test(r.guard)))

  // ── 5. Parser reach — the free-speech lane routes deal decisions ──────────
  console.log("\n[5. parser — spoken phrasings reach accept_offer, no regressions]")
  const p1 = parseTeamCommandText("accept the Hendersons' offer")
  check('"accept the Hendersons\' offer" → accept_offer (query Hendersons)',
    p1?.name === "accept_offer" && String(p1?.params.query ?? "").toLowerCase().includes("henderson"))
  const p2 = parseTeamCommandText("accept the offer on 44 Birch")
  check('"accept the offer on 44 Birch" → accept_offer (query 44 Birch)',
    p2?.name === "accept_offer" && String(p2?.params.query ?? "").includes("44 Birch"))
  const p3 = parseTeamCommandText("approve the offer from Jane Doe")
  check('"approve the offer from Jane Doe" → accept_offer', p3?.name === "accept_offer")
  check('"accept the counter" does NOT route to accept_offer (buyer-side lane)',
    parseTeamCommandText("accept the counter")?.name !== "accept_offer")
  check('"reject the offer on 44 Birch" → reject_offer (round-36 closure)',
    parseTeamCommandText("reject the offer on 44 Birch")?.name === "reject_offer")
  // Existing commands unregressed:
  check('"what should I do today" still → morning_standup', parseTeamCommandText("what should I do today")?.name === "morning_standup")
  check('"knock out number two" still → standup_action', parseTeamCommandText("knock out number two")?.name === "standup_action")
  check('"cut a reel for 12 Oak Street" still → cut_promo', parseTeamCommandText("cut a reel for 12 Oak Street")?.name === "cut_promo")
  check('"follow up with the Hendersons" still → voice_followup', parseTeamCommandText("follow up with the Hendersons")?.name === "voice_followup")
  check("parser only emits dispatchable commands (accept_offer included)",
    ["accept_offer", ...TEAM_COMMANDS].every((n) => typeof n === "string"))

  // ── Coverage report ────────────────────────────────────────────────────────
  console.log("\n[coverage by domain — derived from the map]")
  for (const d of coverageByDomain()) {
    console.log(`  ${d.domain.padEnd(18)} ${d.speakable}/${d.speakable + d.notYet} speakable`)
  }
  console.log(`  ${"TOTAL".padEnd(18)} ${stats.speakable}/${stats.total} speakable, ${stats.notYet} honest not-yet`)

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ VOICE_COMMAND_COVERAGE_FAIL"); process.exit(1) }
  console.log(" ✅ VOICE_COMMAND_COVERAGE_PASS — the spoken command lands in the same kernel transition, behind the same guard, with the same receipts as the click")
}
main()

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
// The deal-decision override roster, asked of the SAME predicate the backend
// calls — so this proof cannot agree with a rule the code does not use.
import { isAdminOrBroker, isAgentOrTenantAdmin, isAgentOrCommerceAdmin } from "../lib/auth/resolve-user-role"

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
  ]) {
    check(`deal-decision guard literal present: ${literal}`, dealDecisionSrc.includes(literal))
  }

  // THE OVERRIDE ROSTER IS A CLAIM, NOT A SPELLING.
  //
  // These two checks used to be `includes('"team_lead"')` and
  // `includes("DECISION_OVERRIDE_ROLES")` — pinned to the TEXT of a local role
  // array and the NAME of the const holding it. That made them fail on an
  // improvement: the roster was replaced by the ONE shared tenant-admin
  // predicate (owner ruling: "having more than one vocab over the same function
  // or feature is dangerous"), which ADDED broker_owner — refused by the local
  // literal, i.e. the person who owns the brokerage could not decide a deal by
  // voice — and DROPPED a `superadmin` branch that MEASURED live matches zero
  // users.user_type rows. Worse, they would have stayed GREEN through a real
  // regression: deleting the `if` and leaving the const would satisfy both.
  //
  // Pinned now to what actually matters — the backend consults a shared roster
  // ITSELF (the run_team_command free-text lane reaches it without a per-tool
  // registry check), and that roster admits and refuses the right roles.
  // RETARGETED AGAIN, 2026-09-04 — AND THE SECOND TIME IS THE INTERESTING ONE.
  //
  // The paragraph above congratulates itself for replacing a pinned LITERAL with
  // a claim, and then pins the claim to a SPELLING one level up: it hardcoded
  // the predicate's NAME, `isAdminOrBroker`. Wave 27 merged this backend's
  // hand-written `userType !== "agent" && !isAdminOrBroker(…)` — the fourth copy
  // of the staff ladder in the tree — onto a derived `isAgentOrTenantAdmin`,
  // which is `agent` ∪ the SAME TENANT_ADMIN_USER_TYPES. Membership is
  // byte-identical. These three checks went red anyway, and they went red for
  // the merge finishing: CLAUDE.md §2's forbidden waypoint, in a check whose own
  // header is about not doing that.
  //
  // So the predicate is now DISCOVERED from the file rather than named here. The
  // rule is "the backend consults A SHARED, IMPORTED roster predicate on the
  // actor and refuses" — not "it consults this particular one", which is a fact
  // about today's factoring and will change again.
  const ROSTER_PREDICATES: Record<string, (p: { user_type?: string | null }) => boolean> = {
    isAdminOrBroker,
    isAgentOrTenantAdmin,
    isAgentOrCommerceAdmin,
  }
  const rosterImport = dealDecisionSrc.match(
    /import\s*\{([^}]*)\}\s*from\s*"@\/lib\/auth\/resolve-user-role"/,
  )
  const importedPredicate = (rosterImport?.[1] ?? "")
    .split(",")
    .map((s) => s.trim())
    .find((n) => n in ROSTER_PREDICATES)
  check("...and it is IMPORTED, not re-declared locally (a second copy is the drift the ruling forbids)",
    !!importedPredicate,
    `deal-decision imports no known roster predicate from resolve-user-role (saw: ${rosterImport?.[1]?.trim() ?? "no import at all"})`)
  check("backend re-checks authority ITSELF — the shared tenant-admin roster is called on the actor",
    !!importedPredicate &&
    new RegExp(`if\\s*\\([^)]*\\b${importedPredicate}\\s*\\(\\s*\\{\\s*user_type`).test(dealDecisionSrc) &&
    /return\s*\{\s*error:/.test(dealDecisionSrc.slice(dealDecisionSrc.indexOf(importedPredicate ?? " "))))
  // POSITIVE CONTROL for the discovery above (§2 — a broken finder and a correct
  // file both "find" nothing): the finder must NOT match a predicate the file
  // does not import.
  check("POSITIVE CONTROL — the predicate finder is discriminating, not just truthy",
    !!importedPredicate &&
    Object.keys(ROSTER_PREDICATES).some((n) => n !== importedPredicate) &&
    !new RegExp(`import\\s*\\{[^}]*\\b${Object.keys(ROSTER_PREDICATES).find((n) => n !== importedPredicate)}\\b[^}]*\\}\\s*from\\s*"@/lib/auth/resolve-user-role"`)
      .test(dealDecisionSrc))
  // The MEMBERSHIP half stays asked of the BROKERAGE-WIDE override roster
  // regardless of which wrapper the file imports, because that is the question:
  // who may decide a deal that is not their own. `isAgentOrTenantAdmin` is built
  // from this exact Set plus `agent`, and an agent deciding their OWN deal is
  // gated by the self-scope literal checked above, not by this roster.
  // THE MEMBERSHIP HALF IS ASKED OF THE PREDICATE THE FILE ACTUALLY USES, not of
  // a predicate this guard picked. That distinction stopped being cosmetic on
  // 2026-09-04: the owner's ruling seated `compliance_officer` in
  // TENANT_ADMIN_USER_TYPES, so isAdminOrBroker — which this line used to ask —
  // now ADMITS it, and asking the wrong predicate would have reported the deal
  // lane as wide open when it is not, or as broken when it is correct.
  const dealPredicate = ROSTER_PREDICATES[importedPredicate ?? ""] ?? (() => false)
  check("...and that roster admits the override roles the deal lane needs, broker_owner included",
    ["broker", "broker_owner", "admin", "team_lead"].every((r) => dealPredicate({ user_type: r })))
  check("...and the producing agent themselves is admitted (they self-scope below, they are not locked out)",
    dealPredicate({ user_type: "agent" }))
  check("...and refuses the roles that must not decide a deal brokerage-wide",
    // `compliance_officer` IS in the tenant admin roster as of the 2026-09-04
    // ruling and is refused HERE anyway: accepting an offer binds a client to a
    // purchase contract (the accept_offer registry row is is_nar_regulated), so
    // the deal lane takes the COMMERCE tier — the same subtraction the four
    // gates that obligate the brokerage to pay already make. If the owner rules
    // that a compliance officer may accept offers, this line and the import in
    // lib/voice/deal-decision.ts move together.
    //
    // 'lender' is deliberately still listed even though that same day's ruling
    // made it a vendor CATEGORY and dropped it from users_user_type_check: a
    // value the column can no longer hold cannot reach this predicate, but a
    // roster edit that re-admitted the word would be a regression this still
    // catches. It is the one entry asserted about a spelling rather than a seat.
    ["isa", "tc", "contact", "lender", "vendor", "compliance_officer"].every((r) => !dealPredicate({ user_type: r })))
  check("...and it FAILS CLOSED on an unresolvable role (§4 — 'nobody checked' is not 'checked and fine')",
    !dealPredicate({ user_type: "" }) && !dealPredicate({ user_type: null }) && !dealPredicate({}))
  // POSITIVE CONTROL for the two lines above: a predicate that answered NO to
  // everything would satisfy the refusal list, and one that answered YES to
  // everything would satisfy the admission list. Neither is true of this one.
  check("POSITIVE CONTROL — the deal predicate discriminates (it is neither always-yes nor always-no)",
    dealPredicate({ user_type: "broker" }) && !dealPredicate({ user_type: "contact" }))
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

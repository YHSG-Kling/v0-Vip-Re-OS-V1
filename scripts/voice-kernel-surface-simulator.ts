#!/usr/bin/env tsx
/**
 * scripts/voice-kernel-surface-simulator.ts (npm run test:voice-kernel-surface)
 * ─────────────────────────────────────────────────────────────────────────────
 * "A VOICE AGENT ADMIN THAT TAKES COMMANDS AND DOES IT" — over the KERNEL, on the BUS.
 *
 * The audit found handleVoiceCommand already good: an authority matrix, business
 * readiness rules, and COMMAND_EXECUTORS statically imported so tsc guarantees every
 * mapped command resolves (an earlier round fixed a runtime-string dynamic import that
 * silently failed on Vercel). Those 16 commands remain the DIRECT lane and are not
 * touched. Three things they could not do:
 *
 *   1. The surface was a HAND-KEPT 16-entry map while the kernel exposes 28 app
 *      capabilities — most of the OS was unspeakable, and a NEW capability never
 *      became speakable. The kernel lane derives its surface from the same registry
 *      that powers /api/agentic-os/actions and the MCP tools/list.
 *   2. A MULTI-STEP instruction could not be expressed. "Spin up a two-week plan for
 *      123 Main and send the seller a reel" is three capabilities owned by three
 *      managers; inline that is three unattributed calls with no approval trail.
 *   3. It validated business readiness but NOT capability operability — so voice could
 *      accept "post that to Instagram" and fail mid-command on a tenant with no social
 *      account.
 *
 * The interesting assertions are about RESTRAINT, because a voice surface that
 * triggers real sends is the most dangerous one in the product:
 *
 *   · three capabilities are DELIBERATELY unspeakable (money, the books, a deal's
 *     legal stage) — not an oversight, a decision, pinned here;
 *   · the gate order is authorization → operability → confirmation, which is the
 *     inconvenient order on purpose: telling someone what they COULD do if they were
 *     allowed is an information leak dressed as helpfulness;
 *   · phrase matching is conservative and can MISS a paraphrase, which costs a
 *     rephrase, rather than invent an intent, which costs a client;
 *   · an unmatched utterance says so, and never fabricates an action.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import {
  VOICE_PHRASES, VOICE_WITHHELD, voiceCapabilities, matchIntents, buildVoicePlan, humanManager,
  VOICE_COMMAND_SIGNAL,
} from "../lib/voice-admin/kernel-command-surface"
import { APP_CAPABILITY_REGISTRY, type AppCapability } from "../lib/agentic-os/app-capability-registry"
import { CAPABILITY_MANAGER } from "../lib/agentic-os/capability-ownership"
import { MANAGERS, MAINTENANCE_DOMAINS } from "../lib/kernel/manager-registry"
import { SIGNAL_REGISTRY } from "../lib/kernel/signal-registry"
import { classifyCoordination } from "../lib/kernel/coordination-kind"
import { COMMAND_MAP } from "../app/actions/voice-assistant/helpers/command-map"
import { stripComments } from "./strip-comments"
import { assistantReachMatrix, reachGaps, assistantSkillRefusal, composeManagerStatus } from "../lib/voice-admin/assistant-reach"
import { VOICE_NEVER_SPOKEN } from "../lib/voice-admin/kernel-command-surface"
import { voiceTools, VOICE_TOOL_MANAGER } from "../lib/voice/tool-registry"
import { TEAM_COMMAND_MANAGER } from "../lib/kernel/ai-teammates"
import { MANAGER_SKILLS } from "../lib/kernel/skill-registry"
import { parseTeamCommandText } from "../lib/voice/parse-team-command"
import { BROKER_COMMANDS } from "../lib/voice/team-command-names"
import { speakableToolNames } from "../lib/voice/command-coverage"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail?: string) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; fails.push(n + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${n}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => (existsSync(join(process.cwd(), p)) ? readFileSync(join(process.cwd(), p), "utf8") : "")
/** Source with comments removed. Both files below DOCUMENT the old pattern by name —
 *  the planner explains why it does not call COMMAND_EXECUTORS, and the executors
 *  file records the runtime-string import it replaced — so a raw search trips on the
 *  very explanation that proves the code is right. */
// stripComments already removes TRAILING line comments, so the per-line pass that
// used to follow it is gone. It was not merely redundant: `(^|\s)//.*$` fires on the
// slashes inside any string holding a URL, so it deleted the tail of every line
// carrying one — a blind spot bolted on to cover the anchored regex that could not
// see a trailing comment in the first place.
const code = (p: string) => stripComments(src(p))

console.log("══════════════════════════════════════════════════")
console.log(" Voice admin — a command surface over the kernel, dispatched onto the bus")
console.log("══════════════════════════════════════════════════")

const ALL_CAPS = Object.keys(APP_CAPABILITY_REGISTRY) as AppCapability[]
const allow = (caps: AppCapability[]) =>
  Object.fromEntries(caps.map((c) => [c, true])) as Partial<Record<AppCapability, boolean>>

console.log("\n[the surface is DERIVED from the kernel, not hand-kept]")
{
  const spoken = voiceCapabilities()
  check("every speakable capability is a REAL kernel capability",
    spoken.every((v) => !!APP_CAPABILITY_REGISTRY[v.capability]))
  check("…and carries the manager that owns it, from the ownership map",
    spoken.every((v) => v.manager === CAPABILITY_MANAGER[v.capability] && v.manager in MANAGERS))
  check("…and its mutates flag comes from the registry, never restated",
    spoken.every((v) => v.mutates === APP_CAPABILITY_REGISTRY[v.capability].mutates))

  // The point of deriving: the OLD surface covered 16; the kernel exposes 28.
  const directLane = Object.keys(COMMAND_MAP).length
  console.log(`  · direct lane: ${directLane} commands · kernel lane: ${spoken.length} of ${ALL_CAPS.length} capabilities`)
  check("the kernel lane reaches MORE of the OS than the hand-kept map did",
    spoken.length > directLane, `${spoken.length} vs ${directLane}`)
  check("every capability is either speakable or DELIBERATELY withheld — none forgotten",
    ALL_CAPS.every((c) => c in VOICE_PHRASES || (VOICE_WITHHELD as readonly string[]).includes(c)),
    ALL_CAPS.filter((c) => !(c in VOICE_PHRASES) && !(VOICE_WITHHELD as readonly string[]).includes(c)).join(", "))
  check("no phrase list is empty — a capability with no phrase is unreachable by accident",
    Object.values(VOICE_PHRASES).every((p) => (p?.length ?? 0) > 0))
}

console.log("\n[what voice must NEVER be able to say]")
{
  // Money, the books, and a deal's legal stage. Not an oversight — a decision.
  for (const withheld of VOICE_WITHHELD) {
    check(`${withheld} is NOT speakable`, !(withheld in VOICE_PHRASES))
    check(`…and no utterance reaches it`,
      !matchIntents("transfer the money and sync the books and advance the transaction")
        .some((m) => m.capability === withheld))
  }
  check("the withheld list names only real capabilities (no dead entries)",
    VOICE_WITHHELD.every((c) => !!APP_CAPABILITY_REGISTRY[c]))
  check("…and the reason is recorded where the decision lives",
    /moves money/.test(src("lib/voice-admin/kernel-command-surface.ts")) &&
    /legal stage/.test(src("lib/voice-admin/kernel-command-surface.ts")))
}

console.log("\n[a multi-step instruction becomes a multi-manager PLAN]")
{
  // THE demo sentence. Three capabilities, three different managers.
  const utterance = "spin up a two week plan for 123 Main and run a cma and send them the reel"
  const intents = matchIntents(utterance)
  check("one sentence resolves to SEVERAL capabilities, not one best guess",
    intents.length >= 3, `${intents.length}`)
  const caps = intents.map((i) => i.capability)
  check("…the campaign, the CMA and the video are all recognised",
    caps.includes("marketing_campaign_create") && caps.includes("cma_generate") &&
    caps.includes("video_distribute"))
  const managers = new Set(intents.map((i) => i.manager))
  check("…owned by MORE THAN ONE manager, which is the whole point",
    managers.size >= 2, [...managers].join(", "))
  check("most specific phrase wins per capability (no double-count)",
    new Set(caps).size === caps.length)

  const plan = buildVoicePlan(utterance, {
    operable: allow(caps), authorized: allow(caps), confirmed: true,
  })
  check("the plan has one step per capability", plan.steps.length === intents.length)
  check("…each attributed to its owning manager",
    plan.steps.every((s) => s.manager === CAPABILITY_MANAGER[s.capability]))
  check("…and speaks the manager as a PERSON, not a registry key",
    plan.spokenSummary.includes("your") && !/campaign_orchestrator/.test(plan.spokenSummary))
  check("the spoken summary names what it is doing", /On it/.test(plan.spokenSummary))
}

console.log("\n[nothing that changes anything runs on ONE sentence]")
{
  const caps: AppCapability[] = ["cma_generate", "social_post_publish"]
  const unconfirmed = buildVoicePlan("run a cma and post to social", {
    operable: allow(caps), authorized: allow(caps),
  })
  check("mutating steps come back needing CONFIRMATION, not done",
    unconfirmed.steps.every((s) => s.disposition === "needs_confirmation") &&
    unconfirmed.awaitingConfirmation === unconfirmed.steps.length)
  check("…and the plan is NOT actionable until confirmed", !unconfirmed.actionable)
  check("…and it asks out loud, naming who would take it",
    /say yes/.test(unconfirmed.spokenSummary) && /your/.test(unconfirmed.spokenSummary))

  const confirmed = buildVoicePlan("run a cma and post to social", {
    operable: allow(caps), authorized: allow(caps), confirmed: true,
  })
  check("a confirmed turn makes them ready", confirmed.actionable &&
    confirmed.steps.every((s) => s.disposition === "ready"))

  // A read needs no confirmation — asking what's on your plate must not be a ceremony.
  const read = buildVoicePlan("find leads", { operable: allow(["lead_search"]), authorized: allow(["lead_search"]) })
  check("a READ runs without confirmation", read.actionable && read.steps[0].disposition === "ready")
  check("…because the registry says it does not mutate",
    APP_CAPABILITY_REGISTRY.lead_search.mutates === false)
}

console.log("\n[the gate order is the inconvenient one, on purpose]")
{
  const caps: AppCapability[] = ["social_post_publish"]
  // AUTHORIZATION FIRST. Telling someone what they could do if they were allowed is
  // an information leak dressed as helpfulness.
  const unauth = buildVoicePlan("post to social", {
    operable: { social_post_publish: false }, authorized: { social_post_publish: false },
    blockReason: { social_post_publish: "Connect one of: meta, linkedin." }, confirmed: true,
  })
  check("an unauthorized capability is refused as UNAUTHORIZED, not as 'not connected'",
    unauth.steps[0].disposition === "not_authorized")
  check("…and the refusal does NOT leak what would have been missing",
    !/meta/.test(unauth.steps[0].say) && !/connect/i.test(unauth.steps[0].say))

  // OPERABILITY SECOND — refused BEFORE the speaker is promised anything.
  const dark = buildVoicePlan("post to social", {
    operable: { social_post_publish: false }, authorized: allow(caps),
    blockReason: { social_post_publish: "Connect one of: meta, linkedin." }, confirmed: true,
  })
  check("an authorized-but-DARK capability is refused up front",
    dark.steps[0].disposition === "not_operable" && !dark.actionable)
  check("…naming what is missing, because this one the broker CAN fix",
    /meta/.test(dark.steps[0].say))
  check("…and it never asks for confirmation of something it cannot do",
    dark.awaitingConfirmation === 0)

  // A mixed sentence: do what you can, say what you cannot.
  const mixed = buildVoicePlan("find leads and post to social", {
    operable: { lead_search: true, social_post_publish: false },
    authorized: { lead_search: true, social_post_publish: true },
    blockReason: { social_post_publish: "Connect one of: meta, linkedin." }, confirmed: true,
  })
  check("a mixed instruction does the possible part and reports the rest",
    mixed.actionable && /cannot/.test(mixed.spokenSummary))
}

console.log("\n[it would rather MISS than invent]")
{
  check("an unrelated sentence matches nothing",
    matchIntents("what a nice day it is outside").length === 0)
  check("…and says so plainly instead of fabricating an action",
    /did not catch a command/.test(
      buildVoicePlan("what a nice day", { operable: {}, authorized: {} }).spokenSummary))
  check("empty input is safe", matchIntents("").length === 0 && matchIntents("   ").length === 0)
  check("punctuation and casing do not defeat it",
    matchIntents("RUN A CMA, please!").some((m) => m.capability === "cma_generate"))
  check("a single generic word does NOT trigger a send",
    matchIntents("send").length === 0 && matchIntents("post").length === 0)
  check("…while the specific phrase does",
    matchIntents("send a postcard").some((m) => m.capability === "direct_mail_send"))
  check("every phrase is multi-word or specific enough not to misfire",
    Object.values(VOICE_PHRASES).flat().every((p) => (p as string).includes(" ") || (p as string).length >= 8),
    Object.values(VOICE_PHRASES).flat().filter((p) => !(p as string).includes(" ") && (p as string).length < 8).join(", "))
}

console.log("\n[the work lands on the bus, attributed]")
{
  const planner = src("lib/voice-admin/plan-voice-command.ts")
  check("the planner exists", planner.length > 0)
  check("it dispatches manager signals rather than calling actions inline",
    /publishManagerSignal/.test(planner) &&
    !/COMMAND_EXECUTORS/.test(code("lib/voice-admin/plan-voice-command.ts")))
  check("…only on a CONFIRMED turn", /if \(!input\.confirmed\) return result/.test(planner))
  check("…only the READY steps", /disposition === "ready"/.test(planner))
  check("operability comes from the capability contract, not a second guess",
    /resolveAllAppCapabilities/.test(planner))
  check("authorization rides the SAME scope machinery the Agentic API uses",
    /authorizedActions/.test(planner))
  check("the signal is carried by operations so the receiver is never the sender",
    /step\.manager === "cron_manager" \? "data_steward" : "cron_manager"/.test(planner))
  check("entity_id is null — a capability name is not a uuid (the earlier lesson)",
    /entityId: null/.test(planner) && /is not one/.test(planner))
  check("a FAILED dispatch is counted and changes what the voice says",
    /result\.failed\.push/.test(planner) && /did not start/.test(planner))
  check("…and it never throws mid-sentence", /result\.error = e instanceof Error/.test(planner))
  check("an unmatched utterance costs NO database work",
    /if \(intents\.length === 0\)/.test(planner))

  check("the signal is catalogued", VOICE_COMMAND_SIGNAL in SIGNAL_REGISTRY)
  const spec = SIGNAL_REGISTRY[VOICE_COMMAND_SIGNAL]
  check("…as a handoff, matching the live classifier",
    spec?.kind === "handoff" && classifyCoordination(VOICE_COMMAND_SIGNAL) === "handoff")
  check("…feed_only, because the manager's own rails govern what happens next",
    spec?.disposition === "feed_only" && /must not bypass them/.test(spec?.what ?? ""))
}

console.log("\n[the direct lane is untouched — no regression]")
{
  // The 16 working commands keep working. Consolidation means ADDING a lane, not
  // rewriting a validated one.
  const executors = src("app/actions/voice-assistant/helpers/command-executors.ts")
  check("COMMAND_EXECUTORS still covers every mapped command 1:1",
    Object.keys(COMMAND_MAP).every((k) => new RegExp(`\\b${k}:`).test(executors)))
  const executorCode = code("app/actions/voice-assistant/helpers/command-executors.ts")
  check("…still statically imported (the Vercel dynamic-import fix survives)",
    /^import \{/m.test(executorCode) && !/import\(mapping\.module_path\)/.test(executorCode))
  check("handleVoiceCommand still validates authority AND readiness",
    /validateAuthority/.test(src("app/actions/voice-assistant/handle-voice-command.ts")) &&
    /validateReadiness/.test(src("app/actions/voice-assistant/handle-voice-command.ts")))
  check("the kernel lane does not import the direct lane's executors",
    !/command-executors/.test(src("lib/voice-admin/plan-voice-command.ts")))
}

console.log("\n[the whole team, 24/7 — the assistant's reach matrix (wave 138E)]")
{
  const rows = assistantReachMatrix()
  const managers = Object.keys(MANAGERS)
  console.log(`     reach matrix (manager: speak/tool/skill · explain) — ${rows.map((r) => `${r.manager}: ${r.speak.length}/${r.tools.length}/${r.skills.length}·E${r.exempt ? " (exempt)" : ""}`).join(" · ")}`)
  console.log(`     denominator: ${managers.length} tenant managers × 4 doors; ${Object.keys(CAPABILITY_MANAGER).length} catalogue capabilities; ${Object.keys(voiceTools).length} assistant tools`)
  check("RM1 the matrix has a row for EVERY tenant manager (derived from MANAGERS, none hand-listed) and every row has the explain door",
    rows.length === managers.length && managers.every((m) => rows.some((r) => r.manager === m && r.explain === true)))
  const gaps = reachGaps(rows)
  check("RM2 every manager is COMMANDABLE through a governed door (speak / tool / skill) or carries a NAMED reason; no reason is stale",
    gaps.unreachable.length === 0 && gaps.staleExempt.length === 0, JSON.stringify(gaps))
  {
    const planted = [
      { ...rows[0], speak: [], tools: [], skills: [], commandable: false, exempt: null },
      { ...rows[1], commandable: true, exempt: "a reason that outlived its gap" },
    ]
    const g = reachGaps(planted)
    check("RM3 (POSITIVE CONTROL) the census recognises both defects — a door-less manager with no reason, and a stale reason",
      g.unreachable.includes(rows[0].manager) && g.staleExempt.includes(rows[1].manager), JSON.stringify(g))
  }
  check("RM4 the exemptions are reasons, not silence (every exempt row says why in a sentence)", rows.filter((r) => r.exempt).every((r) => (r.exempt ?? "").length >= 40))
  // The skill door's restraint — by RISK and by the never-spoken capabilities, so a marketplace skill cannot route around it.
  const refusedMoney = MANAGER_SKILLS.filter((s) => s.required_capabilities.some((c) => (VOICE_NEVER_SPOKEN as readonly string[]).includes(c)))
  check(`RM5 every built-in skill needing money / the books / a deal's legal stage is refused by the assistant (${refusedMoney.length})`,
    refusedMoney.length >= 3 && refusedMoney.every((s) => assistantSkillRefusal(s) !== null) && rows.every((r) => r.skills.every((n) => !refusedMoney.some((s) => s.name === n))))
  check("RM6 FINANCIAL / LEGAL / IRREVERSIBLE risk is refused even with harmless capabilities; a LOW_RISK_WRITE read-path skill passes (control)",
    (["FINANCIAL", "LEGAL", "IRREVERSIBLE"] as const).every((risk) => assistantSkillRefusal({ risk_class: risk, required_capabilities: ["lead_search"] }) !== null) &&
    assistantSkillRefusal({ risk_class: "LOW_RISK_WRITE", required_capabilities: ["lead_search"] }) === null)
  check("RM7 VOICE_WITHHELD still contains the never-spoken three (the kernel voice lane's own withhold is unchanged)",
    VOICE_NEVER_SPOKEN.every((c) => (VOICE_WITHHELD as readonly string[]).includes(c)) && VOICE_NEVER_SPOKEN.length === 3)
  // ONE tool → manager answer.
  const vtm = Object.keys(VOICE_TOOL_MANAGER)
  check("RM8 every VOICE_TOOL_MANAGER key is a registered assistant tool, owned by a real manager, and disjoint from the custom-teammate attribution",
    vtm.every((t) => t in voiceTools && (VOICE_TOOL_MANAGER as Record<string, string>)[t] in MANAGERS) && vtm.every((t) => !(t in TEAM_COMMAND_MANAGER)),
    vtm.filter((t) => !(t in voiceTools) || t in TEAM_COMMAND_MANAGER).join(","))
  const busCode = code("lib/voice/voice-bus.ts")
  check("RM9 the voice bus reads the SAME table (no second per-tool switch)", /VOICE_TOOL_MANAGER\[tool\]/.test(busCode) && !/case "create_task"/.test(busCode))
  // Every manager can be NAMED in free speech and lands on manager_status.
  const unnamed = managers.filter((m) => {
    const p = parseTeamCommandText(`what is the ${MANAGERS[m as keyof typeof MANAGERS].label} working on?`)
    return !(p?.name === "manager_status" && p.params.manager === m)
  })
  check("RM10 every manager is nameable: 'what is the <label> working on?' parses to manager_status for THAT manager", unnamed.length === 0, unnamed.join(","))
  check("RM11 the parser routes the other two doors and keeps its old routes (control: 'status of 44 Birch' stays team_query)",
    parseTeamCommandText("objective: grow listings 10% in our farm")?.name === "broker_objective" &&
    parseTeamCommandText("run skill lead qualification pass for the new leads")?.params.skill === "lead_qualification_pass" &&
    parseTeamCommandText("team status")?.name === "manager_status" &&
    parseTeamCommandText("status of 44 Birch")?.name === "team_query" &&
    parseTeamCommandText("what should I do today")?.name === "morning_standup")
  // Governed paths only: each backend gates the tenant-admin roster BEFORE its kernel call, and calls only kernel services.
  const tc = code("lib/voice/team-commands.ts")
  const caseBody = (name: string) => { const i = tc.indexOf(`case "${name}":`); return i < 0 ? "" : tc.slice(i, tc.indexOf("case \"", i + 10) > 0 ? tc.indexOf("case \"", i + 10) : tc.length) }
  const gated = (name: string, kernelCall: RegExp) => { const b = caseBody(name); const g = b.indexOf("tenantAdminRefusal("); const k = b.search(kernelCall); return g >= 0 && k > g }
  check("RM12 manager_status / broker_objective / run_skill each gate the tenant-admin roster BEFORE their kernel call (pendingDelegationsFor · submitBrokerObjective · runSkill)",
    gated("manager_status", /pendingDelegationsFor\(/) && gated("broker_objective", /submitBrokerObjective\(/) && gated("run_skill", /runSkill\(/))
  check("RM13 the gate is the ONE roster (resolveTenantAdmin) and fails closed on an unreadable role", /async function tenantAdminRefusal[\s\S]{0,700}if \(error \|\| !me\) return[\s\S]{0,400}resolveTenantAdmin\([\s\S]{0,300}if \(!r\.ok\) return/.test(tc))
  check("RM14 run_skill refuses by the assistant rule BEFORE runSkill (assistantSkillRefusal → runSkill)", (() => { const b = caseBody("run_skill"); const a = b.indexOf("assistantSkillRefusal("); return a > 0 && b.indexOf("runSkill(", a) > a })())
  const reach = code("lib/voice-admin/assistant-reach.ts")
  check("RM15 the matrix module is PURE: no table read, no fetch, no provider (never LLM → SQL)", !/\.from\(|fetch\(|createServiceClient|createClient/.test(reach))
  check("RM16 every new door is WIRED: registry rows (authority admin), the broker-lane set, the tool-call route, the coverage map",
    ["manager_status", "broker_objective", "run_skill"].every((t) => voiceTools[t]?.authority === "admin" && BROKER_COMMANDS.has(t) && new RegExp(`case "${t}":`).test(code("app/api/agent-assistant/tool-call/route.ts")) && speakableToolNames().includes(t)))
  {
    const withRefusal = composeManagerStatus("ads_manager", [], [], ["ads: permission denied"])
    const clean = composeManagerStatus("ads_manager", [], [], [])
    check("RM17 a refused source is SPOKEN, never rendered as 'nothing' (control: a clean read does not say it)", /could not read/.test(withRefusal) && !/could not read/.test(clean))
  }
  check("RM18 the activity read-model reports refusals to a caller that asks (onRefused), the feed's callers unchanged",
    /onRefused\?: \(source: ManagerActivitySource, message: string\) => void/.test(code("lib/kernel/manager-activity.ts")) && /if \(res\.error\) onRefused\(/.test(code("lib/kernel/manager-activity.ts")))
  console.log(" BLIND SPOTS (138E reach): the matrix proves a DOOR exists per manager, not that every capability inside it is operable for a given tenant (plan-voice-command's operability gate and runSkill's entitlement gate decide that at call time); the three new commands are proven by source order + pure parsing, not against a live session; the ElevenLabs agent reaches them through run_team_command's free-text bridge (conv-ai buildToolsConfig was not changed).")
}

console.log("\n[a manager owns it]")
{
  const d = MAINTENANCE_DOMAINS.voice_kernel_command_surface
  check("the feature has an accountable manager", d?.manager === "cron_manager")
  check("…a real seat", (d?.manager ?? "") in MANAGERS)
  check("…proved by this script", d?.proof === "test:voice-kernel-surface")
  check("package.json wires it", /test:voice-kernel-surface/.test(src("package.json")))
  check("humanManager speaks every manager as a person",
    Object.keys(MANAGERS).every((k) => !humanManager(k as any).includes("_")))
}

console.log("\n──────────────────────────────────────────────────")
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ VOICE_KERNEL_SURFACE_FAIL"); process.exit(1) }
console.log(" ✅ VOICE_KERNEL_SURFACE_PASS — voice in, governed multi-manager work out")

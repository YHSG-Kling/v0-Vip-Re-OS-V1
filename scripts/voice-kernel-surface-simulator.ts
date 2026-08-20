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

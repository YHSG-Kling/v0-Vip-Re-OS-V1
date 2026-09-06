#!/usr/bin/env tsx
/**
 * scripts/lifecycle-recording-simulator.ts (npm run test:lifecycle-recording)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE OS COULD NOT BE TOLD WHAT HAPPENED, AND ANYONE COULD TELL IT ANYTHING.
 *
 * app/actions/seller-listing/execution-engine.ts is the seller listing lifecycle:
 * twenty-three governed recorders that drive the kernel stage machine, write the
 * `activities` rows the AI reads back as the relationship, and emit
 * lifecycle_events. Two findings, and the second is the serious one.
 *
 * ── 1. TWELVE RECORDERS HAD NO CALLER ANYWHERE ─────────────────────────────
 * recordSellerDecision, initiateListingAgreement, markDripCompleted,
 * recordPreListingRepair, markRepairCompleted, markRepairFailed,
 * markMediaCaptured, markMLSReady, recordShowingCompleted, markUnderContract,
 * cancelListing, markListingExpired. Several of the wired ones were reachable
 * ONLY by speaking to the voice assistant, never from a screen.
 *
 * Meanwhile the Pre-Listing Workflow panel showed the agent a progress bar it
 * GUESSED at: a repair counted as done if some vendor booking's service_type
 * string contained "repair" or some task TITLE contained the word; photography
 * counted as ordered on the same kind of match. The screen asserted things that
 * had never been recorded, and the recorders that would have made them true
 * could not be reached. That is the defect the owner named — the UI has to
 * record what actually happened.
 *
 * ── 2. EVERY ONE OF THE TWENTY-THREE WAS AN UNAUTHENTICATED TENANT WRITE ────
 * Each is a `"use server"` action — a POST endpoint — and each took `userId` and
 * `brokerageId` AS PARAMETERS. There were ZERO requireAuth calls in the entire
 * file. Whoever called one chose which brokerage's ledger to write into, whose
 * user id to attribute the act to, and which listing to drive through a kernel
 * stage transition. Nothing checked that the caller belonged to that brokerage,
 * or that the listing did.
 *
 * These rows ARE the listing's history — the kernel reads them into the AI's
 * picture of the relationship, and a broker would hand them to a regulator as
 * the record of what happened and when. A forged row is worse than a missing one.
 * Identity now comes from the SESSION and the listing must belong to it.
 */
import { readFileSync, existsSync } from "node:fs"
import { stripComments } from "./strip-comments"
import {
  RECORDABLE_EVENTS,
  recordableEventsForStage,
  isRecordableFromStage,
  allMappedActions,
  type RecordableAction,
} from "../lib/listing-lifecycle/recordable-events"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}
const src = (p: string) =>
  existsSync(p)
    ? stripComments(readFileSync(p, "utf8"))
    : ""

const ENGINE     = "app/actions/seller-listing/execution-engine.ts"
const DISPATCH   = "app/actions/seller-listing/record-lifecycle-event.ts"
const CARD       = "app/components/dashboard/listings/lifecycle/record-event-card.tsx"
const PAGE       = "app/dashboard/listings/[id]/lifecycle/page.tsx"
const PANEL      = "app/components/dashboard/listings/lifecycle/pre-listing-workflow-panel.tsx"

const engine   = src(ENGINE)
const dispatch = src(DISPATCH)
const card     = src(CARD)
const page     = src(PAGE)
const panel    = src(PANEL)

/** Body of a top-level exported function, past the parameter list. */
function fnBody(source: string, name: string): string {
  const at = source.indexOf(`function ${name}(`)
  if (at < 0) return ""
  let i = source.indexOf("(", at), depth = 0
  for (; i < source.length; i++) {
    if (source[i] === "(") depth++
    else if (source[i] === ")") { depth--; if (depth === 0) { i++; break } }
  }
  const open = source.indexOf("{", i)
  if (open < 0) return ""
  depth = 0
  for (let j = open; j < source.length; j++) {
    if (source[j] === "{") depth++
    else if (source[j] === "}") { depth--; if (depth === 0) return source.slice(open, j + 1) }
  }
  return source.slice(open)
}

const ORPHANS: RecordableAction[] = [
  "recordSellerDecision", "initiateListingAgreement", "markDripCompleted",
  "recordPreListingRepair", "markRepairCompleted", "markRepairFailed",
  "markMediaCaptured", "markMLSReady", "recordShowingCompleted",
  "markUnderContract", "cancelListing", "markListingExpired",
]

console.log("\n── the tenant gate: identity from the session, never the caller ──")
{
  const exported = [...engine.matchAll(/^export async function (\w+)\(/gm)].map((m) => m[1])
  check(`the engine still exports every recorder (${exported.length})`, exported.length >= 23)

  // EVERY exported action must pass through the gate. One that does not is a
  // hole, and holes here are cross-tenant writes into a legal record.
  const ungated = exported.filter((n) => !/await authorizeListingAction\(/.test(fnBody(engine, n)))
  check(`every exported action is behind the tenant gate (${ungated.length} ungated)`, ungated.length === 0)
  if (ungated.length) console.log("      ungated:", ungated.join(", "))

  // The gate is only a gate if it actually authenticates and scopes.
  const gate = fnBody(engine, "authorizeListingAction")
  check("the gate requires authentication", /requireAuth\(/.test(gate))
  check("…refuses when unauthenticated", /if\s*\(!auth\.ok\)\s*return\s*\{\s*ok:\s*false/.test(gate))
  check("…loads the listing and refuses an unknown one", /from\("listings"\)/.test(gate) && /listing_not_found/.test(gate))
  check("…and refuses a listing outside the caller's brokerage",
    /listing\.brokerage_id !== auth\.brokerageId/.test(gate))

  // THE POINT: the caller's values must be unreachable, not merely unused.
  check("no action reads params.userId or params.brokerageId",
    !/params\.userId/.test(engine) && !/params\.brokerageId/.test(engine))
  check("…and none destructures them off params either",
    ![...engine.matchAll(/const \{([^}]*)\} = params/g)]
      .some((m) => /\buserId\b|\bbrokerageId\b/.test(m[1])))
  // Every action rebinds from the gate's result, so `userId` inside a body is
  // the session's user and cannot be anything else.
  const rebinds = (engine.match(/const \{ userId, brokerageId \} = scope/g) ?? []).length
  check(`every action rebinds identity from the gate (${rebinds})`, rebinds >= 23)
}

console.log("\n── the twelve orphans are reachable from a screen ──")
{
  check("a dispatcher exists", dispatch.length > 0)
  for (const a of ORPHANS) {
    check(`${a} is dispatched`, new RegExp(`\\b${a}\\(`).test(dispatch))
  }
  check("the card is rendered on the lifecycle page",
    /<RecordEventCard/.test(page) && /record-event-card/.test(page))
  check("the card calls the dispatcher", /recordLifecycleEventAction\(/.test(card))
  // The dispatcher must not become a second engine.
  check("the dispatcher never passes identity through",
    !/brokerageId/.test(dispatch) && !/userId/.test(dispatch))
}

console.log("\n── the controls cannot claim something impossible ──")
{
  // Client-side hiding is a courtesy; the server must re-check.
  check("the dispatcher re-checks the stage server-side", /isRecordableFromStage\(/.test(dispatch))
  check("…and refuses rather than proceeding", /not_recordable_from_stage/.test(dispatch))
  check("…and validates the required fields", /missing_required_fields/.test(dispatch))
  check("…and rejects a choice value the recorder would not accept", /invalid_value:/.test(dispatch))

  // No action may be stranded: declared but offered from no stage at all.
  const mapped = new Set(allMappedActions())
  const stranded = (Object.keys(RECORDABLE_EVENTS) as RecordableAction[]).filter((a) => !mapped.has(a))
  check(`no declared action is offered from zero stages (${stranded.length} stranded)`, stranded.length === 0)
  if (stranded.length) console.log("      stranded:", stranded.join(", "))

  // The stage map must be selective, not a list of everything everywhere.
  check("an early stage cannot record a showing", !isRecordableFromStage("LEAD", "recordShowingCompleted"))
  check("a pre-agreement stage cannot go under contract",
    !isRecordableFromStage("SELLER_DECISION", "markUnderContract"))
  check("a live listing CAN record a showing", isRecordableFromStage("MLS_ACTIVE", "recordShowingCompleted"))
  check("a repair can only be completed once one is in progress",
    isRecordableFromStage("REPAIRS_IN_PROGRESS", "markRepairCompleted") &&
    !isRecordableFromStage("LEAD", "markRepairCompleted"))
  check("a closed listing offers nothing", recordableEventsForStage("CLOSED").length === 0)

  // Terminal events sort last so a destructive control is never the first thing
  // under the agent's cursor.
  for (const stage of ["MLS_ACTIVE", "SHOWINGS_ACTIVE", "OFFERS_RECEIVED"]) {
    const evts = recordableEventsForStage(stage)
    const firstTerminal = evts.findIndex((e) => e.terminal)
    const lastNormal = evts.map((e) => !!e.terminal).lastIndexOf(false)
    check(`${stage}: terminal controls come last`, firstTerminal === -1 || firstTerminal > lastNormal)
  }
}

console.log("\n── the field vocabulary is the RECORDER's, not a friendlier invention ──")
{
  // A label the server does not accept is a write that fails silently — this is
  // the two-vocabularies-one-variable class, caught here rather than at runtime.
  const decision = RECORDABLE_EVENTS.recordSellerDecision.fields.find((f) => f.key === "decision")
  const engineSig = engine.slice(engine.indexOf("export async function recordSellerDecision"))
  check("the seller-decision options are exactly what the recorder accepts",
    !!decision?.options?.length &&
    decision.options.every((o) => new RegExp(`"${o}"`).test(engineSig.slice(0, 400))))

  // Every REQUIRED field must correspond to a required parameter of the recorder,
  // or the control collects something the server ignores.
  const requiredOk = (Object.keys(RECORDABLE_EVENTS) as RecordableAction[]).every((a) => {
    const sig = engine.slice(engine.indexOf(`export async function ${a}(params: {`))
    const params = sig.slice(0, sig.indexOf("}) {"))
    return RECORDABLE_EVENTS[a].fields
      .filter((f) => f.required)
      .every((f) => new RegExp(`\\b${f.key}\\??:\\s*\\S`).test(params))
  })
  check("every required field names a real recorder parameter", requiredOk)
}

console.log("\n── a recorded fact is findable by the readers that look for it ──")
{
  // THE MISSING MIDDLE. Every lifecycle activity carried the listing in a JSON
  // `notes` blob, and only 2 of 22 set the listing_id COLUMN — which is what the
  // lifecycle page, the CMA assembler and the net-sheet calculator all filter on.
  // The entire seller lifecycle history was invisible to every listing-scoped
  // reader. Verified live: with both shapes inserted, the page's own query
  // returned ONLY the row that set the column.
  const rows = [...engine.matchAll(/^([ \t]*)activity_type:\s*"seller[^"]*",/gm)]
  check(`the engine writes seller lifecycle activities (${rows.length})`, rows.length > 0)
  const unanchored = rows.filter((m) => {
    const start = engine.lastIndexOf("{", m.index ?? 0)
    return !/listing_id:/.test(engine.slice(start, m.index ?? 0))
  })
  check(`every one anchors on the listing_id COLUMN (${unanchored.length} unanchored)`,
    unanchored.length === 0)
  // The reader keys on the column. A reader that had to parse `notes` to find
  // the listing could not be indexed and could not be filtered in SQL at all.
  check("…and the page's recorded-events read is keyed on that column",
    /\.select\("activity_type"\)[\s\S]{0,120}?\.eq\("listing_id", listingId\)/.test(page))
}

console.log("\n── the panel reports what was RECORDED, not what it guessed ──")
{
  check("the page loads the listing's recorded lifecycle activity",
    /\.like\("activity_type", "seller\.%"\)/.test(page))
  check("…and hands it to the workflow panel", /recordedEvents=\{recordedEvents\}/.test(page))
  check("the repair step prefers the recorded fact",
    /recorded\("seller\.repair\.completed"\)/.test(panel))
  check("the media step prefers the recorded fact",
    /recorded\("seller\.media\.captured"\)/.test(panel))
  // The old keyword inference stays only as a fallback — removing it would
  // silently un-complete steps on listings that pre-date the recording UI.
  check("…with the old inference kept behind it, not deleted",
    /hasCompletedVendor\("repair"\)/.test(panel) && /hasVendor\("photo"\)/.test(panel))
}

console.log("\n──────────────────────────────────────────────────")
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ LIFECYCLE_RECORDING_FAIL"); process.exit(1) }
console.log(" ✅ LIFECYCLE_RECORDING_PASS — the agent can record what happened, and only their own brokerage's listings")

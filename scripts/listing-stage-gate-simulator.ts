#!/usr/bin/env tsx
/**
 * scripts/listing-stage-gate-simulator.ts   (npm run test:listing-stage-gate)
 * ─────────────────────────────────────────────────────────────────────────────
 * FOUR STAGE GATES THAT COULD NEVER OPEN.
 *
 * prepareComingSoonAssets, markMLSReady, approveOpenHouseMarketing and
 * submitToMLSAdmin each hand-rolled a precondition by querying lifecycle_events
 * for `event_type = KernelEvent.LISTING_STAGE_CHANGED` — the bare
 * 'listing_stage_changed'.
 *
 * transitionLifecycle is the ONLY writer of those rows and it stores
 * `lifecycle.${eventType}` (lib/kernel/lifecycle.ts). The prefixed value never
 * equals the bare one, so all four gates matched ZERO rows for every listing and
 * all four actions refused every caller, permanently. A listing could not be
 * advanced past media approval through the product at all.
 *
 * AND THE QUESTION WAS WRONG EVEN SO. "Has an event of this type ever been
 * recorded" is not "is the listing in the required state". markMLSReady counted
 * rows of either type and accepted `length >= 2`, so simply correcting the prefix
 * would have let two ordinary stage changes satisfy a gate whose stated meaning
 * is "media approved AND coming soon activated" — turning a gate that blocks
 * everything into one that blocks nothing.
 *
 * Nothing downstream would have caught either mistake: transitionLifecycle writes
 * the state column UNCONDITIONALLY and treats `fromState` as an unverified claim.
 * These pre-gates are the only enforcement of stage order in the system, and
 * listing_stage_machine transitions also sync `listings.status` — so a listing
 * that skipped ahead goes publicly live out of order.
 *
 * The gates now read the listing's own lifecycle_stage and compare it against
 * `allowedFrom` in LISTING_LIFECYCLE_STAGES, so the gate is DERIVED from the
 * stage table and the two cannot drift.
 *
 * SOURCE layer: no gate matches an unprefixed event type; every gate goes through
 * the shared helper; the helper is derived from the stage table and checks its
 * read error. PURE layer: the allowedFrom chain each gate depends on really is
 * what the stage table says. LIVE layer (creds-gated): the event_type actually
 * stored carries the prefix the old gates omitted.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { LISTING_LIFECYCLE_STAGES, getStageDefinition } from "../lib/listing-lifecycle/lifecycle-definitions"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")
/** Strip comments so no assertion can be satisfied by prose describing the fix. */
const code = (p: string) => src(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

const ENGINE = "app/actions/seller-listing/execution-engine.ts"

/** The four actions and the stage each one is trying to enter. */
const GATES: Array<{ fn: string; target: string }> = [
  { fn: "prepareComingSoonAssets",    target: "COMING_SOON_PREP" },
  { fn: "markMLSReady",               target: "MLS_READY" },
  { fn: "approveOpenHouseMarketing",  target: "OPEN_HOUSE_MARKETING" },
  { fn: "submitToMLSAdmin",           target: "MLS_ACTIVE" },
]

/**
 * The body of a function, up to the next top-level declaration.
 *
 * `exported` distinguishes the public actions from the module-private helpers.
 * The name is anchored with \b on BOTH sides so `requireListingStage` does not
 * match `requireListingStageExtra` — a prefix match made one of these assertions
 * survive its own negative test.
 */
function fnBody(source: string, name: string, exported = true): string {
  const re = exported
    ? new RegExp(`export\\s+async\\s+function\\s+${name}\\b\\s*\\(`)
    : new RegExp(`(?<!export\\s)async\\s+function\\s+${name}\\b\\s*\\(`)
  const m = re.exec(source)
  if (!m) return ""
  const start = m.index
  const nextExport = source.indexOf("\nexport ", start + 1)
  const nextPrivate = source.indexOf("\nasync function ", start + 1)
  const ends = [nextExport, nextPrivate].filter((i) => i !== -1)
  const next = ends.length > 0 ? Math.min(...ends) : -1
  return next === -1 ? source.slice(start) : source.slice(start, next)
}

function sourceLayer() {
  const engine = code(ENGINE)

  console.log("\n[source · the shared precondition exists and is derived, not hand-copied]")
  // SCOPED TO THE HELPER BODY, not to the file. Two earlier versions of these two
  // assertions were satisfied by any match anywhere in a 1900-line module, and the
  // negative test caught both: renaming the reading helper still matched the other
  // one, and breaking the stage read still matched an unrelated `.select` upstream.
  // An assertion that cannot be made to fail is not testing anything.
  const readHelper = fnBody(engine, "requireCurrentListingStage", false)
  const wrapHelper = fnBody(engine, "requireListingStage", false)

  check("requireCurrentListingStage — the one place the stage is read — exists", readHelper.length > 0)
  check("requireListingStage exists and delegates to it, so there is ONE read path",
    wrapHelper.length > 0 && /requireCurrentListingStage\(/.test(wrapHelper))
  // The whole point: the gate reads the stage table rather than repeating its contents.
  check("...the advancing form derives its requirement from the stage table (getStageDefinition + allowedFrom)",
    /getStageDefinition\(/.test(wrapHelper) && /allowedFrom/.test(wrapHelper))
  check("...and the read really reads the listing's OWN current stage",
    /\.select\(\s*["']lifecycle_stage["']\s*\)/.test(readHelper))
  // supabase-js resolves a failed query. A gate that could not read is not a gate
  // that passed, and it must not be reported as a stage problem either.
  check("...a failed read is refused distinctly, not silently treated as a stage mismatch",
    /stage_check_failed/.test(readHelper))

  console.log("\n[source · every gate goes through it, and none matches a bare event type]")
  for (const g of GATES) {
    const body = fnBody(engine, g.fn)
    check(`${g.fn} exists`, body.length > 0)
    check(`${g.fn} gates on the stage table via requireListingStage("${g.target}")`,
      new RegExp(`requireListingStage\\([^)]*["']${g.target}["']`).test(body))
    // THE ORIGINAL DEFECT. transitionLifecycle stores `lifecycle.<event>`, so a
    // comparison against the bare KernelEvent constant can never match.
    check(`${g.fn} no longer matches an unprefixed lifecycle event_type`,
      !/["']event_type["']\s*,\s*KernelEvent\./.test(body))
    // A lifecycle_events READ used as a gate is the defect. An INSERT is how these
    // actions record their sub-events and is correct — an assertion that banned
    // both would fail on working code and get the guard switched off.
    check(`${g.fn} does not READ lifecycle_events as a precondition`,
      !/from\(["']lifecycle_events["']\)\s*\.\s*select\(/.test(body))
  }

  console.log("\n[source · the fifth gate: the value was written to a different table entirely]")
  const initiate = fnBody(engine, "initiateListingAgreement")
  check("initiateListingAgreement exists", initiate.length > 0)
  // recordSellerDecision writes 'seller.decision.accepted' as an ACTIVITY_TYPE into
  // `activities`. This gate read it out of lifecycle_events, where nothing writes it.
  check("...it no longer reads 'seller.decision.accepted' out of lifecycle_events",
    !/seller\.decision\.accepted/.test(initiate))
  check("...it gates on the stage acceptance actually produces",
    /requireCurrentListingStage\([^)]*LISTING_AGREEMENT_INITIATED/s.test(initiate))
  // Prove the premise: the only writer of that string writes it as an activity_type.
  const decision = fnBody(engine, "recordSellerDecision")
  check("...and recordSellerDecision really writes it as an activity_type, not an event_type",
    /activity_type:\s*activityType/.test(decision) &&
    /activityType\s*=\s*decision === "accepted" \? "seller\.decision\.accepted"/.test(decision))
  check("...transitioning to LISTING_AGREEMENT_INITIATED on accept",
    /toState\s*=\s*decision === "accepted" \? "LISTING_AGREEMENT_INITIATED"/.test(decision))

  console.log("\n[source · the writer really does prefix, which is why the old gates never matched]")
  const kernel = code("lib/kernel/lifecycle.ts")
  check("transitionLifecycle stores event_type with a `lifecycle.` prefix",
    /event_type:\s*`lifecycle\.\$\{eventType\}`/.test(kernel))
  // If the kernel ever stopped writing the state column unconditionally this
  // guard's premise would change — assert the premise so the change is visible.
  check("...and it does NOT verify the entity is in fromState (these gates are the only enforcement)",
    !/\.eq\(\s*entityDef\.stateColumn\s*,\s*fromState\s*\)/.test(kernel))
}

function pureLayer() {
  console.log("\n[pure · the allowedFrom chain each gate leans on is what the table says]")
  for (const g of GATES) {
    const def = getStageDefinition(g.target as never)
    check(`${g.target} is a real stage with a declared allowedFrom`,
      !!def && Array.isArray(def.allowedFrom) && def.allowedFrom.length > 0)
  }
  // The specific chain that made the old "media approved AND coming soon
  // activated" wording expressible as a single stage check.
  const mls = getStageDefinition("MLS_READY" as never)
  check("MLS_READY is entered only from MEDIA_APPROVED",
    mls?.allowedFrom.join(",") === "MEDIA_APPROVED")
  const mediaApproved = getStageDefinition("MEDIA_APPROVED" as never)
  check("...MEDIA_APPROVED only from MEDIA_CAPTURE", mediaApproved?.allowedFrom.join(",") === "MEDIA_CAPTURE")
  const capture = getStageDefinition("MEDIA_CAPTURE" as never)
  check("...MEDIA_CAPTURE only from COMING_SOON_ACTIVE — so the stage carries both conditions",
    capture?.allowedFrom.join(",") === "COMING_SOON_ACTIVE")

  // A stage nobody can enter is a dead end; catching that here is cheap.
  const entryPoints = LISTING_LIFECYCLE_STAGES.filter((s) => s.allowedFrom.length === 0)
  check("the stage machine has at least one entry point", entryPoints.length > 0)
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) {
    console.log("\n[live] ⊘ skipped (no SUPABASE creds) — the source layer proved the shape")
    return
  }
  console.log("\n[live · the event_type the old gates were looking for]")
  const svc = createClient(url, key, { auth: { persistSession: false } })

  // The bare value the four gates compared against.
  const { count: bare, error: bareErr } = await svc
    .from("lifecycle_events")
    .select("id", { count: "exact", head: true })
    .eq("event_type", "listing_stage_changed")
  check("live: the bare 'listing_stage_changed' the old gates matched does not exist", !bareErr && (bare ?? 0) === 0)

  const { error: prefErr } = await svc
    .from("lifecycle_events")
    .select("id", { count: "exact", head: true })
    .eq("event_type", "lifecycle.listing_stage_changed")
  check("live: the prefixed form is the one that is queryable", !prefErr)

  const { error: colErr } = await svc.from("listings").select("lifecycle_stage").limit(0)
  check("live: listings.lifecycle_stage is a real column (the new gate reads it)", !colErr)
}

async function main() {
  console.log("══════════════════════════════════════════════════════════════════════")
  console.log(" LISTING STAGE GATES — the precondition is the stage, not a pile of events")
  console.log("══════════════════════════════════════════════════════════════════════")
  sourceLayer()
  pureLayer()
  await liveLayer()
  console.log(`\n${"═".repeat(70)}`)
  console.log(`LISTING STAGE GATES — ${pass} passed, ${fail} failed`)
  if (fail > 0) {
    console.log("\nFailures:")
    for (const f of fails) console.log(`  · ${f}`)
    console.log("\nThese four gates are the ONLY enforcement of listing stage order:")
    console.log("transitionLifecycle writes the state column unconditionally and never")
    console.log("verifies fromState. A gate that matches nothing blocks every agent; a")
    console.log("gate that matches anything sends a listing live out of order.")
    process.exit(1)
  }
  console.log("✅ LISTING_STAGE_GATE_PASS — each gate reads the stage the table requires")
}

main().catch((e) => { console.error(e); process.exit(1) })

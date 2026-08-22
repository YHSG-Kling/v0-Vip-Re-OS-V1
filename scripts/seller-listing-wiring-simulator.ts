#!/usr/bin/env tsx
/**
 * scripts/seller-listing-wiring-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE LISTING COPY NOBODY READ.
 *
 * app/actions/ai-listing-intake.ts is the intake engine for taking a listing:
 * property enrichment from an address, a list-price recommendation, a Fair
 * Housing / MLS review of the public copy, and the Dotloop document status. Every
 * one of them was complete, authenticated and exported — and called from NOWHERE.
 * The only caller any of them had was runCompleteListingIntake, which itself had
 * no caller, so the entire cluster was unreachable from any screen.
 *
 * The one that mattered most is the Fair Housing review. The listing lifecycle
 * page's launch gate has exactly one compliance input — auditListingDocuments —
 * and that is a DOCUMENT check. Nothing anywhere in the product read the
 * listing's marketing copy. A listing could be syndicated to the MLS with
 * discriminatory language in its public remarks and no surface would have said a
 * word, while the reviewer that would have caught it sat in the tree with no
 * caller.
 *
 * THE FIX, in three parts:
 *   1. aiCheckListingCompliance takes an optional listingId. Given one it verifies
 *      the listing is in the caller's brokerage BEFORE burning inference, then
 *      RECORDS the verdict as an `activities` row carrying the listing_id COLUMN
 *      — the column every listing-scoped reader filters on — with the insert's
 *      error checked, because supabase-js resolves a rejected insert.
 *   2. getListingCopyComplianceGate is the read side. It fingerprints the copy the
 *      verdict was made against, so a finding only blocks a launch while the
 *      offending words are still there; rewriting the remarks makes the verdict
 *      STALE rather than holding a launch for a violation already fixed. Both of
 *      its reads destructure `error` — a gate that reads clean on failure is the
 *      entire defect class.
 *   3. The lifecycle page consumes the gate into complianceBlockers (which gates
 *      canLaunch), and ListingIntelligenceCard gives the agent the four actions.
 *
 * SOURCE layer: the construct, not the spelling — and every assertion is
 * NEGATIVE-TESTED by mutating the scanned source in memory and confirming the
 * same predicate flips to false. In-memory rather than on disk on purpose: other
 * agents work in this tree, and a proof must not leave a window where the repo is
 * broken.
 * LIVE layer (creds-gated): prove the columns are real — the page's extended
 * listings select resolves, the action's activities row is accepted with
 * listing_id set, the gate's own query finds exactly it, and an agents-class
 * agent_id is enforced (a users id is refused). Every seeded row deleted.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { stripComments } from "./strip-comments"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")
/** Strip comments so an assertion can never be satisfied by prose describing the fix. */
const code = (p: string) => stripComments(src(p))

const INTAKE = "app/actions/ai-listing-intake.ts"
const PAGE   = "app/dashboard/listings/[id]/lifecycle/page.tsx"
const CARD   = "app/components/dashboard/listings/lifecycle/listing-intelligence-card.tsx"
const ENGINE = "app/actions/seller-listing/execution-engine.ts"
const REPRESENTATION = "lib/kernel/compliance/active-representation.ts"

/**
 * Assert a predicate over source AND prove the assertion can fail.
 *
 * `breaks` are edits that remove the construct being claimed. If the predicate
 * still passes with the construct removed, the assertion was vacuous — it was
 * matching something else — and that is reported as a failure of the PROOF, not
 * of the code. Nothing is written to disk.
 */
function proves(name: string, source: string, predicate: (s: string) => boolean, breaks: Array<[string | RegExp, string]>) {
  check(name, predicate(source))
  for (const [find, replace] of breaks) {
    const broken = typeof find === "string" ? source.split(find).join(replace) : source.replace(find, replace)
    if (broken === source) {
      check(`   ↳ negative test is real (the break "${String(find).slice(0, 48)}" actually changed the source)`, false)
      continue
    }
    check(`   ↳ fails when "${String(find).slice(0, 48)}" is removed`, !predicate(broken))
  }
}

function sourceLayer() {
  const intake = code(INTAKE)
  const page   = code(PAGE)
  const card   = code(CARD)

  console.log("\n[source · the review is recorded against the LISTING]")

  // The construct: an activities insert whose row carries the listing_id COLUMN.
  // Burying the listing in the JSON notes blob is what made the whole seller
  // lifecycle invisible to every listing-scoped reader once before.
  proves(
    "aiCheckListingCompliance writes an activities row carrying listing_id",
    intake,
    (s) => /from\("activities"\)\s*\.insert\(\{[\s\S]{0,1500}?listing_id:\s*scopedListingId/.test(s),
    [[/listing_id:\s*scopedListingId,/, ""]],
  )

  // supabase-js RESOLVES a rejected insert. Dropping the error made a compliance
  // review that never landed indistinguishable from one that did.
  proves(
    "...and the insert's error is destructured and reported",
    intake,
    (s) => /const \{\s*error:\s*activityError\s*\}\s*=\s*await supabase\s*\.?from\("activities"\)\s*\.insert\(/.test(s)
        && /if \(activityError\)/.test(s),
    [
      [/const \{\s*error:\s*activityError\s*\}\s*=\s*await/, "await"],
      [/if \(activityError\)/, "if (false)"],
    ],
  )

  // The row must be attributable to the acting agent in the AGENTS class —
  // activities.agent_id FKs agents(id). `?? ctx.userId` buys a wrong-class id in
  // place of an honest null.
  proves(
    "the row's agent_id is the agents-class id, never substituted with the users id",
    intake,
    (s) => /agent_id:\s*ctx\.agentId,/.test(s) && !/agent_id:\s*ctx\.agentId\s*\?\?/.test(s),
    [[/agent_id:\s*ctx\.agentId,/, "agent_id: ctx.agentId ?? ctx.userId,"]],
  )

  console.log("\n[source · the tenant gate runs BEFORE the model does]")

  // A listing id from another brokerage must be refused before it can burn paid
  // inference, not after.
  const gateIdx  = intake.indexOf("listing.brokerage_id !== ctx.brokerageId")
  const modelIdx = intake.indexOf("generateObject({", intake.indexOf("aiCheckListingCompliance"))
  check("the brokerage check on listingId precedes the generateObject call",
    gateIdx > 0 && modelIdx > 0 && gateIdx < modelIdx)
  check("   ↳ negative test is real (both anchors were found)", gateIdx > 0 && modelIdx > 0)

  console.log("\n[source · a finding only blocks the copy it was made against]")

  proves(
    "the verdict records a fingerprint of the reviewed text",
    intake,
    (s) => /description_fingerprint:\s*listingCopyFingerprint\(params\.description\)/.test(s),
    [[/description_fingerprint:\s*listingCopyFingerprint\(params\.description\),/, ""]],
  )

  // Staleness is the whole point: enforcing a verdict about words that are no
  // longer in the listing would hold a launch for a violation already fixed.
  proves(
    "the gate compares the CURRENT copy's fingerprint and marks a changed copy stale",
    intake,
    (s) => /listingCopyFingerprint\(currentRemarks\)\s*!==\s*reviewedFingerprint/.test(s)
        && /if \(!stale\)\s*\{[\s\S]{0,800}?blockers\.push\(/.test(s),
    [
      [/listingCopyFingerprint\(currentRemarks\)\s*!==\s*reviewedFingerprint/, "false"],
      [/if \(!stale\) \{/, "if (true) {"],
    ],
  )

  proves(
    "a Fair Housing failure or a flagged phrase becomes a blocker",
    intake,
    (s) => /parsed\.fair_housing_passed === false \|\| flagged\.length > 0/.test(s)
        && /blockers\.push\(/.test(s),
    [[/parsed\.fair_housing_passed === false \|\| flagged\.length > 0/, "false"]],
  )

  console.log("\n[source · the gate cannot read clean on failure]")

  // `const { data }` on a failed read turns a broken query into a silently empty
  // one — and an empty compliance gate reports "no violations".
  proves(
    "BOTH of the gate's reads destructure error, and either failing refuses the pass",
    intake,
    // Anchored on the PAIR so the break cannot be absorbed by the identical
    // destructure earlier in the file (the listing lookup inside the reviewer).
    (s) => /data:\s*listing,\s*error:\s*listingError\s*\},\s*\{\s*data:\s*rows,\s*error:\s*activityError\s*\}/.test(s)
        && /if \(listingError \|\| activityError\)/.test(s)
        && /success:\s*false/.test(s),
    [
      [/data: listing, error: listingError \}, \{ data: rows/, "data: listing }, { data: rows"],
      [/data: rows, error: activityError \}/, "data: rows }"],
      [/if \(listingError \|\| activityError\)/, "if (false)"],
    ],
  )

  console.log("\n[source · the launch gate consumes it]")

  proves(
    "the lifecycle page calls the gate and folds its blockers into complianceBlockers",
    page,
    (s) => /getListingCopyComplianceGate\(listingId\)/.test(s)
        && /complianceBlockers\.push\(\.\.\.copyGate\.blockers\)/.test(s),
    [
      [/getListingCopyComplianceGate\(listingId\)/, "({} as any)"],
      [/complianceBlockers\.push\(\.\.\.copyGate\.blockers\)/, ""],
    ],
  )

  // Silence is not consent: the document audit already treats its own failure as
  // a blocker, and the copy gate must not be the one that waves a launch through.
  proves(
    "a gate that could not run is a blocker, not a pass",
    page,
    (s) => /if \(!copyGate\.success\)\s*\{[\s\S]{0,400}?complianceBlockers\.push\(/.test(s),
    [[/if \(!copyGate\.success\) \{/, "if (false) {"]],
  )

  proves(
    "complianceBlockers still gates canLaunch (so a copy violation holds the launch)",
    page,
    (s) => /canLaunch=\{[^}]*complianceBlockers\.length === 0/.test(s),
    [[/complianceBlockers\.length === 0/, "true"]],
  )

  console.log("\n[source · the four orphans have a surface]")

  for (const fn of ["aiCheckListingCompliance", "aiSuggestListPrice", "aiEnrichPropertyData", "aiCheckDocumentStatus"]) {
    proves(
      `${fn} is imported from the intake module AND invoked by the card`,
      card,
      (s) => new RegExp(`import\\s*\\{[\\s\\S]{0,400}?\\b${fn}\\b[\\s\\S]{0,400}?\\}\\s*from\\s*"@/app/actions/ai-listing-intake"`).test(s)
          && new RegExp(`await ${fn}\\(`).test(s),
      [[new RegExp(`await ${fn}\\(`), "await (async () => null)("]],
    )
  }

  proves(
    "the card sends the listingId, so the review is recorded rather than lost with the tab",
    card,
    (s) => /await aiCheckListingCompliance\(\{\s*listingId,/.test(s),
    [[/await aiCheckListingCompliance\(\{\s*listingId,/, "await aiCheckListingCompliance({"]],
  )

  // An estimated property is not a measured one. Quoting a price built on guessed
  // square footage to a seller without saying so is the dishonest version.
  proves(
    "a price built on ESTIMATED property facts is labelled as such",
    card,
    (s) => /setPricingEstimated\(true\)/.test(s) && /\{pricingEstimated &&/.test(s),
    [[/setPricingEstimated\(true\)/, ""], [/\{pricingEstimated &&/, "{false &&"]],
  )

  proves(
    "the lifecycle page actually renders the card",
    page,
    (s) => /<ListingIntelligenceCard/.test(s) && /listing-intelligence-card/.test(s),
    [[/<ListingIntelligenceCard/, "<Nothing"]],
  )

  console.log("\n[source · the twelve recorders stay reachable]")

  // Regression guard on the wiring that already exists: the twelve orphaned
  // recorders in the execution engine reach a screen through exactly ONE
  // dispatcher. If that door closes they are orphans again.
  const dispatch = code("app/actions/seller-listing/record-lifecycle-event.ts")
  const engineRecorders = [
    "recordSellerDecision", "initiateListingAgreement", "markDripCompleted",
    "recordPreListingRepair", "markRepairCompleted", "markRepairFailed",
    "markMediaCaptured", "markMLSReady", "recordShowingCompleted",
    "markUnderContract", "cancelListing", "markListingExpired",
  ]
  check("all twelve execution-engine recorders are dispatched from one door",
    engineRecorders.every((fn) => new RegExp(`case "${fn}":`).test(dispatch) && new RegExp(`\\b${fn}\\b`).test(dispatch)))
  check("   ↳ negative test is real (a made-up recorder is NOT dispatched)",
    !/case "markSomethingInvented":/.test(dispatch))

  // ── THE SELLER IS STAMPED ON THE AGREEMENT ────────────────────────────────
  //
  // `listing_agreements.seller_contact_id` had two readers and no writer:
  //
  //   · lib/kernel/compliance/active-representation.ts:59-63 — arm 3 of the
  //     implied-TCPA-consent test ("a fully-signed listing agreement for this
  //     contact"). NULL there meant the arm could never match, so a seller
  //     whose agreement had just been fully executed still read as unconsented
  //     on sms/phone and the dispatch gate blocked their own servicing team.
  //   · lib/kernel/notification-engine.ts:314-323 — reads it to find the seller
  //     to notify, and skips silently on NULL.
  //
  // executeListingAgreement is the ONLY insert of that table in the tree, and
  // the id was already in scope — the same value it hands to
  // auditListingDocuments. It was resolved and never written down.
  console.log("\n[source · the seller is stamped on the listing agreement]")
  const engineSrc = code(ENGINE)
  proves(
    "executeListingAgreement writes seller_contact_id onto the listing_agreements row",
    engineSrc,
    (s) => {
      const at = s.indexOf('.from("listing_agreements")')
      if (at < 0) return false
      const insertAt = s.indexOf(".insert(", at)
      if (insertAt < 0) return false
      // Scoped to the insert object, not the file: the identifier also occurs in
      // the `listings` select above, so a file-wide test would stay green with
      // the write deleted.
      const obj = s.slice(insertAt, insertAt + 2000)
      return /seller_contact_id:\s*sellerContactId/.test(obj)
    },
    [["seller_contact_id:           sellerContactId,", ""]],
  )
  proves(
    "the seller id it stamps is the one resolved from the listing (seller_contact_id, falling back to contact_id)",
    engineSrc,
    (s) => /const sellerContactId = \(\(listingRow\?\.seller_contact_id \?\? listingRow\?\.contact_id\)/.test(s),
    [["listingRow?.seller_contact_id ?? listingRow?.contact_id", "null"]],
  )
  proves(
    "the implied-consent reader still keys arm 3 on listing_agreements.seller_contact_id",
    code(REPRESENTATION),
    (s) => /\.from\("listing_agreements"\)[\s\S]{0,240}?\.eq\("seller_contact_id", contactId\)/.test(s),
    [['.eq("seller_contact_id", contactId)', '.eq("listing_id", contactId)']],
  )
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — the source layer proved the shape"); return }
  console.log("\n[live · the columns are real and the row lands]")
  const svc = createClient(url, key, { auth: { persistSession: false } })

  const stamp = `zz_listing_copy_${Date.now()}`
  const cleanup: Array<{ table: string; id: string }> = []
  const REVIEW = "listing.copy.compliance_reviewed"
  const REMARKS = "Charming home in a quiet family neighborhood near the church."

  try {
    const { data: brk, error: brkErr } = await svc.from("brokerages").insert({ name: stamp }).select("id").single()
    if (brkErr || !brk) { console.log(`  ⊘ could not seed a brokerage (${brkErr?.message}) — skipping live`); return }
    const brokerageId = (brk as any).id as string
    cleanup.push({ table: "brokerages", id: brokerageId })

    const { data: usr, error: usrErr } = await svc.from("users").insert({
      email: `${stamp}@example.invalid`, brokerage_id: brokerageId,
      user_type: "agent", first_name: "ZZ", last_name: "CopyGate",
    }).select("id").single()
    if (usrErr || !usr) { console.log(`  ⊘ could not seed a user (${usrErr?.message}) — skipping live`); return }
    const userId = (usr as any).id as string
    cleanup.push({ table: "users", id: userId })

    const { data: ag, error: agErr } = await svc.from("agents")
      .insert({ user_id: userId, brokerage_id: brokerageId }).select("id").single()
    if (agErr || !ag) { console.log(`  ⊘ could not seed an agent (${agErr?.message}) — skipping live`); return }
    const agentId = (ag as any).id as string
    cleanup.push({ table: "agents", id: agentId })

    const { data: lst, error: lstErr } = await svc.from("listings").insert({
      brokerage_id: brokerageId, agent_id: agentId, address: `${stamp} Main St`,
      city: "Austin", state: "TX", zip: "78701", lifecycle_stage: "LEAD",
      status: "draft", public_remarks: REMARKS,
      bedrooms: 3, bathrooms: 2, sqft: 1800, year_built: 1974, lot_size: 0.25, has_pool: false,
      property_type: "single_family",
    }).select("id").single()
    if (lstErr || !lst) { console.log(`  ⊘ could not seed a listing (${lstErr?.message}) — skipping live`); return }
    const listingId = (lst as any).id as string
    cleanup.push({ table: "listings", id: listingId })

    // PHANTOM-COLUMN PROOF. The lifecycle page selects these by name; if any one
    // of them did not exist the whole page read would fail at runtime.
    const { error: selErr } = await svc
      .from("listings")
      .select("id, address, city, state, zip, lifecycle_stage, list_price, seller_contact_id, status, mls_number, mls_link, public_remarks, property_type, bedrooms, bathrooms, sqft, year_built, lot_size, has_pool, dotloop_loop_id")
      .eq("id", listingId)
      .maybeSingle()
    check("live: every column the lifecycle page selects exists", !selErr)

    // The action's row, exactly as it writes it.
    const { data: act, error: actErr } = await svc.from("activities").insert({
      brokerage_id:  brokerageId,
      agent_id:      agentId,
      agent_user_id: userId,
      listing_id:    listingId,
      entity_type:   "listing",
      entity_id:     listingId,
      activity_type: REVIEW,
      title:         "Listing copy compliance review",
      description:   "Public copy reviewed for TX — 1 critical, 1 Fair Housing phrase(s) flagged",
      status:        "completed",
      completed_at:  new Date().toISOString(),
      notes: JSON.stringify({
        state: "TX", overall_score: 42, is_compliant: false,
        fair_housing_passed: false, flagged_phrases: ["family neighborhood"],
        mls_passed: true, mls_issues: [], critical_issues: ["Familial-status steering language"],
        description_fingerprint: "deadbeef",
      }),
    }).select("id").single()
    check("live: the compliance-review activity row is accepted with listing_id set", !actErr && !!act)
    if (act) cleanup.push({ table: "activities", id: (act as any).id })

    // The gate's own read, by listing_id + activity_type.
    const { data: gateRows, error: gateErr } = await svc
      .from("activities")
      .select("created_at, notes")
      .eq("listing_id", listingId)
      .eq("activity_type", REVIEW)
      .order("created_at", { ascending: false })
      .limit(1)
    check("live: the gate's query finds exactly the recorded review",
      !gateErr && (gateRows ?? []).length === 1)

    const parsed = JSON.parse(((gateRows ?? [])[0] as any)?.notes ?? "{}")
    check("live: the recorded verdict carries the Fair Housing finding the gate blocks on",
      parsed.fair_housing_passed === false && Array.isArray(parsed.flagged_phrases) && parsed.flagged_phrases.length === 1)

    // IDENTITY CLASS. activities.agent_id FKs agents(id). A users id must be
    // refused — which is why the action passes ctx.agentId and never ctx.userId.
    const { data: badRow, error: badErr } = await svc.from("activities").insert({
      brokerage_id: brokerageId, agent_id: userId, listing_id: listingId,
      entity_type: "listing", activity_type: `${REVIEW}.zz_wrongclass`,
    }).select("id").single()
    if (badRow) cleanup.push({ table: "activities", id: (badRow as any).id })
    check("live: a USERS id in activities.agent_id is refused (agent_id is agents-class)", !!badErr)
  } finally {
    for (const c of cleanup.reverse()) await svc.from(c.table).delete().eq("id", c.id)
    let leftover = 0
    for (const c of cleanup) {
      const { count } = await svc.from(c.table).select("id", { count: "exact", head: true }).eq("id", c.id)
      leftover += count ?? 0
    }
    check("live: cleanup count == 0", leftover === 0)
  }
}

async function main() {
  console.log("══════════════════════════════════════════════════════════════════════")
  console.log(" SELLER LISTING WIRING — the listing copy nobody read")
  console.log("══════════════════════════════════════════════════════════════════════")
  sourceLayer()
  await liveLayer()
  console.log(`\n${"═".repeat(70)}`)
  console.log(`SELLER LISTING WIRING — ${pass} passed, ${fail} failed`)
  if (fail > 0) {
    console.log("\nFailures:")
    for (const f of fails) console.log(`  · ${f}`)
    console.log("\nThe listing's marketing copy has exactly one reader in this product:")
    console.log("aiCheckListingCompliance, reached from the lifecycle page and recorded against")
    console.log("the listing. If that path goes, a Fair Housing violation can be syndicated to")
    console.log("the MLS and nothing in the OS will have looked at it.")
    process.exit(1)
  }
  console.log("✅ SELLER_LISTING_WIRING_PASS — the copy is read, recorded, and gates the launch")
}

main().catch((e) => { console.error(e); process.exit(1) })

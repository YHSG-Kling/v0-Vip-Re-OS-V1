#!/usr/bin/env tsx
/**
 * scripts/mls-syndication-simulator.ts  (npm run test:mls-syndication) — pure, no DB.
 * ─────────────────────────────────────────────────────────────────────────────
 * THE OS SAID THE LISTING WAS LIVE ON THE MLS. NOBODY EVER ASKED THE MLS.
 *
 * launchListing flips listings.status='active' / lifecycle_stage='MLS_ACTIVE'
 * because a human pressed a button. From that instant the seller report, the
 * buyer-match blast, the marketing engine and the public listing page all treat
 * "live on the MLS" as established fact. If the MLS entry was never completed,
 * was rejected, or was entered under a different number, NOTHING noticed.
 *
 * Two defects this closes, and the second is the expensive one:
 *
 *  1. THE DEADLOCK. validateListingLaunchReadiness blocked on the STORED
 *     mls_number while launchListing — the only writer of that column on the
 *     launch path — called the gate first. A listing that had never launched had
 *     no stored number, so the gate blocked, so the write never ran. The one
 *     function that fills the field could never pass the check for it being
 *     empty. The gate now also accepts the number being launched WITH.
 *
 *  2. THE UNVERIFIED CLAIM. Owner ruling: "the admin needs to add the actual
 *     listing … manually to the mls or state mls but verification that it is
 *     actually live on the mls can be checked in rentcast or the
 *     tenants(subscriber) idxbroker." The feeds are a TRUTH SOURCE for a claim
 *     we were making unchecked — not, as an earlier pass framed them, a place to
 *     fetch a number from. The agent already has the number; they typed it in.
 *
 * The verdict vocabulary deliberately matches lib/outcomes/reconciliation.ts, so
 * a delivery claim and a syndication claim read as one system. The distinction
 * that carries the weight is pending vs unverifiable: a brokerage with NO feed
 * connected must never see "not on the MLS", because a permanent false warning on
 * every correct listing is how the one real mismatch gets ignored.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import {
  verifyMlsSyndication,
  sameMlsNumber,
  isActiveOnFeed,
  isSyndicationOverdue,
  SYNDICATION_GRACE_HOURS,
  type MlsFeedObservation,
} from "../lib/listings/mls-verification"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}
const src = (p: string) =>
  existsSync(join(process.cwd(), p))
    ? readFileSync(join(process.cwd(), p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "")
    : ""

const NOW = new Date("2026-06-10T12:00:00Z")
const obs = (o: Partial<MlsFeedObservation>): MlsFeedObservation => ({
  source: "rentcast", mlsNumber: "24-118372", mlsName: "ACTRIS",
  address: "1 Launch Way", status: "Active", ...o,
})

console.log("══════════════════════════════════════════════════")
console.log(" MLS syndication — the OS proves the listing is live, or says it cannot")
console.log("══════════════════════════════════════════════════")

console.log("\n[pure — number comparison, conservative on purpose]")
{
  check("formatting is noise: 24-118372 == 24118372", sameMlsNumber("24-118372", "24118372"))
  check("case and an MLS prefix are noise", sameMlsNumber("MLS24118372", "24118372"))
  check("spaces, dots and hashes are noise", sameMlsNumber(" 24.118 372 ", "#24118372"))
  check("DIFFERENT numbers are different", !sameMlsNumber("24-118372", "24-118373"))
  // The dangerous direction: a prefix/fuzzy match would declare two distinct
  // listings the same and CONFIRM a wrong number as correct.
  check("a prefix is NOT a match (would confirm a wrong number)", !sameMlsNumber("24118372", "241183"))
  check("empty never matches empty (absence is not agreement)", !sameMlsNumber(null, null) && !sameMlsNumber("", ""))
}

console.log("\n[pure — only a LIVE feed row counts]")
{
  check("Active is live", isActiveOnFeed(obs({ status: "Active" })))
  check("case-insensitive", isActiveOnFeed(obs({ status: "active" })) && isActiveOnFeed(obs({ status: "FOR SALE" })))
  check("Sold is NOT live", !isActiveOnFeed(obs({ status: "Sold" })))
  check("Pending is NOT live", !isActiveOnFeed(obs({ status: "Pending" })))
  check("Withdrawn / Expired are NOT live",
    !isActiveOnFeed(obs({ status: "Withdrawn" })) && !isActiveOnFeed(obs({ status: "Expired" })))
  // An unknown status confirming would be a guess, and a guess in this ledger is
  // a fabricated proof.
  check("a NULL status is not treated as live (no guessing)", !isActiveOnFeed(obs({ status: null })))
}

console.log("\n[pure — the four verdicts]")
{
  const claim = { storedMlsNumber: "24-118372", liveSince: "2026-06-10T09:00:00Z" }

  const confirmed = verifyMlsSyndication(claim, [obs({})], ["rentcast"], NOW)
  check("feed shows this address live under OUR number → confirmed", confirmed.verdict === "confirmed")
  check("…and nobody is paged", confirmed.needsAttention === false)
  check("…and the evidence is carried, not just a verdict", confirmed.evidence?.mlsNumber === "24-118372")

  // THE EXPENSIVE ONE. A wrong MLS number means we publish someone else's
  // identifier for the property.
  const wrong = verifyMlsSyndication(claim, [obs({ mlsNumber: "24-999999" })], ["rentcast"], NOW)
  check("feed shows this address under a DIFFERENT number → contradicted", wrong.verdict === "contradicted")
  check("…and a human IS paged", wrong.needsAttention === true)
  check("…and the explanation names both numbers so it is actionable",
    wrong.explanation.includes("24-999999") && wrong.explanation.includes("24-118372"))

  // A disagreement must OUTRANK an agreement — otherwise the one feed that
  // caught the mistake gets buried by the one that did not.
  const split = verifyMlsSyndication(
    claim,
    [obs({ source: "rentcast" }), obs({ source: "idx", mlsNumber: "24-999999", mlsName: null })],
    ["rentcast", "idx"], NOW,
  )
  check("feeds DISAGREE → contradicted wins over the confirming feed", split.verdict === "contradicted")

  const notYet = verifyMlsSyndication(claim, [], ["rentcast"], NOW)
  check("consulted a feed, address not there yet → pending (never confirmed)", notYet.verdict === "pending")
  check("…3 hours after going live nobody is paged (syndication lags)", notYet.needsAttention === false)

  // THE DISTINCTION THAT CARRIES THE WEIGHT.
  const noFeed = verifyMlsSyndication(claim, [], [], NOW)
  check("NO feed connected → unverifiable, NOT pending, NOT 'not on the MLS'", noFeed.verdict === "unverifiable")
  check("…and it does not page anyone (a tenant without a feed is not a defect)",
    noFeed.needsAttention === false)
  check("…and it says what to do about it", /connect/i.test(noFeed.explanation))

  // A row that is on the feed but SOLD must not confirm our active claim.
  const sold = verifyMlsSyndication(claim, [obs({ status: "Sold" })], ["rentcast"], NOW)
  check("an inactive feed row cannot confirm a live claim", sold.verdict === "pending")

  // A feed row with no number is evidence the address is listed, not evidence
  // about WHICH number is right — it must not contradict.
  const noNum = verifyMlsSyndication(claim, [obs({ mlsNumber: null })], ["rentcast"], NOW)
  check("a feed row with no MLS number cannot contradict", noNum.verdict === "pending")

  // Time is the ONLY thing that turns absence into a question — and even then it
  // raises a human, it does not change the verdict to 'contradicted'.
  const stale = verifyMlsSyndication(
    { storedMlsNumber: "24-118372", liveSince: "2026-06-05T09:00:00Z" }, [], ["rentcast"], NOW)
  check(`still missing after ${SYNDICATION_GRACE_HOURS}h → still pending…`, stale.verdict === "pending")
  check("…but NOW a human is paged", stale.needsAttention === true)
  check("time never manufactures a contradiction", stale.verdict !== "contradicted")

  check("overdue math", isSyndicationOverdue("2026-06-05T09:00:00Z", NOW) === true
    && isSyndicationOverdue("2026-06-10T09:00:00Z", NOW) === false)
  check("no live date → never overdue (honest)", isSyndicationOverdue(null, NOW) === false)
}

console.log("\n[source — the launch deadlock is closed and the gate is not weakened]")
{
  const k = src("lib/kernel/listings.ts")
  check("the readiness gate accepts a SUPPLIED number as well as a stored one",
    /suppliedMlsNumber\?: string/.test(k)
    && /!\(listing\.mls_number\?\.trim\(\) \|\| input\.suppliedMlsNumber\?\.trim\(\)\)/.test(k))
  check("launchListing passes the number it is launching with into the gate",
    /validateListingLaunchReadiness\(\{[\s\S]{0,120}?suppliedMlsNumber: input\.mlsNumber/.test(k))
  check("the blocker still exists — the gate was widened, not removed",
    /blockers\.push\("No MLS number entered"\)/.test(k))
}

console.log("\n[source — the surface is wired end to end]")
{
  const dlg = src("app/dashboard/listings/[id]/components/launch/launch-listing-dialog.tsx")
  const list = src("app/dashboard/listings/[id]/components/launch/launch-readiness-checklist.tsx")
  const page = src("app/dashboard/listings/[id]/lifecycle/page.tsx")

  check("the Launch button has an onClick (it had NONE — the action was unreachable)",
    /onClick=\{\(\) => setLaunchOpen\(true\)\}/.test(list))
  check("…and the dialog it opens actually calls launchListingAction",
    /await launchListingAction\(\{/.test(dlg))
  check("…and reads the outcome, so a refused launch never renders as a launch",
    /if \(res\.success\)/.test(dlg) && /Launch was refused/.test(dlg))
  check("the lifecycle page READS mls_number (the checklist could not see its own blocker)",
    /mls_number, mls_link/.test(page) && /hasMlsNumber/.test(page))
  check("…and blocks launch on it", /blockers\.push\("No MLS number entered"\)/.test(page)
    && /marketingReady && hasMlsNumber/.test(page))
  check("the checklist can verify a stored number against the feeds",
    /verifyMlsSyndicationAction/.test(list))
  check("…and renders 'unverifiable' as its own state, not as a failure",
    /No feed connected to verify with/.test(list))
}

console.log("\n[source — the feeds carry the MLS number at all]")
{
  const rc = src("lib/property/rentcast.ts")
  const idx = src("lib/idxbroker-client.ts")
  check("RentCast's mlsNumber/mlsName reach the mapper (both were dropped)",
    /mlsNumber: r\?\.mlsNumber/.test(rc) && /mlsName: r\?\.mlsName/.test(rc))
  check("IDX's mlsID is mapped (it was only ever a 4th fallback for externalId)",
    /mlsNumber:\s+str\(r\.mlsID/.test(idx))
  check("…and kept SEPARATE from externalId — feed-local id vs industry identity",
    /externalId: String\(r\.listingID/.test(idx))
  check("the action treats a FAILED feed call as not-consulted, never as 'not found'",
    /if \(rc\.success\) \{/.test(src("app/actions/listings-kernel.ts")))
}

console.log("\n──────────────────────────────────────────────────")
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ MLS_SYNDICATION_FAIL"); process.exit(1) }
console.log(" ✅ MLS_SYNDICATION_PASS — the listing can launch, and the OS can prove it went live")

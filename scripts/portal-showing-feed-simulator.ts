#!/usr/bin/env tsx
/**
 * scripts/portal-showing-feed-simulator.ts   (npm run test:portal-showing-feed)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PORTAL'S SHOWING FEED — proves the merge that closed a five-field phantom read.
 *
 * WHAT WAS BROKEN. app/portal/[contactId]/properties/page.tsx handed
 * PersonaPropertiesDashboard a `showings` prop sourced from `showing_requests`, and the
 * dashboard's three showing/feedback tabs read `confirmed_date`, `buyer_name`,
 * `buyer_feedback`, `buyer_concerns` and `buyer_interest_level` off each row. The live
 * `showing_requests` table has NONE of those five columns (verified against project
 * hrvaqgvukzxfskkcrwbt, 2026-08-26): they live on `showings`, reachable through
 * showing_requests.converted_showing_id. Every read was `undefined`, so:
 *   · the buyer-interest badge never rendered once (the named finding, dashboard:2374)
 *   · "With Feedback" counted 0 forever and both feedback tabs showed the empty state
 *   · the Upcoming/Completed buckets filtered `showing_requests.status` against
 *     scheduled|confirmed|completed, which are `showings.status` values — that column
 *     admits approved|cancelled|denied|needs_reschedule|pending
 *   · `feedback_sentiment`, read three times for the sentiment split, is a column NO
 *     table in the schema has, so all three figures were 0%
 *
 * lib/portal/portal-showing-feed.ts is the built half: ONE row shape, ONE merge, ONE
 * status fold, and the verdict band derived from the single owner of that ladder
 * (lib/behavior-learning/signal-mapping.ts::tourInterestToRating). Pure: no I/O.
 */
import {
  buildPortalShowingFeed,
  foldShowingStatus,
  showingInterestBand,
  interestBandLabel,
  withFeedback,
  PORTAL_SHOWING_STATUSES,
  type ShowingRequestRow,
  type ShowingRow,
} from "../lib/portal/portal-showing-feed"
import { CHECK_VOCABULARIES } from "./check-vocabularies"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

const req = (o: Partial<ShowingRequestRow> & { id: string }): ShowingRequestRow => o
const shw = (o: Partial<ShowingRow> & { id: string }): ShowingRow => o

function main() {
  console.log("\n[The verdict band is DERIVED from the live CHECK, not restated]")
  const liveLevels = CHECK_VOCABULARIES.showings?.buyer_interest_level ?? []
  check(`showings.buyer_interest_level vocabulary loaded (${liveLevels.length} values)`, liveLevels.length > 0)
  check("every value the CHECK admits maps to a band — no rung left unmapped",
    liveLevels.every((v) => showingInterestBand(v) !== null))
  check("love_it → high", showingInterestBand("love_it") === "high")
  check("like_it → high", showingInterestBand("like_it") === "high")
  check("maybe → medium (a shrug is not a verdict either way)", showingInterestBand("maybe") === "medium")
  check("no → low", showingInterestBand("no") === "low")
  check("an UNRATED showing gets NO band — 'we never asked' is not 'they disliked it'",
    showingInterestBand(null) === null && showingInterestBand(undefined) === null)
  check("a value from ANOTHER column's vocabulary gets no band",
    showingInterestBand("very_interested") === null && showingInterestBand("hot") === null)
  check("interestBandLabel is total over the bands and silent on null",
    interestBandLabel("high") === "Very Interested" && interestBandLabel("medium") === "Interested" &&
    interestBandLabel("low") === "Not For Them" && interestBandLabel(null) === null)

  console.log("\n[POSITIVE CONTROL — the defect this replaced is still recognised as a defect]")
  check("the old 'high'/'medium' spelling is NOT a value the column can hold",
    !liveLevels.includes("high") && !liveLevels.includes("medium"))
  check("…and so it produces no band, exactly as the dead badge behaved",
    showingInterestBand("high") === null && showingInterestBand("medium") === null)

  console.log("\n[Status fold — both vocabularies onto the one set the UI branches on]")
  const reqStatuses = CHECK_VOCABULARIES.showing_requests?.status ?? []
  check(`showing_requests.status vocabulary loaded (${reqStatuses.length} values)`, reqStatuses.length > 0)
  check("every showing_requests.status the CHECK admits folds to a portal status",
    reqStatuses.every((s) => (PORTAL_SHOWING_STATUSES as readonly string[]).includes(foldShowingStatus(s, null, false))))
  check("approved → scheduled", foldShowingStatus("approved", null, false) === "scheduled")
  check("denied → cancelled", foldShowingStatus("denied", null, false) === "cancelled")
  check("needs_reschedule → pending", foldShowingStatus("needs_reschedule", null, false) === "pending")
  check("the SHOWING wins over the request: approved + completed → completed",
    foldShowingStatus("approved", "completed", false) === "completed")
  check("completed_at alone is enough to be completed",
    foldShowingStatus("approved", "confirmed", true) === "completed")
  check("rescheduled folds to scheduled (not a fourth word)",
    foldShowingStatus(null, "rescheduled", false) === "scheduled")
  check("an unknown status on both sides fails to `pending`, never to `completed`",
    foldShowingStatus("who_knows", "who_knows", false) === "pending")

  console.log("\n[The merge — a request and the showing it became are ONE row]")
  const merged = buildPortalShowingFeed(
    [req({ id: "r1", listing_id: "L1", property_address: "12 Oak", status: "approved", converted_showing_id: "s1" })],
    [shw({ id: "s1", listing_id: "L1", status: "completed", completed_at: "2026-08-20T18:00:00Z",
           feedback: "Loved the light", notes: "Kitchen felt small", rating: 5,
           buyer_interest_level: "love_it", buyer_agent_name: "A. Agent" })],
  )
  check("one request + its showing yields ONE row, not two", merged.length === 1)
  check("the row carries the request's address", merged[0].propertyAddress === "12 Oak")
  check("…and the SHOWING's verdict, which the request cannot hold",
    merged[0].buyerFeedback === "Loved the light" && merged[0].buyerConcerns === "Kitchen felt small" &&
    merged[0].buyerInterestLevel === "love_it" && merged[0].interestBand === "high" && merged[0].rating === 5)
  check("…and the showing's buyer-agent name and completion time",
    merged[0].buyerName === "A. Agent" && merged[0].showingAt === "2026-08-20T18:00:00Z")
  check("…and the folded status", merged[0].status === "completed")

  console.log("\n[A showing with NO request is still on the seller's board]")
  const direct = buildPortalShowingFeed(
    [req({ id: "r1", converted_showing_id: "s1", status: "approved" })],
    [shw({ id: "s1", status: "confirmed" }), shw({ id: "s2", status: "scheduled", scheduled_at: "2026-09-01T15:00:00Z" })],
  )
  check("the agent-booked showing is not dropped", direct.length === 2)
  check("…and the request-backed one is not duplicated",
    direct.filter((r) => r.id === "s1").length === 0 && direct.filter((r) => r.id === "r1").length === 1)

  console.log("\n[An unconverted request keeps its own requested slot]")
  const pending = buildPortalShowingFeed(
    [req({ id: "r9", requested_date: "2026-09-05", requested_start_time: "14:30:00", status: "pending" })],
    [],
  )
  check("showingAt falls back to requested_date + requested_start_time",
    pending[0].showingAt === "2026-09-05T14:30:00")
  check("status is pending, and no verdict is invented",
    pending[0].status === "pending" && pending[0].interestBand === null && pending[0].buyerFeedback === null)
  const noDate = buildPortalShowingFeed([req({ id: "r0", status: "pending" })], [])
  check("a request with no date yields null, not an Invalid Date", noDate[0].showingAt === null)

  console.log("\n[Ordering — newest first, undated last, and it never throws]")
  const ordered = buildPortalShowingFeed(
    [req({ id: "a", requested_date: "2026-01-01" }), req({ id: "b" }), req({ id: "c", requested_date: "2026-06-01" })],
    [],
  )
  check("newest first with the undated row last",
    ordered.map((r) => r.id).join(",") === "c,a,b")
  check("empty input yields an empty feed", buildPortalShowingFeed([], []).length === 0)

  console.log("\n[withFeedback — prose OR a rung, never an empty walk-through]")
  const feed = buildPortalShowingFeed(
    [],
    [shw({ id: "x", feedback: "Nice" }), shw({ id: "y", buyer_interest_level: "no" }), shw({ id: "z" })],
  )
  check("a showing with prose counts", withFeedback(feed).some((r) => r.id === "x"))
  check("a showing with only a rung counts", withFeedback(feed).some((r) => r.id === "y"))
  check("a showing with neither does NOT count", !withFeedback(feed).some((r) => r.id === "z"))

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ PORTAL_SHOWING_FEED_FAIL"); process.exit(1) }
  console.log(" ✅ PORTAL_SHOWING_FEED_PASS — the portal's showing tabs read fields that exist, in the vocabulary the column holds")
}

main()

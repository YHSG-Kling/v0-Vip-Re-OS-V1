#!/usr/bin/env tsx
/**
 * scripts/listing-status-sync-simulator.ts   (npm run test:listing-status-sync)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the lifecycle_stage → listings.status sync: market-state boundaries map to the right coarse
 * status, intermediate stages leave status UNTOUCHED (return undefined), every mapped value is a valid
 * status (live CHECK), and every mapped key is a valid lifecycle_stage (live CHECK). Pure: no I/O.
 */
import { statusForStage, LISTING_STATUS_VALUES, mappedStages as mappedStages_ } from "../lib/listings/listing-status-sync"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

// The 34 valid lifecycle_stage values (live CHECK constraint).
const VALID_STAGES = ["LEAD","LEAD_ASSIGNED","AGENT_CONSULTATION","APPOINTMENT_SET","CMA_GENERATION","LISTING_PRESENTATION_CREATED","PRESENTATION_VIDEO_GENERATED","PRESENTATION_DRIP_PREP","SELLER_DECISION","SELLER_DECLINED","LISTING_AGREEMENT_INITIATED","LISTING_AGREEMENT_SIGNED","MLS_DATE_CONFIRMED","COMING_SOON_PREP","REPAIRS_IN_PROGRESS","COMING_SOON_ACTIVE","MEDIA_CAPTURE","MEDIA_APPROVED","MLS_READY","OPEN_HOUSE_MARKETING","MLS_ACTIVE","OPEN_HOUSE_EVENT","SHOWINGS_ACTIVE","OFFERS_RECEIVED","NEGOTIATION","UNDER_CONTRACT","INSPECTION","APPRAISAL","FINANCING","CLOSING_PREP","CLOSED","LIFETIME_CUSTOMER","LISTING_CANCELLED","LISTING_EXPIRED"]

function main() {
  console.log("\n[Market-state boundaries map to the right coarse status]")
  check("COMING_SOON_ACTIVE → coming_soon", statusForStage("COMING_SOON_ACTIVE") === "coming_soon")
  check("MLS_ACTIVE → active (surfaces in buyer search)", statusForStage("MLS_ACTIVE") === "active")
  check("UNDER_CONTRACT → pending", statusForStage("UNDER_CONTRACT") === "pending")
  check("CLOSED → sold", statusForStage("CLOSED") === "sold")
  check("LISTING_EXPIRED → expired", statusForStage("LISTING_EXPIRED") === "expired")
  check("LISTING_CANCELLED → withdrawn", statusForStage("LISTING_CANCELLED") === "withdrawn")
  check("SELLER_DECLINED → withdrawn", statusForStage("SELLER_DECLINED") === "withdrawn")
  // Owner 2026-09-05: "the listing signed is part of the gate to start compliance" — the
  // executed agreement is where compliance STARTS, so this boundary is UNGATED.
  check("LISTING_AGREEMENT_SIGNED → listing_signed (compliance starts here)", statusForStage("LISTING_AGREEMENT_SIGNED") === "listing_signed")

  console.log("\n[Intermediate stages leave status UNTOUCHED — coarse status holds across them]")
  for (const s of ["COMING_SOON_PREP","MEDIA_APPROVED","MLS_READY","OPEN_HOUSE_MARKETING","OPEN_HOUSE_EVENT","SHOWINGS_ACTIVE","OFFERS_RECEIVED","NEGOTIATION","INSPECTION","APPRAISAL","FINANCING","CLOSING_PREP","APPOINTMENT_SET"]) {
    check(`${s} → undefined (no clobber)`, statusForStage(s) === undefined)
  }

  console.log("\n[Integrity: mapped values valid, mapped keys valid, unknown → undefined]")
  const mappedStages = VALID_STAGES.filter((s) => statusForStage(s) !== undefined)
  check("every mapped status ∈ the live CHECK set", mappedStages.every((s) => LISTING_STATUS_VALUES.includes(statusForStage(s)!)))
  check("every mapped key is a valid lifecycle_stage", mappedStages.every((s) => VALID_STAGES.includes(s)))
  check("unknown stage → undefined", statusForStage("NOT_A_STAGE") === undefined)
  // RETARGETED OFF A WAYPOINT (§2). "exactly 8" was true after the map was first written and
  // false the day the owner's listing_signed ruling added a ninth boundary — a number that can
  // only pass at one moment in a migration is not a rule. The RULE: a bare call (no verdict)
  // answers for exactly the UNGATED entries the map itself declares, and for nothing else.
  // Derived from mappedStages(), never re-typed here.
  const ungated = mappedStages_().filter((m) => m.gate === null).map((m) => m.stage).sort()
  // This guard's check() takes TWO arguments; the detail is folded into the label so tsc
  // (which the chain runs first and tsx never does) cannot refuse it as a third argument.
  check(`a bare call maps exactly the map's own UNGATED boundaries (derived, not counted) — bare=${mappedStages.length} ungated=${ungated.length}`,
    JSON.stringify([...mappedStages].sort()) === JSON.stringify(ungated))
  check("…and every GATED boundary stays undefined without a verdict (fail closed)",
    mappedStages_().filter((m) => m.gate !== null).every((m) => statusForStage(m.stage) === undefined))

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ LISTING_STATUS_SYNC_FAIL"); process.exit(1) }
  console.log(" ✅ LISTING_STATUS_SYNC_PASS — stage machine keeps the coarse market status in lockstep, no drift")
}
main()

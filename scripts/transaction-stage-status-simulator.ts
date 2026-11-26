#!/usr/bin/env tsx
/**
 * scripts/transaction-stage-status-simulator.ts   (npm run test:transaction-stage-status)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the fix for the silent CHECK bug that froze the transaction stage engine: advanceStage (and
 * the override path) wrote the UPPERCASE stage straight into transactions.status, which the live
 * transactions_status_check (lowercase-only) rejected — Postgres rolled back the WHOLE row, so no deal
 * ever advanced past UNDER_CONTRACT. The fix maps stage → STAGE_TO_STATUS_MAP. This asserts that map
 * ONLY ever yields a status value the live CHECK accepts, for EVERY stage. Pure: no I/O.
 *
 * ── WHY THIS FILE WAS REWRITTEN (2026-08-26) ────────────────────────────────
 * It used to hand-mirror the allowed set as a literal — `["lead","qualifying","active",
 * "under_contract","closing","closed","lost"]` — and then assert, in so many words, that
 * FINANCING_PENDING/CLOSING_PREP map to `closing`. m291 had ALREADY removed `closing` from the
 * column and put the real ladder there (under_contract → pending → clear_to_close → closed →
 * funded). So this guard was green for months while both writers below still lost the WHOLE row to
 * 23514, and no deal persisted an advance past APPRAISAL. CLAUDE.md §2: do not pin an assertion to
 * a waypoint, and check a hardcoded vocabulary against the generated live cache. Both sets are now
 * DERIVED from scripts/check-vocabularies.ts (machine-written from public.live_check_constraints_json,
 * drift-guarded by scripts/schema-cache-drift-guard.ts), so the day the column changes, this fails.
 */
import { STAGE_TO_STATUS_MAP, TRANSACTION_STAGES } from "../lib/transactions/transaction-stages"
import { TRANSACTION_STATUSES } from "../lib/transactions/transaction-status"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import { TENANT_ADMIN_USER_TYPES, stageTransitionTier } from "../lib/auth/resolve-user-role"
import { resolveEgressScope } from "../lib/kernel/egress-scope"
import { toCanonicalRoleOrDefault } from "../lib/security"

// DERIVED, never mirrored — the live CHECK vocabularies as generated from the database.
const VALID_STATUS = new Set(CHECK_VOCABULARIES.transactions?.status ?? [])
const VALID_STAGE = new Set(CHECK_VOCABULARIES.transactions?.stage ?? [])

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

/**
 * WHO MAY MOVE A DEAL (lane 93A). The stage machine used to resolve its role as
 * `users.role ?? users.user_type ?? "agent"` (legacy column first; a missing seat
 * graded as an agent) and the orchestrator then admitted only the canonical set
 * ["admin","broker","tc","agent"] — refusing team_lead and compliance_officer and
 * letting any agent move any deal of the brokerage. The survivor is
 * lib/transactions/role-guard.ts stageTransitionTier / canTransitionStage.
 * Asserted as the RULE over every STORABLE users.user_type (derived from the live
 * CHECK cache, never a list typed here), cross-checked against the egress-scope
 * ladder, with positive controls that replay the retired shapes.
 */
function whoMayMoveADeal() {
  const SEATS = [...(CHECK_VOCABULARIES.users?.user_type ?? [])]
  console.log(`\n[Who may move a deal — every storable user_type (${SEATS.length}, live CHECK cache)]`)
  check(`users.user_type vocabulary loaded (${SEATS.length} values)`, SEATS.length > 0)
  const roster = [...TENANT_ADMIN_USER_TYPES]
  check(`every tenant-admin roster seat is a storable user_type (${roster.join(", ")})`, roster.every((r) => SEATS.includes(r)))

  for (const seat of SEATS) {
    const tier = stageTransitionTier(seat)
    if (TENANT_ADMIN_USER_TYPES.has(seat)) {
      // The ladder lib/kernel/egress-scope.ts already decides for this seat.
      const kind = resolveEgressScope({ userType: seat, userId: "u", brokerageId: "b", teamId: "t" }).kind
      const expected = kind === "team" ? "deal" : "brokerage"
      check(`roster seat ${seat}: admitted, tier '${tier}' matches egress-scope '${kind}'`, tier === expected)
    } else if (seat === "agent") {
      check(`agent: own deals only (tier 'deal')`, tier === "deal")
    } else if (seat === "tc") {
      check(`tc: the brokerage's deals (the survivor's own rule — a coordinator works every deal)`, tier === "brokerage")
    } else {
      check(`${seat}: may not move a deal`, tier === "none")
    }
  }
  check("a null / empty seat may not move a deal (fail closed — no default to 'agent')",
    stageTransitionTier(null) === "none" && stageTransitionTier(undefined) === "none" && stageTransitionTier("") === "none")
  check("legacy spellings resolve, case-folded (TC / transaction_coordinator / Admin)",
    stageTransitionTier("TC") === "brokerage" && stageTransitionTier("transaction_coordinator") === "brokerage" && stageTransitionTier("Admin") === "brokerage")

  console.log("\n[POSITIVE CONTROL — the retired gate fails the same rule]")
  const retiredTier = (seat: string | null) => {
    const role = seat ?? "agent" // the retired `role ?? user_type ?? "agent"` default
    return ["admin", "broker", "tc", "agent"].includes(toCanonicalRoleOrDefault(role, "contact")) ? "admitted" : "none"
  }
  const refusedRoster = roster.filter((r) => retiredTier(r) === "none")
  check(`the retired ["admin","broker","tc","agent"] gate refuses roster seats (${refusedRoster.join(", ")}) — the rule above would go red on a revert`,
    refusedRoster.includes("team_lead") && refusedRoster.includes("compliance_officer"))
  check("the retired helper admitted a seat-less row as an agent — the null check above would go red on a revert",
    retiredTier(null) === "admitted")

  console.log("\n[Source — the stage machine, orchestrator and gate read the survivors (stripped source)]")
  const read = (p: string) => stripComments(readFileSync(join(process.cwd(), p), "utf8"))
  const sm = read("app/actions/transaction-stage-machine.ts")
  const orch = read("lib/transactions/transaction-orchestrator.ts")
  const guard = read("lib/transactions/role-guard.ts")
  const handRolled = (src: string) => /function\s+requireCallerForBrokerage\b|\?\?\s*["']agent["']|(?:!==|===)\s*(?:params\.brokerageId|claimedBrokerageId)\b/.test(src)
  const literalRoleList = (src: string) => /\[\s*["'](?:admin|broker|tc|agent)["']\s*,\s*["'](?:admin|broker|tc|agent)["']/.test(src)
  check("stage machine: no private tenant helper, no role defaulted to 'agent', no hand-rolled claim comparison", !handRolled(sm))
  check("stage machine: all three doors go through requireCallerTenant", (sm.match(/\brequireCallerTenant\(\s*params\.brokerageId\s*\)/g) ?? []).length === 3)
  check("stage machine: the override path checks the claim through decideClaimedTenant", /decideClaimedTenant\(/.test(sm))
  check("stage machine: the role handed on is the session's users.user_type", /userRole:\s*auth\.userType\b/.test(sm) && !/auth\.userRole\b/.test(sm))
  check("orchestrator: advanceToStage AND checkAdvancement ask canTransitionStage", (orch.match(/\bcanTransitionStage\(/g) ?? []).length >= 2)
  check("orchestrator: no literal role list", !literalRoleList(orch))
  check("gate: the own-deal check crosses agents.user_id (agents.id ≠ users.id, §3)",
    /from\(\s*["']agents["']\s*\)[\s\S]{0,120}\.eq\(\s*["']user_id["']\s*,\s*context\.userId\s*\)/.test(guard) && !/agent_id\s*===\s*context\.userId/.test(guard))
  check("gate: the team half goes through the team-scope survivor (leadsAgentsTeam)", /\bleadsAgentsTeam\(/.test(guard))
  // Controls: the finders recognise the pre-93A text.
  const PRE = [
    "async function requireCallerForBrokerage(claimedBrokerageId: string) {",
    "  if (profile.brokerage_id !== claimedBrokerageId) return { ok: false }",
    '  return { ok: true, userRole: profile.role ?? profile.user_type ?? "agent" }',
    "}",
  ].join("\n")
  check("CONTROL: the pre-93A private helper IS recognised as hand-rolled", handRolled(PRE))
  check('CONTROL: the pre-93A orchestrator list IS recognised as a literal role list', literalRoleList('await assertUserHasRole(ctx, ["admin", "broker", "tc", "agent"])'))
}

function main() {
  console.log("\n[The derived vocabularies are non-empty — a guard that sees nothing passes everything]")
  check(`transactions.status vocabulary loaded (${VALID_STATUS.size} values)`, VALID_STATUS.size > 0)
  check(`transactions.stage vocabulary loaded (${VALID_STAGE.size} values)`, VALID_STAGE.size > 0)

  console.log("\n[Every stage maps to a status the live transactions_status_check accepts]")
  for (const stage of Object.values(TRANSACTION_STAGES)) {
    check(`stage in transactions_stage_check: ${stage}`, VALID_STAGE.has(stage))
    const status = STAGE_TO_STATUS_MAP[stage]
    check(`${stage} → status '${status}' is CHECK-valid`, VALID_STATUS.has(status))
    // Compared as strings on purpose: STAGE_TO_STATUS_MAP is now typed
    // Record<TransactionStage, TransactionStatus>, so `tsc` already proves the two
    // sets disjoint. The runtime assertion stays as the guard for the day the type
    // is widened back to `string` — a type is not a substitute for a proof.
    check(`${stage} status is never the raw UPPERCASE stage (the old bug)`, (status as string) !== (stage as string))
  }

  console.log("\n[Mapping is semantically correct across the lifecycle — the ladder, not a scheduling word]")
  check("UNDER_CONTRACT/INSPECTION/APPRAISAL → under_contract (contingencies still live)",
    ["UNDER_CONTRACT", "INSPECTION", "APPRAISAL"].every((s) => STAGE_TO_STATUS_MAP[s as keyof typeof STAGE_TO_STATUS_MAP] === "under_contract"))
  check("FINANCING_PENDING → pending (inspection/appraisal cleared, lender still working)",
    STAGE_TO_STATUS_MAP.FINANCING_PENDING === "pending")
  check("CLOSING_PREP → clear_to_close (the lender has issued CTC)",
    STAGE_TO_STATUS_MAP.CLOSING_PREP === "clear_to_close")
  check("CLOSED → closed", STAGE_TO_STATUS_MAP.CLOSED === "closed")
  check("LOST → lost", STAGE_TO_STATUS_MAP.LOST === "lost")
  check("no stage maps to `closing` — the value m291 deleted from the column",
    Object.values(STAGE_TO_STATUS_MAP).every((s) => (s as string) !== "closing"))

  console.log("\n[The ONE vocabulary and the live CHECK agree — CLAUDE.md §6]")
  check("lib/transactions/transaction-status.ts lists exactly the live CHECK values",
    TRANSACTION_STATUSES.length === VALID_STATUS.size && TRANSACTION_STATUSES.every((s) => VALID_STATUS.has(s)))

  console.log("\n[Completeness — no stage left unmapped]")
  check("every TRANSACTION_STAGES key has a status mapping", Object.values(TRANSACTION_STAGES).every((s) => typeof STAGE_TO_STATUS_MAP[s] === "string"))

  console.log("\n[POSITIVE CONTROL — the finder still recognises the defect it was written for]")
  const POISONED: Record<string, string> = { ...STAGE_TO_STATUS_MAP, CLOSING_PREP: "closing" }
  const caught = Object.values(POISONED).some((s) => !VALID_STATUS.has(s))
  check("a `closing` status re-introduced into the map IS rejected by the derived vocabulary", caught)
  const caughtUpper = !VALID_STATUS.has("CLOSING_PREP")
  check("the ORIGINAL bug (raw UPPERCASE stage as status) IS rejected by the derived vocabulary", caughtUpper)

  whoMayMoveADeal()

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ STAGE_STATUS_FAIL"); process.exit(1) }
  console.log(" ✅ STAGE_STATUS_PASS — advanceStage writes a CHECK-valid status for every stage; the lifecycle can advance")
}

main()

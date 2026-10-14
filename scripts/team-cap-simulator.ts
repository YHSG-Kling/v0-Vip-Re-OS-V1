#!/usr/bin/env tsx
/**
 * scripts/team-cap-simulator.ts   (npm run test:team-cap)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TEAM CAP PROOF (m461).
 *
 * OWNER RULING: "brokerage and teams may also have commission caps."
 *
 * A cap is a CEILING ON WHAT AN ENTITY COLLECTS from an agent per anniversary
 * year. 07-apply-cap.ts says it in its own header — "Cap tracks brokerage's
 * cumulative earnings, NOT agent's" — and once the brokerage has taken
 * cap_amount its share drops to $0 and the agent keeps the rest.
 *
 * THE GAP THIS CLOSES: the TEAM's take had no ceiling at all. Stage 08 applied
 * the team-lead override with no cap, so a team collected for ever while the
 * brokerage stopped. That asymmetry is now closed by applyTeamCap +
 * team_cap_tracking.
 *
 * WHAT IS PROVEN HERE, IN THREE LAYERS:
 *
 *  [1] PURE ARITHMETIC — uncapped, pre-cap, the exact boundary where the cut is
 *      SPLIT between team and agent, post-cap, a zero cap, a cap already
 *      exceeded, cents rounding at an odd dollar amount, and cent conservation.
 *      No database, fully deterministic.
 *
 *  [2] FAIL CLOSED — BEHAVIOURAL, not asserted by comment. The fail-closed
 *      decision is a PURE function (interpretTeamCapLedgerRead), so it is driven
 *      with supabase-js's real failure shape ({ data: null, error }) — which it
 *      RESOLVES rather than rejects — and must THROW rather than return null,
 *      because null means UNCAPPED (layer 1 proves that). A refused read that
 *      returned null would silently uncap the team. The genuine no-row case must
 *      still read as null, so refusal and absence stay distinguishable.
 *
 *  [3] SOURCE LOCK — the wiring that layers 1-2 cannot reach: the fail-closed
 *      branch in stage 08, the ordering reasoning, the counter write-back in
 *      stage 11, and the DELIBERATE ABSENCE of a team cap-crush celebration.
 *
 * NEGATIVE CONTROLS: every assertion is re-run against a deliberately broken
 * variant — a wrong implementation of the math for layer 1-2, a mutated copy of
 * the source for layer 3 — and must go RED. A check that cannot fail is theatre.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  applyTeamCap,
  interpretTeamCapLedgerRead,
  TeamCapLedgerUnreadable,
  type TeamCapLedger,
  type TeamCapLedgerRead,
  type TeamCapResult,
} from "../lib/commission/team-lead-split"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail = "") => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; fails.push(n); console.log(`  ✗ ${n}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

const STAGE08 = "lib/commission/waterfall/08-team-split.ts"
const STAGE11 = "lib/commission/waterfall/11-validate-persist.ts"
const PURE = "lib/commission/team-lead-split.ts"

/** A team_cap_tracking row, in the DOLLARS the numeric(12,2) columns actually hold. */
const ledger = (capDollars: number, paidDollars: number): TeamCapLedger => ({
  id: "ledger-uuid", capAmountDollars: capDollars, capPaidToDateDollars: paidDollars,
})

// ═════════════════════════════════════════════════════════════════════════════
// LAYER 1 — PURE ARITHMETIC
// ═════════════════════════════════════════════════════════════════════════════

type CapFn = (leadCents: number, l: TeamCapLedger | null) => TeamCapResult
type Probe = { id: string; name: string; run: (f: CapFn) => boolean }

const PROBES: Probe[] = [
  {
    id: "A1",
    name: "A1 UNCAPPED — no ledger row (or teams.cap_amount NULL) ⇒ the team keeps its whole cut, reported as 'n/a', nothing to persist",
    run: (f) => {
      const r = f(150_00, null)
      return r.teamCents === 150_00 && r.agentKeepsCents === 0
        && r.capStatus === "n/a" && r.capApplied === false && r.amountTowardsCapCents === 0
    },
  },
  {
    id: "A2",
    name: "A2 PRE-CAP — $10,000 cap, $2,000 collected, a $1,500 cut fits under the ceiling and counts towards it in full",
    run: (f) => {
      const r = f(1500_00, ledger(10_000, 2_000))
      return r.teamCents === 1500_00 && r.agentKeepsCents === 0
        && r.capStatus === "pre_cap" && r.capApplied === false && r.amountTowardsCapCents === 1500_00
    },
  },
  {
    id: "A3",
    name: "A3 EXACT-FIT BOUNDARY — a cut equal to the remainder is pre_cap, not hit_cap: nothing was handed back, so nothing was capped",
    run: (f) => {
      const r = f(1000_00, ledger(10_000, 9_000)) // remaining exactly $1,000
      return r.teamCents === 1000_00 && r.agentKeepsCents === 0
        && r.capStatus === "pre_cap" && r.capApplied === false && r.amountTowardsCapCents === 1000_00
    },
  },
  {
    id: "A4",
    name: "A4 HIT-CAP BOUNDARY — $1,000 left, a $1,500 cut: the team takes ONLY the $1,000 remainder and the agent keeps the $500 difference",
    run: (f) => {
      const r = f(1500_00, ledger(10_000, 9_000))
      return r.teamCents === 1000_00 && r.agentKeepsCents === 500_00
        && r.capStatus === "hit_cap" && r.capApplied === true && r.amountTowardsCapCents === 1000_00
    },
  },
  {
    id: "A5",
    name: "A5 POST-CAP — the ceiling is already met: the team collects $0 and the agent keeps the entire cut (the mirror of stage 07's capped brokerage)",
    run: (f) => {
      const r = f(1500_00, ledger(10_000, 10_000))
      return r.teamCents === 0 && r.agentKeepsCents === 1500_00
        && r.capStatus === "post_cap" && r.capApplied === true && r.amountTowardsCapCents === 0
    },
  },
  {
    id: "A6",
    name: "A6 ZERO CAP — cap_amount 0 is a real ceiling of zero, NOT 'unset': the team collects nothing at all",
    run: (f) => {
      const r = f(1500_00, ledger(0, 0))
      return r.teamCents === 0 && r.agentKeepsCents === 1500_00
        && r.capStatus === "post_cap" && r.amountTowardsCapCents === 0
    },
  },
  {
    id: "A7",
    name: "A7 CAP ALREADY EXCEEDED — $6,000 collected against a $5,000 cap never produces a NEGATIVE team cut or claws money back",
    run: (f) => {
      const r = f(1500_00, ledger(5_000, 6_000))
      return r.teamCents === 0 && r.agentKeepsCents === 1500_00
        && r.capStatus === "post_cap" && r.amountTowardsCapCents === 0
    },
  },
  {
    id: "A8",
    name: "A8 CENTS AT AN ODD AMOUNT — a $8,192.05 cap is 819205 whole cents (a bare *100 leaves 819204.9999999999), so an exactly-fitting cut is pre_cap and every cent stays an integer",
    run: (f) => {
      const r = f(819_205, ledger(8_192.05, 0))
      return r.capStatus === "pre_cap" && r.teamCents === 819_205
        && Number.isInteger(r.teamCents) && Number.isInteger(r.amountTowardsCapCents)
        // …and a hit-cap split off the same odd cap still lands on whole cents.
        && f(900_000, ledger(8_192.05, 1_234.56)).teamCents === 695_749
    },
  },
  {
    id: "A9",
    name: "A9 CENTS ARE CONSERVED in every branch — teamCents + agentKeepsCents always equals the uncapped cut, so stage 11's waterfall validation cannot drift",
    run: (f) => {
      const cases: Array<[number, TeamCapLedger | null]> = [
        [1500_00, null], [1500_00, ledger(10_000, 2_000)], [1500_00, ledger(10_000, 9_000)],
        [1500_00, ledger(10_000, 10_000)], [1500_00, ledger(0, 0)], [1500_00, ledger(5_000, 6_000)],
        [333_33, ledger(1_000, 999.99)], [819_205, ledger(8_192.05, 0)],
      ]
      return cases.every(([cut, l]) => {
        const r = f(cut, l)
        return r.teamCents + r.agentKeepsCents === cut
          && r.teamCents >= 0 && r.agentKeepsCents >= 0
          && r.amountTowardsCapCents === (l === null ? 0 : r.teamCents)
      })
    },
  },
  {
    id: "A10",
    name: "A10 A NON-POSITIVE CUT is never turned into a charge (defensive: resolveTeamLeadOverride already returns no distribution there)",
    run: (f) => {
      const z = f(0, ledger(10_000, 0)), n = f(-5_00, ledger(10_000, 0)), nan = f(Number.NaN, ledger(10_000, 0))
      return [z, n, nan].every((r) => r.teamCents === 0 && r.amountTowardsCapCents === 0 && r.capApplied === false)
    },
  },
]

// ─── the deliberately broken variants ────────────────────────────────────────
// Each reintroduces exactly one wrong decision. `kills` names the probes that
// MUST go red against it — that is what makes those probes checks rather than
// decoration.

const MUTANTS: Array<{ name: string; kills: string[]; fn: CapFn }> = [
  {
    name: "M1 an uncapped team is charged nothing instead of its full cut (null ledger read as a zero ceiling)",
    kills: ["A1"],
    fn: (cut, l) => (l === null
      ? { teamCents: 0, agentKeepsCents: cut, capApplied: true, capStatus: "post_cap", amountTowardsCapCents: 0 }
      : applyTeamCap(cut, l)),
  },
  {
    name: "M2 the ledger counter is never advanced (amountTowardsCap always 0) — the team would collect for ever and the cap never arrives",
    kills: ["A2", "A3", "A9"],
    fn: (cut, l) => ({ ...applyTeamCap(cut, l), amountTowardsCapCents: 0 }),
  },
  {
    name: "M3 the boundary uses `<` instead of `<=` — a cut that fits EXACTLY is wrongly reported as hitting the cap",
    kills: ["A3", "A8"],
    fn: (cut, l) => {
      if (!l || cut <= 0) return applyTeamCap(cut, l)
      const remaining = Math.round(l.capAmountDollars * 100) - Math.round(l.capPaidToDateDollars * 100)
      if (remaining <= 0) return applyTeamCap(cut, l)
      if (cut < remaining) return { teamCents: cut, agentKeepsCents: 0, capApplied: false, capStatus: "pre_cap", amountTowardsCapCents: cut }
      return { teamCents: remaining, agentKeepsCents: cut - remaining, capApplied: true, capStatus: "hit_cap", amountTowardsCapCents: remaining }
    },
  },
  {
    name: "M4 the hit-cap deal is not SPLIT — the team takes the whole cut and blows straight through the ceiling",
    kills: ["A4"],
    fn: (cut, l) => {
      const r = applyTeamCap(cut, l)
      return r.capStatus === "hit_cap" ? { ...r, teamCents: cut, agentKeepsCents: 0, amountTowardsCapCents: cut } : r
    },
  },
  {
    name: "M5 a capped team keeps collecting (post_cap still charges the agent) — the exact defect this change exists to remove",
    kills: ["A5", "A6", "A7"],
    fn: (cut, l) => {
      const r = applyTeamCap(cut, l)
      return r.capStatus === "post_cap" ? { ...r, teamCents: cut, agentKeepsCents: 0, amountTowardsCapCents: cut } : r
    },
  },
  {
    name: "M6 a zero cap is treated as 'no cap configured' (falsy cap_amount read as uncapped)",
    kills: ["A6"],
    fn: (cut, l) => (l && !l.capAmountDollars ? applyTeamCap(cut, null) : applyTeamCap(cut, l)),
  },
  {
    name: "M7 an over-collected ledger yields a NEGATIVE cut — the team hands money back mid-deal",
    kills: ["A7", "A9"],
    fn: (cut, l) => {
      if (!l || cut <= 0) return applyTeamCap(cut, l)
      const remaining = Math.round(l.capAmountDollars * 100) - Math.round(l.capPaidToDateDollars * 100)
      if (remaining >= cut) return applyTeamCap(cut, l)
      return { teamCents: remaining, agentKeepsCents: cut - remaining, capApplied: true, capStatus: remaining <= 0 ? "post_cap" : "hit_cap", amountTowardsCapCents: remaining }
    },
  },
  {
    name: "M8 dollars→cents by a bare `* 100` instead of dollarsToCents — $8,192.05 becomes 819204.9999999999 and the split lands on fractional cents",
    kills: ["A8"],
    fn: (cut, l) => {
      if (!l || cut <= 0) return applyTeamCap(cut, l)
      const remaining = l.capAmountDollars * 100 - l.capPaidToDateDollars * 100
      if (remaining <= 0) return { teamCents: 0, agentKeepsCents: cut, capApplied: true, capStatus: "post_cap", amountTowardsCapCents: 0 }
      if (cut <= remaining) return { teamCents: cut, agentKeepsCents: 0, capApplied: false, capStatus: "pre_cap", amountTowardsCapCents: cut }
      return { teamCents: remaining, agentKeepsCents: cut - remaining, capApplied: true, capStatus: "hit_cap", amountTowardsCapCents: remaining }
    },
  },
  {
    name: "M9 conservation broken — the capped remainder is swallowed instead of returned to the agent",
    kills: ["A4", "A5", "A6", "A7", "A9"],
    fn: (cut, l) => ({ ...applyTeamCap(cut, l), agentKeepsCents: 0 }),
  },
  {
    name: "M10 a zero/negative cut is turned into a charge anyway",
    kills: ["A10"],
    fn: (cut, l) => (cut <= 0 || !Number.isFinite(cut)
      ? { teamCents: 100, agentKeepsCents: 0, capApplied: false, capStatus: "pre_cap", amountTowardsCapCents: 100 }
      : applyTeamCap(cut, l)),
  },
]

function pureLayer() {
  console.log("\n[1 · PURE ARITHMETIC — a ceiling on what the TEAM collects]")
  for (const p of PROBES) check(p.name, p.run(applyTeamCap))

  console.log("\n[1b · NEGATIVE CONTROLS — every probe must go RED against a broken variant]")
  const killedBy = new Map<string, string[]>()
  for (const m of MUTANTS) {
    for (const id of m.kills) {
      const probe = PROBES.find((p) => p.id === id)
      if (!probe) { check(`NEGATIVE CONTROL ${m.name} — probe ${id} not found`, false); continue }
      let stillGreen: boolean
      try { stillGreen = probe.run(m.fn) } catch { stillGreen = false }
      check(`NEGATIVE CONTROL ${id} vs ${m.name} — went RED`, !stillGreen,
        stillGreen ? `probe ${id} stayed green against the broken variant` : "")
      if (!stillGreen) killedBy.set(id, [...(killedBy.get(id) ?? []), m.name])
    }
  }
  // COVERAGE: an assertion with no broken variant that kills it is theatre.
  const uncovered = PROBES.filter((p) => !killedBy.has(p.id)).map((p) => p.id)
  check(`NEGATIVE-CONTROL COVERAGE — all ${PROBES.length} arithmetic probes are killed by at least one broken variant`,
    uncovered.length === 0, uncovered.length ? `uncovered: ${uncovered.join(", ")}` : "")
}

// ═════════════════════════════════════════════════════════════════════════════
// LAYER 2 — FAIL CLOSED (behavioural)
// ═════════════════════════════════════════════════════════════════════════════
//
// supabase-js RESOLVES a failed query, so a read that ignores `error` hands back
// data:null — and null means UNCAPPED (probe A1). A refused read would therefore
// silently uncap the team. This drives the real reader with that exact shape.

const CTX = { teamId: "team-uuid", agentId: "agent-uuid" }

/** The supabase-js result shape, built by hand — this is exactly what
 *  `.maybeSingle()` resolves to, INCLUDING on failure (it resolves, it does not
 *  reject, which is the whole reason this layer exists). */
const readResult = (data: TeamCapLedgerRead["data"], error: { message: string } | null): TeamCapLedgerRead => ({ data, error })

type Interpreter = (r: TeamCapLedgerRead, c: { teamId: string; agentId: string }) => TeamCapLedger | null
type FailProbe = { id: string; name: string; run: (f: Interpreter) => boolean }

const FAIL_PROBES: FailProbe[] = [
  {
    id: "F1",
    name: "F1 FAIL CLOSED — a REFUSED read THROWS TeamCapLedgerUnreadable; it must never come back as null, because null is 'uncapped' (A1)",
    run: (f) => {
      try {
        f(readResult(null, { message: "permission denied for table team_cap_tracking" }), CTX)
        return false
      } catch (e) { return e instanceof TeamCapLedgerUnreadable }
    },
  },
  {
    id: "F2",
    name: "F2 …and an ERROR ALONGSIDE DATA still throws — a partial/failed read is never quietly used as a ceiling",
    run: (f) => {
      try {
        f(readResult({ id: "row-1", cap_amount: 10_000, cap_paid_to_date: 0 }, { message: "statement timeout" }), CTX)
        return false
      } catch (e) { return e instanceof TeamCapLedgerUnreadable }
    },
  },
  {
    id: "F3",
    name: "F3 a GENUINE no-row result (data null, error null) still reads as null ⇒ uncapped — refusal and absence stay distinguishable",
    run: (f) => f(readResult(null, null), CTX) === null,
  },
  {
    id: "F4",
    name: "F4 a real row is mapped to the ledger shape with the numeric(12,2) DOLLARS coerced from PostgREST strings, and feeds the cap math correctly",
    run: (f) => {
      const l = f(readResult({ id: "row-1", cap_amount: "10000.00", cap_paid_to_date: "9000.00" }, null), CTX)
      return !!l && l.id === "row-1" && l.capAmountDollars === 10_000 && l.capPaidToDateDollars === 9_000
        && applyTeamCap(1500_00, l).capStatus === "hit_cap"
        && applyTeamCap(1500_00, l).teamCents === 1000_00
    },
  },
  {
    id: "F5",
    name: "F5 the thrown error NAMES the team and agent whose ledger could not be read — an operator can find the row",
    run: (f) => {
      try { f(readResult(null, { message: "permission denied" }), CTX); return false }
      catch (e) { return e instanceof Error && e.message.includes("team-uuid") && e.message.includes("agent-uuid") && e.message.includes("permission denied") }
    },
  },
]

/** The broken interpreters. Each is one someone would plausibly write. */
const FAIL_MUTANTS: Array<{ name: string; kills: string[]; fn: Interpreter }> = [
  {
    name: "N1 the interpreter ignores `error` — a REFUSAL silently becomes 'no cap configured' and the team is UNCAPPED (the defect this layer exists for)",
    kills: ["F1", "F2"],
    fn: (r) => (r.data ? { id: r.data.id, capAmountDollars: Number(r.data.cap_amount), capPaidToDateDollars: Number(r.data.cap_paid_to_date) } : null),
  },
  {
    name: "N2 it checks `error` only when there is no data — a failed read that still returned a row is used as a ceiling",
    kills: ["F2"],
    fn: (r, c) => (r.data ? { id: r.data.id, capAmountDollars: Number(r.data.cap_amount), capPaidToDateDollars: Number(r.data.cap_paid_to_date) } : interpretTeamCapLedgerRead(r, c)),
  },
  {
    name: "N3 it throws on ANY empty result — a team with no ledger row can no longer be uncapped (fails OPEN in the other direction)",
    kills: ["F3"],
    fn: () => { throw new TeamCapLedgerUnreadable("no row") },
  },
  {
    name: "N4 the numeric(12,2) strings are passed through uncoerced — the cap arithmetic then runs on '10000.00'",
    kills: ["F4"],
    fn: (r) => (r.data ? { id: r.data.id, capAmountDollars: r.data.cap_amount as number, capPaidToDateDollars: r.data.cap_paid_to_date as number } : null),
  },
  {
    name: "N5 the throw is anonymous — an operator cannot tell which team/agent ledger refused",
    kills: ["F5"],
    fn: (r, c) => { if (r.error) throw new TeamCapLedgerUnreadable("cap read failed"); return interpretTeamCapLedgerRead(r, c) },
  },
]

function failClosedLayer() {
  console.log("\n[2 · FAIL CLOSED — an unreadable ledger is NOT an uncapped team]")
  for (const p of FAIL_PROBES) check(p.name, p.run(interpretTeamCapLedgerRead))

  console.log("\n[2b · NEGATIVE CONTROLS — each broken interpreter must go RED]")
  for (const m of FAIL_MUTANTS) {
    for (const id of m.kills) {
      const probe = FAIL_PROBES.find((p) => p.id === id)!
      let stillGreen: boolean
      try { stillGreen = probe.run(m.fn) } catch { stillGreen = false }
      check(`NEGATIVE CONTROL ${id} vs ${m.name} — went RED`, !stillGreen,
        stillGreen ? `probe ${id} stayed green against the broken interpreter` : "")
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// LAYER 3 — SOURCE LOCK (the wiring layers 1-2 cannot reach)
// ═════════════════════════════════════════════════════════════════════════════

type SrcProbe = { id: string; name: string; run: (s8: string, s11: string, pure: string) => boolean }

/** Stage 11's team-cap block only, so a match elsewhere in a 400-line file cannot pass a check for it. */
function teamCapBlock(s11: string): string {
  const start = s11.indexOf("// 3b. Update TEAM cap tracking")
  if (start < 0) return ""
  const end = s11.indexOf("// 4. Log lifecycle event", start)
  return s11.slice(start, end < 0 ? s11.length : end)
}

const SRC_PROBES: SrcProbe[] = [
  {
    id: "S1",
    name: "S1 stage 08 turns an unreadable ledger into a ZERO team cut with status 'unavailable' — never a full charge against an unchecked ceiling",
    run: (s8) => /err instanceof TeamCapLedgerUnreadable[\s\S]{0,600}?leadDeductionCents = 0[\s\S]{0,300}?teamCapStatus = 'unavailable'/.test(s8),
  },
  {
    id: "S2",
    name: "S2 the cap is read ONLY when teams.cap_amount is set — a NULL cap_amount short-circuits to uncapped without touching the ledger",
    run: (s8) => /agreement\.capAmount === null \|\| agreement\.capAmount === undefined\s*\n?\s*\?\s*null\s*\n?\s*:\s*await readTeamCapLedger/.test(s8),
  },
  {
    id: "S3",
    name: "S3 the ORDERING reasoning is in the file: stage 07 runs first, so a capped agent's net is inflated by the brokerage's forgone share",
    run: (s8) => /Stage 07 \(brokerage cap\) runs BEFORE this stage/.test(s8)
      && /INFLATED by\s*\n?\s*\/\/ the brokerage's forgone share/.test(s8)
      && /pay their team MORE/.test(s8),
  },
  {
    id: "S4",
    name: "S4 the capped team's cut is what is deducted from the agent (conservation preserved through the existing expression)",
    run: (s8) => /leadDeductionCents = capped\.teamCents/.test(s8)
      && s8.includes("- totalTeamDeductionCents - leadDeductionCents"),
  },
  {
    id: "S5",
    name: "S5 a fully-capped team writes NO $0 distribution row, and a hit-cap row carries cap_applied + cap_status so a CDA can explain the number",
    run: (s8) => /if \(capped\.teamCents > 0\)/.test(s8)
      && /cap_applied: capped\.capApplied/.test(s8) && /cap_status: capped\.capStatus/.test(s8),
  },
  {
    id: "S6",
    name: "S6 stage 11 advances the team ledger: fetch the active row → add → write back is_capped, mirroring the agent-cap block above it",
    run: (_s8, s11) => {
      const b = teamCapBlock(s11)
      return /\.from\('team_cap_tracking'\)\s*\n\s*\.select\('id, cap_amount, cap_paid_to_date'\)/.test(b)
        && /\.from\('team_cap_tracking'\)\s*\n\s*\.update\(\{[\s\S]{0,200}?cap_paid_to_date: newPaidToDate[\s\S]{0,200}?is_capped: isCapped/.test(b)
    },
  },
  {
    id: "S7",
    name: "S7 stage 11 destructures and CHECKS the team ledger read error — an unreadable ledger is reported, never mistaken for 'no row'",
    run: (_s8, s11) => {
      const b = teamCapBlock(s11)
      return /const \{ data: teamCap, error: teamCapReadError \}/.test(b)
        && /if \(teamCapReadError\)/.test(b) && /console\.error/.test(b)
    },
  },
  {
    id: "S8",
    name: "S8 stage 11 adds the counter in CENTS then converts once — the ledger column is dollars, the waterfall is cents, and float drift here is money",
    run: (_s8, s11) => /centsToDollars\(\s*\n?\s*dollarsToCents\(paidBeforeDollars\) \+ \(context\.teamAmountTowardsCap \?\? 0\)/.test(teamCapBlock(s11)),
  },
  {
    id: "S9",
    name: "S9 NO team cap-crush celebration — the agent-cap notification is NOT reused, and the reason is recorded so it is not 'restored' as a missing feature",
    run: (_s8, s11) => {
      const b = teamCapBlock(s11)
      // The name appears in the BLOCK's explanation of why it is not reused; what
      // must be absent is a CALL and the import of the module.
      return !/celebrateCapCrush\(/.test(b) && !/detectCapCrush\(/.test(b)
        && !/finance\/cap-crush/.test(b)
        && /NO CAP-CRUSH CELEBRATION FOR THE TEAM CAP, deliberately/.test(b)
    },
  },
  {
    id: "S11",
    name: "S11 the cap read names its columns explicitly and never select('*') — a vanished column must break loudly, not read back as a $0 cap",
    run: (s8) => {
      const start = s8.indexOf("async function readTeamCapLedger")
      const body = start < 0 ? "" : s8.slice(start, s8.indexOf("\n}", start))
      return body.includes(".select('id, cap_amount, cap_paid_to_date')") && !/\.select\(['"`]\*/.test(body)
    },
  },
  {
    id: "S12",
    name: "S12 the read hands the WHOLE { data, error } to the pure interpreter — no local branch may reduce a failed read to a null ledger",
    run: (s8) => {
      const start = s8.indexOf("async function readTeamCapLedger")
      const body = start < 0 ? "" : s8.slice(start, s8.indexOf("\n}", start))
      return /return interpretTeamCapLedgerRead\(\{ data, error \}/.test(body)
        && !/if \(!data\) return null/.test(body) && !/if \(error\)/.test(body)
    },
  },
  {
    id: "S10",
    name: "S10 the pure layer states that a cap configured on `teams` with no ledger row is UNENFORCED — the m461 defect one level down, not a silent gap",
    run: (_s8, _s11, pure) => /an unseeded cap is an unenforced cap/.test(pure),
  },
]

const SRC_MUTANTS: Array<{ name: string; kills: string[]; mutate: (s8: string, s11: string, pure: string) => [string, string, string] }> = [
  {
    name: "P1 the unreadable-ledger branch is removed — the read failure falls into the generic swallow and the team is charged in full next time",
    kills: ["S1"],
    mutate: (s8, s11, p) => [s8.replace(/if \(err instanceof TeamCapLedgerUnreadable\) \{[\s\S]*?\n    \} else \{/, "if (false) {\n    } else {"), s11, p],
  },
  {
    name: "P2 the ledger is read even when teams.cap_amount is NULL (an uncapped team pays for a query and can be capped by a stale row)",
    kills: ["S2"],
    mutate: (s8, s11, p) => [s8.replace(/agreement\.capAmount === null \|\| agreement\.capAmount === undefined\n\s*\? null\n\s*: await readTeamCapLedger\(supabase, agreement\.teamId, context\)/, "await readTeamCapLedger(supabase, agreement.teamId, context)"), s11, p],
  },
  {
    name: "P3 the ordering reasoning is deleted from the file",
    kills: ["S3"],
    mutate: (s8, s11, p) => [s8.replace(/Stage 07 \(brokerage cap\) runs BEFORE this stage/, "Team splits happen here"), s11, p],
  },
  {
    name: "P4 the UNCAPPED cut is deducted from the agent again, ignoring the ceiling that was just computed",
    kills: ["S4"],
    mutate: (s8, s11, p) => [s8.replace("leadDeductionCents = capped.teamCents", "leadDeductionCents = leadCents"), s11, p],
  },
  {
    name: "P5 a $0 distribution row is written for a fully-capped team, and the cap status is dropped from the row",
    kills: ["S5"],
    mutate: (s8, s11, p) => [s8.replace("if (capped.teamCents > 0) {", "if (true) {").replace("cap_status: capped.capStatus,", ""), s11, p],
  },
  {
    name: "P6 stage 11 never writes the team counter back (the cap is computed and then forgotten)",
    kills: ["S6"],
    mutate: (s8, s11, p) => [s8, s11.replace(/\.from\('team_cap_tracking'\)\n\s*\.update\(\{/, ".from('team_cap_tracking_disabled')\n        .update({"), p],
  },
  {
    name: "P7 stage 11 stops destructuring the team ledger read error",
    kills: ["S7"],
    mutate: (s8, s11, p) => [s8, s11.replace("const { data: teamCap, error: teamCapReadError }", "const { data: teamCap }"), p],
  },
  {
    name: "P8 stage 11 adds the two dollar floats directly instead of adding in cents",
    kills: ["S8"],
    mutate: (s8, s11, p) => [s8, s11.replace(/const newPaidToDate = centsToDollars\(\n\s*dollarsToCents\(paidBeforeDollars\) \+ \(context\.teamAmountTowardsCap \?\? 0\),\n\s*\)/, "const newPaidToDate = paidBeforeDollars + centsToDollars(context.teamAmountTowardsCap ?? 0)"), p],
  },
  {
    name: "P9 the agent cap-crush celebration is reused for the team cap (same dedupe key — it would suppress the agent's own notification)",
    kills: ["S9"],
    mutate: (s8, s11, p) => [s8, s11.replace("      // NO CAP-CRUSH CELEBRATION FOR THE TEAM CAP, deliberately.", "      const { celebrateCapCrush } = await import('@/lib/finance/cap-crush')"), p],
  },
  {
    name: "P11 the cap read goes back to select('*')",
    kills: ["S11", "S12"],
    mutate: (s8, s11, p) => [s8.replace(".select('id, cap_amount, cap_paid_to_date')\n    .eq('team_id', teamId)", ".select('*')\n    .eq('team_id', teamId)").replace("return interpretTeamCapLedgerRead({ data, error } as TeamCapLedgerRead, {", "if (error) throw new TeamCapLedgerUnreadable(error.message)\n  if (!data) return null\n  return interpretTeamCapLedgerRead({ data, error } as TeamCapLedgerRead, {"), s11, p],
  },
  {
    name: "P12 the reader re-implements the fail-closed decision locally instead of deferring to the proven pure one",
    kills: ["S12"],
    mutate: (s8, s11, p) => [s8.replace("  return interpretTeamCapLedgerRead({ data, error } as TeamCapLedgerRead, {\n    teamId,\n    agentId: context.agentId,\n  })", "  if (!data) return null\n  return { id: (data as { id: string }).id, capAmountDollars: Number((data as { cap_amount: number }).cap_amount), capPaidToDateDollars: Number((data as { cap_paid_to_date: number }).cap_paid_to_date) }"), s11, p],
  },
  {
    name: "P10 the unseeded-cap gap is no longer stated, so the next reader assumes teams.cap_amount alone enforces a ceiling",
    kills: ["S10"],
    mutate: (s8, s11, p) => [s8, s11, p.replace("an unseeded cap is an unenforced cap", "caps are enforced")],
  },
]

function sourceLayer() {
  console.log("\n[3 · SOURCE LOCK — the wiring]")
  const s8 = src(STAGE08), s11 = src(STAGE11), pure = src(PURE)
  for (const p of SRC_PROBES) check(p.name, p.run(s8, s11, pure))

  console.log("\n[3b · NEGATIVE CONTROLS — each mutated source must go RED]")
  for (const m of SRC_MUTANTS) {
    for (const id of m.kills) {
      const probe = SRC_PROBES.find((p) => p.id === id)!
      const [a, b, c] = m.mutate(s8, s11, pure)
      const changed = a !== s8 || b !== s11 || c !== pure
      check(`NEGATIVE CONTROL ${id} vs ${m.name} — the mutation actually applied`, changed,
        changed ? "" : "the mutation matched nothing — the probe was never re-tested")
      let stillGreen: boolean
      try { stillGreen = probe.run(a, b, c) } catch { stillGreen = false }
      check(`NEGATIVE CONTROL ${id} vs ${m.name} — went RED`, !stillGreen,
        stillGreen ? `probe ${id} stayed green against the broken copy` : "")
    }
  }
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Team cap simulator — a ceiling on what a TEAM collects (m461)")
  console.log("══════════════════════════════════════════════════")
  pureLayer()
  failClosedLayer()
  sourceLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ TEAM_CAP_FAIL"); process.exit(1) }
  console.log(" ✅ TEAM_CAP_PASS — the team's take has a ceiling, the boundary deal is split, the counter is written in cents, and an unreadable ledger fails CLOSED instead of silently uncapping the team")
}
main()

#!/usr/bin/env tsx
/**
 * scripts/outcome-ledger-simulator.ts   (npm run test:outcome-ledger) — pure, no DB.
 * ─────────────────────────────────────────────────────────────────────────────
 * THE LEDGERS THAT RECORD WHAT HAPPENED.
 *
 * ── 1. THE CALL NEVER CLOSED (real, and the sharpest here) ──────────────────
 * app/api/voice/end-call/route.ts closed a call with
 * `outcome: 'ended_by_agent'` — a value voice_calls.outcome does not admit — in
 * the SAME update as `status` and `ended_at`. One rejected column takes the
 * whole update with it, and the result was discarded, so: the agent hung up,
 * Twilio ended the call, the route returned success, and the ledger row stayed
 * `in_progress` with a NULL ended_at forever.
 *
 * Verified live: the update was rejected by voice_calls_outcome_check and the
 * row afterwards still read `in_progress / ended_at=NULL`. The corrected update
 * closes it. 'completed' is the admitted disposition for a call that ran and
 * ended normally, and it matches the Twilio status callback, which closes every
 * terminated leg as completed and puts the real disposition in outcome.
 *
 * ── 2. A CHECK CONSTRAINT THAT ENFORCED NOTHING (m298) ──────────────────────
 * I came to error_resolution_log.retry_result expecting the same defect — the
 * code writes 'scheduled', which the declared vocabulary
 * (success|failure|pending) does not contain — and the live probe DISPROVED it:
 * the insert was ACCEPTED. The constraint read
 *
 *   CHECK (retry_result = ANY (ARRAY['success','failure','pending', NULL]))
 *
 * and that NULL element makes it INERT. For an unlisted value, `= ANY(...)`
 * evaluates to NULL rather than FALSE, and a CHECK is SATISFIED when its
 * expression is NULL. It accepted every string ever written.
 *
 * That is worse than no constraint: the schema — and the vocabulary snapshot
 * this repo generates from it — asserted a three-value column, so a fourth
 * spelling drifted in with nothing to object from either side. m298 rewrites it
 * as `retry_result IS NULL OR retry_result = ANY (...)`, which is what the NULL
 * element was clearly meant to express, and auto-retry.ts moves onto 'pending'
 * (which already means "queued, not yet run" — two spellings for one state is
 * the drift being removed).
 *
 * A repo-wide sweep found exactly ONE constraint with this shape. The pure
 * assertion below encodes the trap so it cannot be reintroduced.
 *
 * ── 3. THREE DEAD RIDERS (not defects — say so plainly) ─────────────────────
 * Each of these named an impossible value inside an `.in()` alongside a real
 * one, so the query worked and nothing was lost:
 *   · subscriptions.status 'unpaid' — dunning. stripe-status.ts normalizes
 *     Stripe's 'unpaid' to 'past_due' before storage, so no row can carry it.
 *     billing-access.ts carried it too, plus 'incomplete_expired' and the
 *     American 'canceled' (the column spells it 'cancelled').
 *   · newsletter_sends.status 'delivered' — the send-dedupe guard.
 *   · direct_mail_recipients.delivery_status 'undeliverable'.
 * They are removed because a set listing impossible states reads as though they
 * are reachable, which is how the next reader inherits the drift.
 */
import { readFileSync } from "node:fs"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import { stripComments } from "./strip-comments"
import {
  RETRY_RESULT_SCHEDULED, RETRY_RESULT_SUCCESS, RETRY_RESULT_FAILURE,
} from "../lib/errors/auto-retry"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}
const src = (p: string) =>
  stripComments(readFileSync(p, "utf8"))

/**
 * PURE — does a CHECK definition contain the inert-NULL trap?
 *
 * `col = ANY (ARRAY[..., NULL])` can never be FALSE: an unlisted value compares
 * NULL against the NULL element, `= ANY` yields NULL, and a CHECK passes on
 * NULL. The constraint enforces nothing while looking like it enforces a
 * vocabulary.
 */
export function hasInertNullInArray(constraintDef: string): boolean {
  const m = /=\s*ANY\s*\(\s*ARRAY\s*\[([\s\S]*?)\]/i.exec(constraintDef)
  if (!m) return false
  return /(^|,)\s*NULL\b/i.test(m[1])
}

console.log("══════════════════════════════════════════════════")
console.log(" Outcome ledgers (what happened is what got written)")
console.log("══════════════════════════════════════════════════")

console.log("\n[pure] the inert-NULL constraint trap")
{
  check("flags the exact shape that was live",
    hasInertNullInArray("CHECK ((retry_result = ANY (ARRAY['success'::text, 'failure'::text, 'pending'::text, NULL::text])))"))
  check("a healthy ANY(ARRAY[...]) is not flagged",
    !hasInertNullInArray("CHECK ((status = ANY (ARRAY['a'::text, 'b'::text])))"))
  check("the CORRECTED form is not flagged",
    !hasInertNullInArray("CHECK (((retry_result IS NULL) OR (retry_result = ANY (ARRAY['success'::text, 'failure'::text, 'pending'::text]))))"))
  check("a non-ANY check is not flagged", !hasInertNullInArray("CHECK ((score >= 0))"))
  check("a value merely CONTAINING 'null' is not flagged",
    !hasInertNullInArray("CHECK ((kind = ANY (ARRAY['nullable_thing'::text])))"))
}

console.log("\n── the snapshot must never carry the trap ──")
{
  // The snapshot is generated from the live constraints. If an inert-NULL check
  // ever returns, the value NULL would land in a vocabulary array here.
  const bad: string[] = []
  for (const [table, cols] of Object.entries(CHECK_VOCABULARIES)) {
    for (const [col, values] of Object.entries(cols as Record<string, string[]>)) {
      if (values.some((v) => v === null || v === "NULL" || v === "null")) bad.push(`${table}.${col}`)
    }
  }
  check(`no snapshot vocabulary contains a NULL element (${bad.slice(0, 3).join(", ") || "none"})`, bad.length === 0)
}

console.log("\n── retry_result: one spelling, and it is an admitted one ──")
{
  const live = CHECK_VOCABULARIES.error_resolution_log?.retry_result ?? []
  check(`the vocabulary is the three real states (${live.join(", ")})`, live.length === 3)
  check("'scheduled' is NOT one of them", !live.includes("scheduled"))
  for (const v of [RETRY_RESULT_SCHEDULED, RETRY_RESULT_SUCCESS, RETRY_RESULT_FAILURE]) {
    check(`the constant '${v}' is admitted`, live.includes(v))
  }
  check("the deferred lane reuses 'pending' rather than inventing a fourth state",
    RETRY_RESULT_SCHEDULED === "pending")

  const a = src("lib/errors/auto-retry.ts")
  check("no 'scheduled' literal remains", !/"scheduled"/.test(a))
  check("the write uses the constant", /retry_result: RETRY_RESULT_SCHEDULED/.test(a))
  check("the cron filter uses the SAME constant — both ends move together",
    /\.eq\("retry_result", RETRY_RESULT_SCHEDULED\)/.test(a))
  check("the status reader uses it too", /=== RETRY_RESULT_SCHEDULED/.test(a))
  check("the schedule insert now CHECKS its error — the row IS the schedule",
    /const \{ error: scheduleErr \}/.test(a) && /Retry not scheduled/.test(a))
}

console.log("\n── voice end-call: the row actually closes ──")
{
  const live = CHECK_VOCABULARIES.voice_calls?.outcome ?? []
  check("'ended_by_agent' is not an admitted outcome", !live.includes("ended_by_agent"))
  check("'completed' is", live.includes("completed"))

  const r = src("app/api/voice/end-call/route.ts")
  check("the route no longer writes the impossible outcome", !/ended_by_agent/.test(r))
  check("it closes with an admitted outcome", /outcome: "completed"/.test(r))
  check("status and outcome still move together — that was the trap",
    /status: "completed",[\s\S]{0,80}outcome: "completed"/.test(r))
  check("the close is error-checked", /const \{ error: closeErr \}/.test(r))
  check("…and a failed close no longer reports success",
    /success: false/.test(r) && /could not be closed/.test(r))
}

console.log("\n── the dead riders are gone (these were never broken) ──")
{
  const subs = CHECK_VOCABULARIES.subscriptions?.status ?? []
  check("subscriptions.status cannot hold 'unpaid'", !subs.includes("unpaid"))
  check("…nor 'incomplete_expired' nor the American 'canceled'",
    !subs.includes("incomplete_expired") && !subs.includes("canceled") && subs.includes("cancelled"))

  const dun = src("lib/billing/dunning.ts")
  check("dunning filters the one real delinquent status", /\.eq\("status", "past_due"\)/.test(dun) && !/"unpaid"/.test(dun))
  const acc = src("lib/billing/billing-access.ts")
  check("the paywall's blocking set holds only admitted statuses",
    [...(acc.match(/BLOCKING_STATUSES = new Set\(\[([^\]]*)\]/) ?? [, ""])[1].matchAll(/"([^"]+)"/g)]
      .map((m) => m[1]).every((s) => subs.includes(s)))

  const nl = CHECK_VOCABULARIES.newsletter_sends?.status ?? []
  check("newsletter_sends.status cannot hold 'delivered'", !nl.includes("delivered"))
  const cron = src("app/api/cron/publish-newsletters/route.ts")
  // Anchor to the newsletter_sends chain — the file also filters CAMPAIGN
  // status ('scheduled'), which belongs to a different table's vocabulary.
  const sendsWindow = cron.slice(cron.indexOf('.from("newsletter_sends")'))
  const nlSet = [...(sendsWindow.match(/\.in\("status", \[([^\]]*)\]/) ?? [, ""])[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
  check(`the send-dedupe set is all admitted (${nlSet.join(", ")})`,
    nlSet.length > 0 && nlSet.every((s) => nl.includes(s)))

  const dm = CHECK_VOCABULARIES.direct_mail_recipients?.delivery_status ?? []
  check("direct_mail delivery_status cannot hold 'undeliverable'", !dm.includes("undeliverable"))
  const ma = src("lib/agents/marketing-agent.ts")
  check("the failure set is all admitted",
    /\.in\("delivery_status", \["returned", "failed"\]\)/.test(ma) && !/undeliverable/.test(ma))
}

console.log("\n──────────────────────────────────────────────────")
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ OUTCOME_LEDGER_FAIL"); process.exit(1) }
console.log(" ✅ OUTCOME_LEDGER_PASS — the record of what happened can be written, and the CHECK means it")

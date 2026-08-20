#!/usr/bin/env tsx
/**
 * scripts/lead-lifecycle-suppression-simulator.ts   (npm run test:lead-lifecycle) — pure, no DB.
 * ─────────────────────────────────────────────────────────────────────────────
 * A LEAD WHO ASKS TO BE LEFT ALONE MUST BE MARKED AS HAVING ASKED.
 *
 * leads.lifecycle_state carries a live CHECK:
 *
 *   CHECK (lifecycle_state = ANY (ARRAY['raw','unconsented','consented',
 *          'isa_qualifying','assigned','appointment','representation',
 *          'long_term_nurture']))
 *   DEFAULT 'raw'   (nullable)
 *
 * ── 1. The opt-out was thrown away ──────────────────────────────────────────
 * haltEngagementForNegativeReply ran on a negative inbound reply and wrote:
 *
 *     .update({ call_stop_flag: true, ai_isa_owner: false,
 *               lifecycle_state: 'do_not_contact' })
 *
 * 'do_not_contact' is not in the vocabulary, so the UPDATE was rejected — and a
 * rejected update writes none of its columns, not just the bad one. Measured on
 * the live database with a probe lead: after the update, `call_stop_flag` was
 * still **false**. The lead had asked to be left alone and nothing recorded it.
 * supabase-js reports this in `{ error }`, which the call site discarded.
 *
 * Suppression is a FLAG, not a funnel stage: dnc_status / call_stop_flag. The
 * reactivation enroller already honours dnc_status. The lifecycle write was not
 * only invalid, it was the wrong shape.
 *
 * ── 2. The timeline entry could never be written ────────────────────────────
 * The same function logged the opt-out to `activities` with
 * `contact_id: params.leadId`. activities.contact_id FKs contacts(id), so a lead
 * id raises foreign_key_violation — verified live. The agent was never shown that
 * their lead opted out. Leads travel on entity_type/entity_id, which the rest of
 * the codebase already does.
 *
 * ── 3. The ISA kept auto-replying to handed-off leads ───────────────────────
 * shouldStopAutoResponding tested 'do_not_contact' and 'qualified', neither of
 * which is in the vocabulary. The only live arm was 'consented' — so a lead
 * already assigned, booked for an appointment, or under representation kept
 * getting robot replies.
 *
 * ── 4. Three sweeps silently dropped every null-state lead ──────────────────
 * warmth ranking, persona-drift and reactivation-enrolment each filtered
 * `neq('lifecycle_state','converted')`. 'converted' is not in the vocabulary, so
 * the predicate never excluded anything it meant to — and in SQL `col <> 'x'` is
 * NULL for a NULL column, which filters the row OUT. The column is nullable.
 * Measured live over two probe leads (one 'isa_qualifying', one NULL): the old
 * filter returned 1, the null-safe one returned 2.
 */
import { readFileSync } from "node:fs"
import {
  LEAD_LIFECYCLE_STATES,
  LEAD_LIFECYCLE_DEFAULT,
  LEAD_CONVERTED_STATE,
  LEAD_HANDED_OFF_STATES,
  NOT_CONVERTED_FILTER,
  isLeadHandedOff,
  isLeadSuppressed,
} from "../lib/lead-pipeline/lead-lifecycle"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import { stripComments } from "./strip-comments"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}
/** Reads CODE. These files quote the dead literals in their headers. */
const src = (p: string) =>
  stripComments(readFileSync(p, "utf8"))

console.log("\n── the module matches the live CHECK ──")
{
  const live = CHECK_VOCABULARIES.leads?.lifecycle_state ?? []
  check(`the snapshot carries 8 states (${live.length})`, live.length === 8)
  check("every state the module declares is admitted",
    LEAD_LIFECYCLE_STATES.every((s) => live.includes(s)))
  check("every state the CHECK admits is declared", live.every((s) =>
    (LEAD_LIFECYCLE_STATES as readonly string[]).includes(s)))
  check("the declared default is the column default ('raw')",
    LEAD_LIFECYCLE_DEFAULT === "raw" && live.includes("raw"))
  for (const dead of ["converted", "qualified", "do_not_contact", "new"]) {
    check(`'${dead}' is not a lifecycle state`,
      !(LEAD_LIFECYCLE_STATES as readonly string[]).includes(dead) && !live.includes(dead))
  }
  check("conversion is 'representation', which IS in the vocabulary",
    live.includes(LEAD_CONVERTED_STATE))
}

console.log("\n── suppression is a flag; lifecycle_state has no value for it ──")
{
  check("dnc_status alone suppresses", isLeadSuppressed({ dnc_status: true }) === true)
  check("call_stop_flag alone suppresses", isLeadSuppressed({ call_stop_flag: true }) === true)
  check("both false → not suppressed",
    isLeadSuppressed({ dnc_status: false, call_stop_flag: false }) === false)
  check("neither present → not suppressed (no silent mute)", isLeadSuppressed({}) === false)
  check("nulls are not truthy", isLeadSuppressed({ dnc_status: null, call_stop_flag: null }) === false)

  const h = src("lib/ai-isa/conversation-handler.ts")
  check("the opt-out no longer writes an impossible lifecycle_state",
    !/lifecycle_state: 'do_not_contact'/.test(h))
  check("it sets BOTH suppression flags",
    /call_stop_flag: true/.test(h) && /dnc_status: true/.test(h))
  check("it hands the ISA back (ai_isa_owner: false)", /ai_isa_owner: false/.test(h))
  check("it no longer discards the update result",
    /const \{ error: suppressError \}/.test(h) && /if \(suppressError\)/.test(h))
}

console.log("\n── the opt-out reaches the agent's timeline ──")
{
  const h = src("lib/ai-isa/conversation-handler.ts")
  check("the activity does NOT put a lead id in contact_id", !/contact_id: params\.leadId/.test(h))
  check("it travels on entity_type/entity_id like every other lead write",
    /entity_type: 'lead'/.test(h) && /entity_id: params\.leadId/.test(h))
}

console.log("\n── the ISA stops once a human has the lead ──")
{
  check("consented → stop", isLeadHandedOff("consented") === true)
  check("assigned → stop (was being auto-replied to)", isLeadHandedOff("assigned") === true)
  check("appointment → stop (was being auto-replied to)", isLeadHandedOff("appointment") === true)
  check("representation → stop (was being auto-replied to)", isLeadHandedOff("representation") === true)
  check("raw → keep going", isLeadHandedOff("raw") === false)
  check("unconsented → keep going", isLeadHandedOff("unconsented") === false)
  check("isa_qualifying → keep going (this is the ISA's own stage)",
    isLeadHandedOff("isa_qualifying") === false)
  check("long_term_nurture → keep going", isLeadHandedOff("long_term_nurture") === false)
  check("null → keep going, never crash", isLeadHandedOff(null) === false)
  check("an unknown value → keep going (safe default)", isLeadHandedOff("do_not_contact") === false)
  check("every handed-off state is a real state",
    LEAD_HANDED_OFF_STATES.every((s) => (LEAD_LIFECYCLE_STATES as readonly string[]).includes(s)))

  const h = src("lib/ai-isa/conversation-handler.ts")
  check("shouldStopAutoResponding asks the module, not its own literals",
    /isLeadSuppressed\(lead\)/.test(h) && /isLeadHandedOff\(lead\.lifecycle_state\)/.test(h))
  check("it selects the dnc_status it now depends on", /dnc_status, lifecycle_state/.test(h))
  check("the impossible 'qualified' lifecycle test is gone",
    !/lifecycle_state === 'qualified'/.test(h))
}

console.log("\n── the three sweeps are null-safe ──")
{
  check("the filter names the real terminal state",
    NOT_CONVERTED_FILTER.includes(`neq.${LEAD_CONVERTED_STATE}`))
  check("the filter spells out the NULL case, which .neq() alone excludes",
    NOT_CONVERTED_FILTER.startsWith("lifecycle_state.is.null,"))

  for (const p of [
    "lib/intelligence/lead-warmth-runner.ts",
    "lib/lead-pipeline/persona-drift-runner.ts",
    "lib/lead-pipeline/reactivation-enroller.ts",
  ]) {
    const s = src(p)
    check(`${p} uses the shared filter`, /\.or\(NOT_CONVERTED_FILTER\)/.test(s))
    check(`${p} no longer asks for the impossible 'converted'`,
      !/lifecycle_state", "converted"/.test(s))
  }
}

console.log("\n──────────────────────────────────────────────────")
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ LEAD_LIFECYCLE_FAIL"); process.exit(1) }
console.log(" ✅ LEAD_LIFECYCLE_PASS — opt-outs stick, the agent is told, and no lead is dropped for having no state")

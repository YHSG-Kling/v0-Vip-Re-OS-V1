#!/usr/bin/env tsx
/**
 * scripts/dispatch-recipient-identity-simulator.ts (npm run test:dispatch-recipient-identity)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TCPA CONSENT GATE WAS BEING SKIPPED, BY AN ID-SPACE SLIP.
 *
 * `contacts.id` and `leads.id` are DISTINCT id spaces in this system. Five
 * outbound call sites read their recipient out of `contacts` and then handed
 * that contacts.id to dispatch's `leadId` parameter:
 *
 *   app/actions/communications.ts:sendSMS
 *   app/actions/communications.ts:sendEmail
 *   app/actions/ai-communication-hub.ts   (inbox reply)
 *   app/actions/ai-isa.ts                 (ghost recovery, x2 — both "campaign")
 *
 * dispatchSms/dispatchEmail choose where to look the recipient up with
 *
 *     const table = params.contactId ? "contacts" : "leads"
 *
 * so with only `leadId` set, they went looking for a contacts.id in `leads`,
 * `.maybeSingle()` returned null, and the guard
 *
 *     if (!recipientError && recipient) { …evaluateOutboundCompliance… }
 *
 * fell straight through. evaluateOutboundCompliance — prior express consent
 * (TCPA Rule 7), restricted-state consent (Rule 6), per-channel opt-out, the
 * quiet-hours and fair-housing content checks — NEVER RAN on anything sent
 * through those five paths. checkSuppression still ran (it is keyed on the phone
 * number and the email address), so DNC and opt-out-by-address were never the
 * hole; consent was.
 *
 * SECOND DEFECT FROM THE SAME SLIP, COSTING MONEY RATHER THAN COMPLIANCE.
 * vendor_usage_tracking.lead_id is `FOREIGN KEY (lead_id) REFERENCES leads(id)`
 * — verified live against pg_constraint. Every one of those sends therefore put
 * a contacts.id into a leads FK and raised 23503. logVendorUsage is called with
 * `void` (fire-and-forget), so the rejection was invisible and the cost row for
 * that send was silently dropped. dispatchEmail additionally wrote
 * `leadId: params.leadId ?? params.contactId`, which is the same substitution
 * spelled as a default — it would have re-created the defect for any caller who
 * did the right thing.
 *
 * THE FIX IS TO RESOLVE, NEVER SUBSTITUTE: a contact is passed as `contactId`,
 * a lead as `leadId`, and the contact's identity reaches the usage ledger
 * through `metadata.contact_id`, which is not a foreign key.
 *
 * BEHAVIOUR CHANGE, STATED PLAINLY: an SMS to a contact with no `tcpa_consent`
 * and no active representation is now HARD BLOCKED where it previously went
 * out. That is the gate working. Email and direct mail are deliberately not
 * consent-gated (the ISA allowance) and are unaffected.
 */
import { readFileSync, existsSync } from "node:fs"
import { stripComments } from "./strip-comments"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}
/** Comments stripped: this file's own prose must never satisfy an assertion. */
const src = (p: string) =>
  existsSync(p)
    ? stripComments(readFileSync(p, "utf8"))
    : ""

const DISPATCH = src("lib/providers/dispatch.ts")
const COMMS    = src("app/actions/communications.ts")
const HUB      = src("app/actions/ai-communication-hub.ts")
const ISA      = src("app/actions/ai-isa.ts")
const GATE     = src("lib/kernel/communication-compliance.ts")

console.log("\n── the gate exists and is reached through the recipient lookup ──")
{
  check("dispatch picks its lookup table from contactId",
    /const table = params\.contactId \? "contacts" : "leads"/.test(DISPATCH))
  check("…and only evaluates compliance when that lookup found a row",
    /if \(!recipientError && recipient\) \{[\s\S]{0,200}?evaluateOutboundCompliance/.test(DISPATCH))
  // Both channels carry the same shape; a fix to one and not the other is how
  // this defect class survives being found.
  check("both dispatchSms and dispatchEmail run the gate",
    (DISPATCH.match(/evaluateOutboundCompliance\(/g) ?? []).length >= 2)
  check("the gate hard-blocks SMS without TCPA consent",
    /channel === "sms" \|\| channel === "phone" \|\| channel === "voicemail"[\s\S]{0,200}?!consentGiven/.test(GATE) &&
    /code: "no_tcpa_consent"[\s\S]{0,120}?severity: "hard_block"/.test(GATE))
}

console.log("\n── no outbound call site routes a contact through the lead slot ──")
{
  // The exact defect: a contacts.id handed to leadId. If any of these come back,
  // the consent gate is being skipped again on that path.
  for (const [name, file] of [
    ["communications.ts", COMMS],
    ["ai-communication-hub.ts", HUB],
    ["ai-isa.ts", ISA],
  ] as const) {
    check(`${name} passes no contactId through leadId`,
      !/leadId:\s*\w*\.?contactId/.test(file))
  }
  check("sendSMS identifies its recipient as a contact",
    /dispatchSms\(\{[\s\S]{0,600}?contactId: params\.contactId/.test(COMMS))
  check("sendEmail identifies its recipient as a contact",
    /dispatchEmail\(\{[\s\S]{0,700}?contactId: params\.contactId/.test(COMMS))
  check("the inbox reply identifies its recipient as a contact",
    /dispatchEmail\(\{[\s\S]{0,700}?contactId:\s*params\.contactId/.test(HUB))
  check("both ghost-recovery sends identify their recipient as a contact",
    (ISA.match(/contactId:\s+params\.contactId,/g) ?? []).length >= 2)
}

console.log("\n── the usage ledger's lead FK is never handed a contact ──")
{
  // vendor_usage_tracking.lead_id REFERENCES leads(id). A contacts.id here is a
  // 23503 on a fire-and-forget write — an invisibly dropped cost row.
  check("the email usage log does not substitute contactId for leadId",
    !/leadId: params\.leadId \?\? params\.contactId/.test(DISPATCH))
  check("…no dispatch usage log substitutes across the two id spaces",
    !/leadId:[^,\n]*\?\?[^,\n]*contactId/.test(DISPATCH))
  // The identity is not lost — it just travels somewhere that is not a FK.
  check("the contact identity still reaches the ledger, as metadata",
    (DISPATCH.match(/contact_id: params\.contactId/g) ?? []).length >= 2)
}

console.log("\n──────────────────────────────────────────────────")
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ DISPATCH_RECIPIENT_IDENTITY_FAIL"); process.exit(1) }
console.log(" ✅ DISPATCH_RECIPIENT_IDENTITY_PASS — every outbound send resolves its recipient, so the consent gate runs")

#!/usr/bin/env tsx
/**
 * scripts/referral-consolidation-simulator.ts (npm run test:referral-consolidation)
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE REFERRAL STATUS VOCABULARY, AND ONE FUNCTION THAT WRITES A REFERRAL.
 *
 * `referrals.status` is CHECK-constrained to seven values. FOUR places each
 * carried their own idea of that list, and they disagreed:
 *
 *   referral-pipeline-panel.tsx      "new","contacted","qualified","converted","closed"
 *   app/dashboard/agent/referrals    5 of the 7 — no "assigned", no "lost"
 *   app/referrals/pipeline/page.tsx  all 7 (the only one that was right)
 *   multi-persona.ts:trackReferral   all 7 — and ZERO callers
 *
 * WHAT THAT COST.
 *
 * 1. TWO STAGES ON THE BOARD COULD NOT BE SET. `new` and `converted` are in no
 *    constraint. Both call sites passed the board's string through
 *    `status as any` and awaited updateReferralStatus with no catch, so picking
 *    either stage sent an UPDATE the database refused and the UI showed nothing.
 *    Proved live: both inserts raise check_violation.
 *
 * 2. THREE STAGES HAD NO COLUMN. assigned / under_contract / lost referrals
 *    matched none of the board's five columns and rendered nowhere at all.
 *
 * 3. THE ONLY CODE THAT COULD WRITE referred_lead_id HAD NO CALLERS. trackReferral
 *    was the single writer of that column in the whole codebase, so in practice
 *    it was never set. Same for a partner-less referral (partner_id is nullable)
 *    and for closed_at stamped at creation.
 *
 * 4. THE CREATE DIALOG DROPPED WHAT IT COLLECTED. The referred person's name is
 *    a required field and went nowhere — referrals.referral_name, which every
 *    pipeline card renders, was never written by anything. "Potential Value" was
 *    folded into commission_amount, and Notes was sent as referral_source.
 *
 * 5. IT INVENTED A PARTNER TO SATISFY A REQUIRED ARGUMENT. Because partnerId was
 *    required, the panel created a referral_partners row named after the REFERRED
 *    person — backwards, a partner is who SENT the referral — then deleted it
 *    again as a compensating transaction when the insert failed.
 *
 * trackReferral is now retired: every one of its four unique capabilities was
 * moved onto the wired createReferral FIRST. Its `transactionId` parameter was
 * accepted and never written, so there was nothing there to carry over.
 * deletePartner, whose only caller was that rollback, is now a real affordance
 * on the partner list instead of becoming an orphan.
 *
 * Verified live on brokerage b0000000…0001: a partner-less referral at
 * status='assigned' with referred_lead_id set persisted with referral_name,
 * value_estimate and notes; a referral created at status='closed' carried
 * closed_at; 'new' and 'converted' were both refused by the constraint. Test
 * rows removed; ZZTEST residue = 0.
 */
import { readFileSync, existsSync } from "node:fs"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
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

const VOCAB    = src("lib/referrals/referral-status.ts")
const ACTIONS  = src("app/actions/referrals/referral-actions.ts")
const PANEL    = src("app/dashboard/referrals/components/os/referral-pipeline-panel.tsx")
const OSCLIENT = src("app/referrals/referrals-os-client.tsx")
const PIPECLI  = src("app/referrals/pipeline/pipeline-os-client.tsx")
const AGENTPG  = src("app/dashboard/agent/referrals/page.tsx")
const PERSONA  = src("app/actions/multi-persona.ts")

const LIVE = CHECK_VOCABULARIES.referrals?.status ?? []

console.log("\n── the vocabulary module mirrors the live constraint ──")
{
  check("the live constraint still has exactly 7 values", LIVE.length === 7)
  for (const v of LIVE) {
    check(`  '${v}' is offered by the module`, new RegExp(`value:\\s*"${v}"`).test(VOCAB))
  }
  // A member here that the database does not admit is the whole failure mode.
  const declared = [...VOCAB.matchAll(/value:\s*"([a-z_]+)"/g)].map((m) => m[1])
  check("the module offers nothing the constraint refuses",
    declared.every((d) => LIVE.includes(d)))
  check("…and offers every value the constraint admits",
    LIVE.every((v) => declared.includes(v)))
  check("the two states that cannot be stored are not offered",
    !/value:\s*"(new|converted)"/.test(VOCAB))
}

console.log("\n── no surface carries its own copy of the list ──")
{
  check("the board reads the module, not a local array",
    /REFERRAL_STATUSES/.test(PANEL) && !/const STATUSES\s*=\s*\[/.test(PANEL))
  check("…and no longer offers 'new' or 'converted'",
    !/"(new|converted)"/.test(PANEL))
  check("the agent pipeline builds its stages from the module",
    /PIPELINE_STAGES[^=]*=\s*REFERRAL_STATUSES\.map/.test(AGENTPG))
  check("…so 'assigned' and 'lost' now have a column",
    !/key:\s*"received"[\s\S]{0,300}?key:\s*"closed"/.test(AGENTPG))
  check("the row type takes its status from the module",
    /status:\s*ReferralStatus/.test(ACTIONS) &&
    !/status:\s*"received"\s*\|\s*"contacted"/.test(ACTIONS))
}

console.log("\n── every surface reads the module's labels, none formats its own ──")
{
  const PIPEPG = src("app/referrals/pipeline/page.tsx")
  const LIFETIME = src("app/lifetime-customers/page.tsx")
  check("the pipeline page dropped its local colour map",
    !/const statusColors\s*=\s*\{/.test(PIPEPG) && /referralStatusBadgeClass\(referral\.status\)/.test(PIPEPG))
  check("…and labels the status instead of regexing the stored value",
    /referralStatusLabel\(referral\.status\)/.test(PIPEPG) &&
    !/referral\.status\.replace\(/.test(PIPEPG))
  check("the lifetime-customers radar labels it too",
    /referralStatusLabel\(ref\.status\)/.test(LIFETIME) &&
    !/ref\.status\?\.replace\(/.test(LIFETIME))
}

console.log("\n── the `as any` that let an unstorable value reach the column is gone ──")
{
  check("referrals-os-client passes a typed status",
    /status:\s*ReferralStatus/.test(OSCLIENT) && !/status as any/.test(OSCLIENT))
  check("pipeline-os-client passes a typed status",
    /status:\s*ReferralStatus/.test(PIPECLI) && !/status as any/.test(PIPECLI))
  check("the board's prop is typed too",
    /onUpdateStatus:\s*\(referralId:\s*string,\s*status:\s*ReferralStatus\)/.test(PANEL))
  // A type is a compile-time promise. The server action takes client input.
  check("the server action validates the status at runtime as well",
    /if \(!isReferralStatus\(status\)\)/.test(ACTIONS))
}

console.log("\n── trackReferral's four capabilities live on the wired path ──")
{
  check("trackReferral is gone", !/export async function trackReferral/.test(PERSONA))
  check("…and its removal is recorded with named replacements",
    /CONSOLIDATED AWAY — trackReferral/.test(readFileSync("app/actions/multi-persona.ts", "utf8")))

  check("[1/4] the caller can choose the starting status",
    /status\?:\s*ReferralStatus/.test(ACTIONS))
  check("…defaulting to the canonical default, not a literal",
    /params\.status \?\? DEFAULT_REFERRAL_STATUS/.test(ACTIONS))

  check("[2/4] referred_lead_id has a caller-facing parameter",
    /referredLeadId\?:\s*string/.test(ACTIONS))
  check("…and the insert writes it",
    /referred_lead_id:\s*params\.referredLeadId \?\? null/.test(ACTIONS))

  check("[3/4] a partner-less referral is expressible",
    /partnerId\?:\s*string/.test(ACTIONS) && /partner_id:\s*params\.partnerId \?\? null/.test(ACTIONS))
  check("…and the partner counter is skipped when there is no partner",
    /if \(params\.partnerId\) \{[\s\S]{0,600}?increment_referral_received/.test(ACTIONS))

  check("[4/4] a referral created already closed is stamped closed_at",
    /closed_at:\s*status === "closed" \? new Date\(\)\.toISOString\(\) : null/.test(ACTIONS))
}

console.log("\n── the create dialog's fields reach a column ──")
{
  check("referral_name is written",
    /referral_name:\s*referralName/.test(ACTIONS))
  check("…derived from the referred person, not from a partner row",
    /referralName[\s\S]{0,200}?params\.referredPerson\?\.firstName/.test(ACTIONS))
  check("value_estimate has its own parameter and is not folded into commission",
    /valueEstimate\?:\s*number/.test(ACTIONS) && /value_estimate:\s*params\.valueEstimate \?\? null/.test(ACTIONS))
  check("notes has its own parameter and is not sent as referral_source",
    /notes\?:\s*string/.test(ACTIONS) && /notes:\s*params\.notes\?\.trim\(\) \|\| null/.test(ACTIONS))
  check("the board sends the name it makes required",
    /firstName:\s*firstName \|\| undefined/.test(PANEL))
  check("…the potential value as a value estimate",
    /valueEstimate:\s*formData\.potential_value/.test(PANEL))
  check("…and the notes as notes",
    /notes:\s*formData\.notes \|\| undefined/.test(PANEL))
}

console.log("\n── the throwaway partner, and the failure that was swallowed ──")
{
  check("the board no longer creates a partner to satisfy a required argument",
    !/createPartner\(/.test(PANEL))
  check("…so there is no compensating delete to run either",
    !/deletePartner\(/.test(PANEL))
  check("a failed create is shown to the agent, not swallowed",
    /setError\(err instanceof Error \? err\.message/.test(PANEL) && !/\}\s*catch\s*\{\s*$/m.test(PANEL))
  check("a failed status change is shown too",
    /Failed to update status/.test(PANEL))
}

console.log("\n── deletePartner was finished, not orphaned ──")
{
  check("deletePartner still exists", /export async function deletePartner/.test(ACTIONS))
  check("…it is tenant-scoped",
    /deletePartner[\s\S]{0,700}?\.eq\("agent_id",\s*agentId\)[\s\S]{0,200}?\.eq\("brokerage_id",\s*brokerageId\)/.test(ACTIONS))
  check("…and the agent has a real surface for it",
    /deletePartner\(partner\.id\)/.test(AGENTPG))
  check("…which refuses to strand referrals",
    /referralCount > 0/.test(AGENTPG))
}

console.log("\n── partner details that were captured are now shown ──")
{
  check("the partner row type carries email/phone/agreement_date",
    /email:\s*string \| null/.test(ACTIONS) &&
    /phone:\s*string \| null/.test(ACTIONS) &&
    /agreement_date:\s*string \| null/.test(ACTIONS))
  check("the partner list renders the stored contact details",
    /p\.email &&/.test(AGENTPG) && /p\.phone &&/.test(AGENTPG))
  check("…and shows a label where it used to print the stored value",
    /referralPartnerTypeLabel\(p\.partner_type\)/.test(AGENTPG))
}

console.log("\n──────────────────────────────────────────────────")
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ REFERRAL_CONSOLIDATION_FAIL"); process.exit(1) }
console.log(" ✅ REFERRAL_CONSOLIDATION_PASS — one status vocabulary, one referral writer, nothing lost")

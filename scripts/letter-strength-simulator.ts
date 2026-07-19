#!/usr/bin/env tsx
/**
 * scripts/letter-strength-simulator.ts   (npm run test:letter-strength)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the PRE-QUAL vs PRE-APPROVAL training loop (owner directive: agents AND contacts learn
 * which letter is the stronger one, and the KERNEL determines the portal view + education):
 *
 * PURE:   assessFinancingLetterStrength — every branch. DATA HONESTY: the OS records no explicit
 *         pre-qual vs pre-approval letter TYPE, so strength keys off buyer_financial_profiles'
 *         verified / letter-on-file / expiry / cash signals — never a fabricated type.
 * SOURCE: (1) the AGENT lesson rides the onboarding-curriculum authoring idiom (CORE topic, every
 *         tier); (2) the BUYER lesson rides the client-education syllabus with stage tags for the
 *         intake/financing window (prospect + pre_approval_pending) that the kernel's education
 *         context (resolveEducationContext → learning-router composer) matches; (3) the loan-
 *         checklist rail shows the honest upgrade line linking the education; (4) the offer-
 *         strategy brief notes pre-qual-strength financing honestly in the agent rationale.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { assessFinancingLetterStrength } from "../lib/financing/letter-strength"
import { CLIENT_SYLLABUS, clientTag } from "../lib/education/client-education-curriculum"
import { topicsForTier } from "../lib/education/onboarding-curriculum"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

function pureLayer() {
  console.log("\n[assessFinancingLetterStrength · pure — every branch, honest signals only]")
  const now = new Date("2026-07-19T00:00:00Z")

  const cash = assessFinancingLetterStrength({ isCashBuyer: true }, now)
  check("cash buyer → no letter nudge (proof-of-funds is a different conversation)",
    cash.strength === "cash" && cash.buyerNudge === null && cash.agentNote === null)

  const strong = assessFinancingLetterStrength({ verified: true, preApprovalAmount: 450000, preApprovalLetterDocId: "doc-1", preApprovalExpiresAt: "2026-09-01" }, now)
  check("verified, unexpired pre-approval → strong, no nudge",
    strong.strength === "verified_preapproval" && strong.buyerNudge === null && strong.agentNote === null)

  const unverified = assessFinancingLetterStrength({ verified: false, preApprovalAmount: 400000 }, now)
  check("unverified letter → pre-qual strength: nudge + agent note name the stronger letter",
    unverified.strength === "unverified_letter"
    && /pre-approval is the stronger letter/i.test(unverified.buyerNudge ?? "")
    && /sellers weight/i.test(unverified.agentNote ?? ""))

  const none = assessFinancingLetterStrength(null, now)
  check("nothing on file → no_letter: honest upgrade nudge + agent coaching note",
    none.strength === "no_letter" && !!none.buyerNudge && /pre-approval/i.test(none.agentNote ?? ""))

  const expired = assessFinancingLetterStrength({ verified: true, preApprovalAmount: 450000, preApprovalExpiresAt: "2026-05-01" }, now)
  check("expired letter (even verified) → refresh nudge citing the 60-90 day life",
    expired.strength === "expired_letter" && /60-90/.test(expired.buyerNudge ?? "") && /60-90/.test(expired.agentNote ?? ""))

  check("expiry alone never fabricates a letter (no amount/doc → no_letter, not expired)",
    assessFinancingLetterStrength({ preApprovalExpiresAt: "2026-05-01" }, now).strength === "no_letter")
}

function educationLayer() {
  console.log("\n[education — one truth, two audiences, on the canonical authoring rails]")

  // AGENT lesson — CORE onboarding topic, every tier, AI-authored via the onboarding idiom.
  const tiers = ["solo_agent", "team", "brokerage", "multi_location"] as const
  check("agent lesson (financing_letter_strength) is a CORE topic in EVERY tier's curriculum",
    tiers.every((t) => topicsForTier(t).some((x) => x.key === "financing_letter_strength" && x.audienceRoles.includes("agent"))))
  const agentTopic = topicsForTier("solo_agent").find((x) => x.key === "financing_letter_strength")!
  check("agent brief carries the substance: no underwriting vs lender-verified, seller weighting, upgrade-early coaching, 60-90 day expiry",
    /self-reported/i.test(agentTopic.brief) && /lender-verified/i.test(agentTopic.brief)
    && /sellers actually weight|sellers.*weight/i.test(agentTopic.brief)
    && /EARLY/i.test(agentTopic.brief) && /60-90/.test(agentTopic.brief)
    && /present letter strength/i.test(agentTopic.brief))

  // BUYER lesson — client syllabus, stage-tagged to the kernel's intake/financing window.
  const buyerTopic = CLIENT_SYLLABUS.find((t) => t.key === "buyer_letter_strength")
  check("buyer lesson exists in the client syllabus (buyer_stage kind)", !!buyerTopic && buyerTopic.kind === "buyer_stage")
  check("buyer lesson fires while pre-approval is PENDING (stages prospect + pre_approval_pending)",
    !!buyerTopic && buyerTopic.milestone === "pre_approval_pending"
    && (buyerTopic.stages ?? []).includes("prospect") && (buyerTopic.stages ?? []).includes("pre_approval_pending"))
  check("buyer brief is plain-language + honest: stronger letter, sellers take it seriously, 60-90 days, defers to agent/lender",
    !!buyerTopic && /STRONGER letter/i.test(buyerTopic.brief) && /take.*seriously/i.test(buyerTopic.brief)
    && /60-90/.test(buyerTopic.brief) && /No jargon/i.test(buyerTopic.brief))
  check("buyer lesson tag is namespaced + unique on the client rail",
    !!buyerTopic && clientTag(buyerTopic) === "client:buyer:pre_approval_pending"
    && new Set(CLIENT_SYLLABUS.map(clientTag)).size === CLIENT_SYLLABUS.length)

  // KERNEL wiring — persistence writes the stage window; the composer matches buyer_stage from
  // the kernel's education context, so the KERNEL (not a hardcoded card) surfaces the lesson.
  const authoring = src("lib/education/client-education-authoring.ts")
  check("client authoring persists topic.stages as stage_tags (journey-window match)",
    /stage_tags: !isPersona \? \(topic\.stages \?\? \(topic\.milestone \? \[topic\.milestone\] : \[\]\)\) : \[\]/.test(authoring))
  const composer = src("lib/learning-router/composer.ts")
  check("learning-router composer feeds kernel context (buyer_stage + milestone + portal view) into the stage match",
    /resolveEducationContext/.test(composer) && /ctx\.buyerStage/.test(composer) && /ctx\.portalView/.test(composer))
}

function nudgeLayer() {
  console.log("\n[moment-of-truth nudges — loan checklist + offer brief, honest + linked to the lesson]")
  const action = src("app/actions/portal-loan-checklist.ts")
  check("loan-checklist action assesses letter strength off buyer_financial_profiles (verified/doc/amount/expiry)",
    /assessFinancingLetterStrength/.test(action)
    && /is_cash_buyer, verified, pre_approval_amount, pre_approval_letter_doc_id, pre_approval_expires_at/.test(action))
  check("nudge suppressed once clear-to-close (letter conversation is moot)", /if \(!clearToClose\) \{/.test(action))
  const card = src("app/portal/[contactId]/transaction/[transactionId]/loan-checklist-card.tsx")
  check("checklist card renders the nudge and links the pre-qual vs pre-approval lesson",
    /preApprovalNudge/.test(card) && /\/portal\/\$\{contactId\}\/learn/.test(card) && /Pre-qual vs pre-approval/.test(card))
  const producer = src("lib/agents/offer-strategy-producer.ts")
  check("offer-strategy brief reads the SAME buyer_financial_profiles row and notes letter weakness in the agent rationale",
    /assessFinancingLetterStrength/.test(producer)
    && /pre_approval_letter_doc_id/.test(producer)
    && /letterNote \? `\$\{baseRationale\} \$\{letterNote\}` : baseRationale/.test(producer))
}

function main() {
  pureLayer()
  educationLayer()
  nudgeLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ LETTER_STRENGTH_FAIL"); process.exit(1) }
  console.log(" ✅ LETTER_STRENGTH_PASS — pre-qual vs pre-approval trains agents AND buyers, and the moment-of-truth surfaces are honest")
}
main()

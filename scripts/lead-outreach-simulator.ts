#!/usr/bin/env tsx
/**
 * scripts/lead-outreach-simulator.ts   (npm run test:lead-outreach)
 * ─────────────────────────────────────────────────────────────────────────────
 * Locks two lead-outreach invariants:
 *
 *  1. CHANNEL POLICY — a pre-conversion (unconsented) LEAD is reachable ONLY by email
 *     (verified) or direct mail (mailing verified). SMS / phone / social are NEVER
 *     permitted — pickLeadOutreachChannel can never route a lead to them, whatever the
 *     requested channel.
 *  2. FIRST-TOUCH COPY — the first email is cohort-toned (them-first) + carries the
 *     brokerage brand tagline, and never contains protected-class / age language
 *     (Fair Housing). The compliance gate still runs downstream.
 */
import { pickLeadOutreachChannel } from "../lib/ai-isa/lead-channel-policy"
import { buildFirstTouchEmail } from "../lib/ai-isa/first-touch-copy"
import type { GenerationalCohort } from "../lib/kernel/education"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

function channelLayer(): void {
  console.log("\n[Channel policy — leads are STRICTLY email / direct_mail]")
  check("email verified ⇒ email", pickLeadOutreachChannel({ emailUsable: true, mailingVerified: false }) === "email")
  check("no email, mailing verified ⇒ direct_mail", pickLeadOutreachChannel({ emailUsable: false, mailingVerified: true }) === "direct_mail")
  check("neither verified ⇒ no_outreach", pickLeadOutreachChannel({ emailUsable: false, mailingVerified: false }) === "no_outreach")
  check("requested direct_mail + mailing verified ⇒ direct_mail", pickLeadOutreachChannel({ requestedChannel: "direct_mail", emailUsable: true, mailingVerified: true }) === "direct_mail")
  check("requested direct_mail + no mailing + email ⇒ email", pickLeadOutreachChannel({ requestedChannel: "direct_mail", emailUsable: true, mailingVerified: false }) === "email")

  // THE COMPLIANCE FLOOR: no requested channel ever yields sms/phone/social for a lead.
  const FORBIDDEN = new Set(["sms", "phone", "social", "facebook", "instagram", "linkedin", "voice", "call"])
  let allSafe = true
  for (const requested of ["sms", "phone", "facebook", "instagram", "linkedin", "social", "voice", "call", "whatsapp", "email", "direct_mail", null]) {
    for (const emailUsable of [true, false]) {
      for (const mailingVerified of [true, false]) {
        const r = pickLeadOutreachChannel({ requestedChannel: requested, emailUsable, mailingVerified })
        if (FORBIDDEN.has(r)) { allSafe = false; fails.push(`requested=${requested} → ${r} (forbidden for a lead!)`) }
        if (!["email", "direct_mail", "no_outreach"].includes(r)) { allSafe = false; fails.push(`requested=${requested} → ${r} (not a lead channel)`) }
      }
    }
  }
  check("NO requested channel (sms/phone/social/...) ever reaches a lead — email/direct_mail/none only", allSafe)
}

function copyLayer(): void {
  console.log("\n[First-touch copy — cohort-toned + brand-voiced, Fair-Housing safe]")
  const cohorts: GenerationalCohort[] = ["gen_z", "millennial", "gen_x", "boomer", "silent", "unknown"]
  const base = { firstName: "Sam", propertyInterest: "3-bed homes", timeline: "buy this spring", motivationType: "relocation_buyer", budgetMin: 400000, budgetMax: 550000, assistantName: "Ava", personaLabel: "Your AI concierge", brandTagline: "Where neighbors become family.", hasVideo: true }

  const bodies = cohorts.map((c) => buildFirstTouchEmail({ ...base, cohort: c }))
  check("every cohort produces a non-trivial body", bodies.every((b) => b.body.length > 80))
  check("opener tone differs across cohorts (gen_z vs boomer)",
    buildFirstTouchEmail({ ...base, cohort: "gen_z" }).body !== buildFirstTouchEmail({ ...base, cohort: "boomer" }).body)
  check("brand tagline is carried into the email", bodies.every((b) => b.body.includes("Where neighbors become family.")))
  check("assistant name signs off", bodies.every((b) => b.body.includes("Ava")))
  check("subject reflects the interest", bodies[0].subject.toLowerCase().includes("3-bed homes"))
  check("video placeholder present when hasVideo", buildFirstTouchEmail({ ...base, cohort: "millennial", hasVideo: true }).body.includes("[Video will be embedded here]"))
  check("no video placeholder when hasVideo=false", !buildFirstTouchEmail({ ...base, cohort: "millennial", hasVideo: false }).body.includes("[Video will be embedded here]"))

  // FAIR HOUSING — no protected-class / age language in any cohort's copy.
  const BANNED = ["race", "religion", "christian", "jewish", "muslim", "national origin", "ethnic", "disab", "handicap",
    "familial", "children", "kids", "married", "single mom", "elderly", "senior citizen", "young couple", "your age", "retiree"]
  let clean = true
  for (const c of cohorts) {
    const body = buildFirstTouchEmail({ ...base, cohort: c }).body.toLowerCase()
    const hit = BANNED.find((w) => body.includes(w))
    if (hit) { clean = false; fails.push(`cohort ${c} copy contains banned term "${hit}"`) }
  }
  check("no first-touch copy references a protected class or age", clean)
}

function main(): void {
  channelLayer()
  copyLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ LEAD_OUTREACH_FAIL"); process.exit(1) }
  console.log(" ✅ LEAD_OUTREACH_PASS — leads are email/direct-mail only; first touch is cohort-toned + brand-voiced + compliant")
}

main()

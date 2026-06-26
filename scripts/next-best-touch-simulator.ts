#!/usr/bin/env tsx
/**
 * scripts/next-best-touch-simulator.ts   (npm run test:next-best-touch)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE NEXT-BEST-TOUCH DECISION — the manager autonomously picks a contact's next channel by
 * (1) what they REPLY to, (2) AGE-GROUP psychology, (3) ROTATION off the last channel — all
 * within consent. Pure: every branch, no I/O.
 */
import { permittedContactChannels, permittedLeadChannels, ageGroupChannelAffinity, decideNextChannel } from "../lib/ai-isa/next-best-touch"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

const consented = { email: "c@x.com", phone: "+15125551234", tcpa_consent: true, mailing_address: "9 Oak" }

function main() {
  console.log("\n[Consent-permitted channels]")
  check("fully consented → email/newsletter/sms/phone/voicedrop/direct_mail (6)", permittedContactChannels(consented).length === 6)
  check("no TCPA → no voice/sms (email + newsletter + mail only)", !permittedContactChannels({ ...consented, tcpa_consent: false }).some((c) => ["sms", "phone", "voicedrop"].includes(c)))
  check("email opted out → email AND newsletter excluded (CAN-SPAM)", (() => { const p = permittedContactChannels({ ...consented, email_opt_out: true }); return !p.includes("email") && !p.includes("newsletter") })())
  check("newsletter permitted whenever email usable", permittedContactChannels(consented).includes("newsletter"))
  check("call_stop_flag → no phone/voicedrop, sms still ok", (() => { const p = permittedContactChannels({ ...consented, call_stop_flag: true }); return !p.includes("phone") && !p.includes("voicedrop") && p.includes("sms") })())
  check("no permitted channel when nothing consented/present", permittedContactChannels({}).length === 0)

  console.log("\n[LEAD channels — same engine, NO TCPA (email/direct_mail/newsletter only)]")
  const leadFull = permittedLeadChannels({ emailUsable: true, mailingVerified: true })
  check("lead with email + mailing → email/newsletter/direct_mail (3)", leadFull.length === 3)
  check("a LEAD never gets sms/phone/voicedrop (TCPA floor)", !leadFull.some((c) => ["sms", "phone", "voicedrop"].includes(c)))
  check("lead with no usable email → no email/newsletter", (() => { const p = permittedLeadChannels({ emailUsable: false, mailingVerified: true }); return !p.includes("email") && !p.includes("newsletter") && p.includes("direct_mail") })())
  check("lead with nothing verified → empty (no_outreach upstream)", permittedLeadChannels({ emailUsable: false, mailingVerified: false }).length === 0)
  // Leads run through the SAME decideNextChannel — cohort-aware rotation across the lead set.
  check("gen-z LEAD → email first (no sms permitted), within the lead set", decideNextChannel({ permitted: leadFull, cohort: "gen_z" }).channel === "email")
  check("LEAD rotates email→ another lead channel when email was last", decideNextChannel({ permitted: leadFull, cohort: "gen_z", lastChannel: "email" }).channel !== "email")

  console.log("\n[Newsletter — the late nurture/rotation pick (managers hand off to Campaign Orch.)]")
  check("newsletter sits LATE in every cohort's affinity (never first)", (["gen_z","millennial","gen_x","boomer","silent","unknown"] as const).every((co) => ageGroupChannelAffinity(co)[0] !== "newsletter" && ageGroupChannelAffinity(co).includes("newsletter")))
  // After the 1:1 channels were recently used, rotation reaches the newsletter as the downshift.
  check("contact rotates TO newsletter when its only alternative was last used",
    decideNextChannel({ permitted: ["email", "newsletter"], cohort: "gen_x", lastChannel: "email" }).channel === "newsletter")

  console.log("\n[Age-group psychology — how each generation wants to be reached]")
  check("gen-z leads with SMS (text-first, screens calls)", ageGroupChannelAffinity("gen_z")[0] === "sms")
  check("boomer leads with PHONE", ageGroupChannelAffinity("boomer")[0] === "phone")
  check("silent gen leads with phone, mail high", ageGroupChannelAffinity("silent")[0] === "phone" && ageGroupChannelAffinity("silent").includes("direct_mail"))
  check("gen-x leads with email", ageGroupChannelAffinity("gen_x")[0] === "email")

  console.log("\n[The decision — engagement → age → rotation, within consent]")
  const allFive = permittedContactChannels(consented)
  check("gen-z + no history → SMS (age affinity)", decideNextChannel({ permitted: allFive, cohort: "gen_z" }).channel === "sms")
  check("boomer + no history → phone", decideNextChannel({ permitted: allFive, cohort: "boomer" }).channel === "phone")
  check("LEARNED engagement beats age affinity", decideNextChannel({ permitted: allFive, cohort: "gen_z", learnedRanked: ["email"] }).channel === "email")
  check("ROTATION — won't repeat the last channel when an alternative exists",
    decideNextChannel({ permitted: allFive, cohort: "boomer", lastChannel: "phone" }).channel !== "phone")
  check("rotation reason is explained", /rotated off/.test(decideNextChannel({ permitted: allFive, cohort: "boomer", lastChannel: "phone" }).reason))
  check("consent floor — gen-z with NO voice consent never gets sms/phone", (() => { const p = permittedContactChannels({ ...consented, tcpa_consent: false }); const d = decideNextChannel({ permitted: p, cohort: "gen_z" }); return !["sms", "phone", "voicedrop"].includes(d.channel) })())
  check("only one permitted → that channel (no spurious rotation)", decideNextChannel({ permitted: ["email"], cohort: "gen_z", lastChannel: "email" }).channel === "email")
  check("nothing permitted → no_channel", decideNextChannel({ permitted: [], cohort: "unknown" }).channel === "no_channel")

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ NEXT_BEST_TOUCH_FAIL"); process.exit(1) }
  console.log(" ✅ NEXT_BEST_TOUCH_PASS — the manager autonomously picks the next channel by engagement + age + rotation, within consent")
}

main()

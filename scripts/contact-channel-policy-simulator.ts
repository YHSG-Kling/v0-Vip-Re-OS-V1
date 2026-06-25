#!/usr/bin/env tsx
/**
 * scripts/contact-channel-policy-simulator.ts   (npm run test:contact-channel)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CONTACT-SIDE VOICE TOOLBOX — proves the AI ISA can reach a CONVERTED, consented
 * contact by its FULL toolbox (outbound AI call + ringless voice drop + sms + email +
 * direct mail), not the email/sms/direct-mail-only matrix it had before. Pure: every
 * branch of resolveContactChannel + voiceReachable across preference × consent × opt-out.
 */
import { resolveContactChannel, voiceReachable } from "../lib/ai-isa/contact-channel-policy"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

const consented = { phone: "+15125551234", email: "c@example.com", tcpa_consent: true }

function main() {
  console.log("\n[Voice reachability — consent + a clean line]")
  check("consented + clean line → voice reachable", voiceReachable(consented) === true)
  check("no consent → NOT voice reachable", voiceReachable({ ...consented, tcpa_consent: false }) === false)
  check("phone opt-out → NOT voice reachable", voiceReachable({ ...consented, phone_opt_out: true }) === false)
  check("call_stop_flag → NOT voice reachable", voiceReachable({ ...consented, call_stop_flag: true }) === false)
  check("no phone → NOT voice reachable", voiceReachable({ ...consented, phone: null }) === false)

  console.log("\n[THE FIX — phone + voicedrop are real channels now (no longer fall through to email)]")
  check("prefers phone + consented → PHONE (the ISA calls)", resolveContactChannel({ ...consented, preferred_channel: "phone" }) === "phone")
  check("prefers phone + NO consent → email (honest downgrade)", resolveContactChannel({ ...consented, preferred_channel: "phone", tcpa_consent: false }) === "email")
  check("prefers phone + phone opt-out → email", resolveContactChannel({ ...consented, preferred_channel: "phone", phone_opt_out: true }) === "email")
  check("prefers voicedrop + consented → VOICEDROP (ringless voicemail)", resolveContactChannel({ ...consented, preferred_channel: "voicedrop" }) === "voicedrop")
  check("prefers voicedrop + NO consent → email", resolveContactChannel({ ...consented, preferred_channel: "voicedrop", tcpa_consent: false }) === "email")

  console.log("\n[The rest of the matrix still holds]")
  check("prefers sms + consented → sms", resolveContactChannel({ ...consented, preferred_channel: "sms" }) === "sms")
  check("prefers sms + no consent → email", resolveContactChannel({ ...consented, preferred_channel: "sms", tcpa_consent: false }) === "email")
  check("prefers sms + sms opt-out → email", resolveContactChannel({ ...consented, preferred_channel: "sms", sms_opt_out: true }) === "email")
  check("prefers email → email", resolveContactChannel({ ...consented, preferred_channel: "email" }) === "email")
  check("email opt-out + mailing addr → direct_mail", resolveContactChannel({ ...consented, preferred_channel: "email", email_opt_out: true, mailing_address: "9 Oak" }) === "direct_mail")
  check("email opt-out + NO mailing addr → email (no fabricated channel)", resolveContactChannel({ ...consented, preferred_channel: "email", email_opt_out: true }) === "email")
  check("prefers direct_mail + addr → direct_mail", resolveContactChannel({ ...consented, preferred_channel: "direct_mail", mailing_address: "9 Oak" }) === "direct_mail")
  check("prefers direct_mail + NO addr → email", resolveContactChannel({ ...consented, preferred_channel: "direct_mail" }) === "email")
  check("unknown preference → email (safe default)", resolveContactChannel({ ...consented, preferred_channel: "carrier_pigeon" }) === "email")

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ CONTACT_CHANNEL_FAIL"); process.exit(1) }
  console.log(" ✅ CONTACT_CHANNEL_PASS — the ISA's full voice toolbox (call + voicedrop) is reachable on consented contacts; consent gates hold")
}

main()

#!/usr/bin/env tsx
/**
 * scripts/audience-eligibility-simulator.ts  (npm run test:audience-eligibility) — pure, no DB.
 *
 * Proves the PII-SHARE gate (lib/ads/audience-eligibility.ts): a contact's email/phone is uploaded
 * to a Meta Custom Audience ONLY while the relationship is active AND they're still lawfully
 * marketable on some channel. Withdrawn or fully-opted-out contacts are excluded (CCPA do-not-share),
 * recomputed live at sync time — not trusted from the consent captured at conversion.
 */
import { isAudienceUploadEligible } from "../lib/ads/audience-eligibility"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}`) }
}

console.log("\n[PII-share eligibility — reuses the canonical canDispatchToContact gate]")
check("clean contact (email reachable) → ELIGIBLE",
  isAudienceUploadEligible({ tcpa_consent: true }) === true)
check("WITHDRAWN relationship → excluded (hard block)",
  isAudienceUploadEligible({ nurture_status: "withdrawn", tcpa_consent: true }) === false)
check("email opted out BUT sms-consented → still eligible (reachable via sms)",
  isAudienceUploadEligible({ email_opt_out: true, tcpa_consent: true }) === true)
check("email opted out AND no sms consent → excluded (no lawful marketing channel)",
  isAudienceUploadEligible({ email_opt_out: true, tcpa_consent: false }) === false)
check("email unsubscribed AND sms opted out (tcpa true) → excluded (both channels revoked)",
  isAudienceUploadEligible({ email_unsubscribed: true, sms_opt_out: true, tcpa_consent: true }) === false)
check("DNC (phone) but email reachable → eligible (DNC is voice/sms, email still open)",
  isAudienceUploadEligible({ dnc_status: true, tcpa_consent: true }) === true)
check("opt_out_channels ['email','sms'] (tcpa true) → excluded (every channel opted out)",
  isAudienceUploadEligible({ opt_out_channels: ["email", "sms"], tcpa_consent: true }) === false)
check("empty/unknown consent → eligible only via email (CAN-SPAM: email open until opt-out)",
  isAudienceUploadEligible({}) === true)

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
console.log(" ✅ AUDIENCE_ELIGIBILITY_PASS — opted-out / withdrawn contacts are never shared to ad platforms")

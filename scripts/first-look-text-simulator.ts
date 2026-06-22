#!/usr/bin/env tsx
/**
 * scripts/first-look-text-simulator.ts  (npm run test:first-look-text) — pure, no DB.
 *
 * Proves the consent gate for the agent "first-look text" (immediate SMS preview of a
 * listing to a buyer) — the inline gate that makes sendFirstLookText a compliant
 * `gated-inline` egress sender. No consumer SMS is ever sent without this returning null.
 */
import { firstLookConsentBlock } from "../lib/property-alerts/first-look-consent"

let pass = 0, fail = 0
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}`) } }

console.log("\n[first-look consent gate · pure]")
check("clear, opted-in buyer with a phone → allowed", firstLookConsentBlock({ phone: "+15125550101", dnc_status: false, sms_opt_out: false }) === null)
check("no phone → no_phone_on_file (reported before consent)", firstLookConsentBlock({ phone: null, dnc_status: false }) === "no_phone_on_file")
check("DNC boolean blocks", firstLookConsentBlock({ phone: "+15125550101", dnc_status: true }) === "consent_blocked")
check("DNC status string blocks", firstLookConsentBlock({ phone: "+15125550101", dnc_status: "listed" }) === "consent_blocked")
check("SMS opt-out blocks", firstLookConsentBlock({ phone: "+15125550101", sms_opt_out: true }) === "consent_blocked")
check("dnc_status 'clear' does NOT block", firstLookConsentBlock({ phone: "+15125550101", dnc_status: "clear" }) === null)
check("empty dnc string does NOT block", firstLookConsentBlock({ phone: "+15125550101", dnc_status: "" }) === null)
check("missing phone beats a clear consent", firstLookConsentBlock({ phone: "", dnc_status: false, sms_opt_out: false }) === "no_phone_on_file")

console.log("\n──────────────────────────────────────────────────")
if (fail > 0) { console.log(` RESULT: ${pass} passed, ${fail} failed`); process.exit(1) }
console.log(` RESULT: ${pass} passed, 0 failed`)
console.log(" ✅ FIRST_LOOK_CONSENT_PASS — no first-look SMS reaches a consumer without the inline gate clearing")

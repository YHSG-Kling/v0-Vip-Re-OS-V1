#!/usr/bin/env tsx
/**
 * scripts/data-guard-simulator.ts  (npm run test:data-guard) — pure, no DB / no model spend.
 *
 * Proves the DATA GUARD's classification + redaction: high-confidence secrets (SSN/ITIN, EIN, card
 * PAN, bank account/routing) are stripped from text before it could reach a model, while normal
 * real-estate working data (names, addresses, prices, phones) is left untouched (zero functional
 * loss). Idempotent on already-redacted text.
 */
import { redactSensitive, classifySensitive, hasSensitive, placeholderFor } from "../lib/data-guard"

let pass = 0, fail = 0
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}`) } }

console.log("\n[redaction · pure — strip the secrets the AI never needs]")
check("SSN is redacted", redactSensitive("Buyer SSN 123-45-6789 on file").text === "Buyer SSN [REDACTED:SSN] on file")
check("EIN is redacted", redactSensitive("EIN 12-3456789 for the LLC").text === "EIN [REDACTED:EIN] for the LLC")
check("16-digit card is redacted (grouped)", redactSensitive("card 4111 1111 1111 1111 charged").text === "card [REDACTED:CARD] charged")
check("16-digit card is redacted (solid)", redactSensitive("4111111111111111").text === "[REDACTED:CARD]")
check("15-digit Amex is redacted", redactSensitive("Amex 3782 822463 10005").text === "Amex [REDACTED:CARD]")
check("labeled bank account keeps the label, redacts the digits",
  redactSensitive("account number 000123456789").text === "account number [REDACTED:BANK]")
check("routing number is redacted", redactSensitive("routing 021000021 please").text === "routing [REDACTED:BANK] please")

console.log("\n[no over-redaction · pure — keep normal real-estate working data]")
check("a name is untouched", redactSensitive("James Carter wants to see the home").text === "James Carter wants to see the home")
check("an address is untouched", redactSensitive("123 Oak Park Ave, Austin TX 78704").text === "123 Oak Park Ave, Austin TX 78704")
check("a price is untouched", redactSensitive("listed at $480,000 with 2,100 sqft").text === "listed at $480,000 with 2,100 sqft")
check("a phone number is untouched (the AI needs it for context)", redactSensitive("call (512) 555-0142 today").text === "call (512) 555-0142 today")
check("a 9-digit ZIP+4-ish run without dashes/labels is untouched", redactSensitive("parcel 540123456 area").text === "parcel 540123456 area")

console.log("\n[classification + helpers · pure]")
check("classifySensitive finds the SSN + card", classifySensitive("ssn 123-45-6789 card 4111111111111111").length === 2)
check("hasSensitive true on a secret", hasSensitive("SSN 123-45-6789"))
check("hasSensitive false on clean text", !hasSensitive("3-bed in Austin under $500k"))
check("placeholderFor is typed", placeholderFor("ssn") === "[REDACTED:SSN]")

console.log("\n[idempotent + multi · pure]")
const once = redactSensitive("ssn 123-45-6789 and card 4111 1111 1111 1111").text
check("redacts multiple secrets in one pass", once === "ssn [REDACTED:SSN] and card [REDACTED:CARD]")
check("running redaction again is a no-op (idempotent)", redactSensitive(once).text === once && redactSensitive(once).redactedCount === 0)
check("redactedCount reports the number stripped", redactSensitive("ssn 123-45-6789 ein 12-3456789").redactedCount === 2)
check("empty / null input is safe", redactSensitive(null).text === "" && redactSensitive(undefined).redactedCount === 0)

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ DATA_GUARD_REDACTION_FAIL"); process.exit(1) }
console.log(" ✅ DATA_GUARD_REDACTION_PASS — secrets stripped, working data preserved")

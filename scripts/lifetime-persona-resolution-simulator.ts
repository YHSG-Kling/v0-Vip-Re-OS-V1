#!/usr/bin/env tsx
/**
 * scripts/lifetime-persona-resolution-simulator.ts   (npm run test:lifetime-persona)
 * ─────────────────────────────────────────────────────────────────────────────
 * Guards the migration-433 drift fix: the canonical past-client contact_type is 'lifetime_customer', and
 * every persona resolver must map it to the LIFETIME lane — so a past client in the continuous situational
 * nurture gets the lifetime/anniversary reel (+ lifetime portal message + past-client voicemail), NOT the
 * default buyer 'explainer'. Pure: no I/O.
 */
import { isLifetimeCustomerType, LIFETIME_CUSTOMER_TYPE } from "../lib/contact-types"
import { contactReelPersona, situationKindForContact } from "../lib/ai-isa/contact-reel-situation"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

function main() {
  console.log("\n[isLifetimeCustomerType — canonical + legacy]")
  check("the canonical constant is 'lifetime_customer'", LIFETIME_CUSTOMER_TYPE === "lifetime_customer")
  check("'lifetime_customer' → true (canonical)", isLifetimeCustomerType("lifetime_customer") === true)
  check("'lifetime' → true (legacy)", isLifetimeCustomerType("lifetime") === true)
  check("'past_client' → true (legacy)", isLifetimeCustomerType("past_client") === true)
  check("'buyer' → false", isLifetimeCustomerType("buyer") === false)
  check("'seller' → false", isLifetimeCustomerType("seller") === false)
  check("null → false", isLifetimeCustomerType(null) === false)

  console.log("\n[the reel chain: contact_type → persona → Director kind]")
  check("lifetime_customer → persona 'lifetime' (was 'buyer' — the bug)", contactReelPersona("lifetime_customer") === "lifetime")
  check("lifetime_customer reel kind → 'anniversary' (not buyer 'explainer')", situationKindForContact(contactReelPersona("lifetime_customer")) === "anniversary")
  check("buyer still → explainer", situationKindForContact(contactReelPersona("buyer")) === "explainer")
  check("seller still → cma", situationKindForContact(contactReelPersona("seller")) === "cma")
  check("both still → market_update", situationKindForContact(contactReelPersona("both")) === "market_update")

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ LIFETIME_PERSONA_FAIL"); process.exit(1) }
  console.log(" ✅ LIFETIME_PERSONA_PASS — past clients resolve to the lifetime lane (right reel/voicemail/portal)")
}
main()

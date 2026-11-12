#!/usr/bin/env tsx
/**
 * scripts/offer-property-prefill-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves OFFER PROPERTY PREFILL — the offer form is filled by the AGENT; the system only pre-fills
 * KNOWN property identification (address, legal description, property city/state/zip, APN, county)
 * and leaves unknown property fields BLANK. Offer-TERM fields (price, earnest money, contingencies,
 * dates) are NEVER touched. Grounded only — no AI fabrication.
 *
 * Layer 0 (static, stripped source): lib/intelligence/offer-property-prefill-runner.ts::
 * prefillOfferFormProperty (resolve+map combinator) is not a duplicate of any of its three
 * documented siblings — each needs a step BETWEEN resolve and map that the combinator alone can't
 * do — so it was WIRED (wave 46 lane EC) rather than deleted: app/actions/buyer-offer/prefill-offer.ts
 * ::resolveOfferPropertyPrefillAction calls it directly, and app/components/form-wizard/FormWizard.tsx
 * calls THAT for the "my forms" entries that aren't a fillable PDF (prefillStorageFormAction only
 * ever ran on `.pdf` refs, so those got no property prefill preview at all before this). Asserts the
 * RULE (imports + calls the real functions), not a byte offset.
 *
 * Layer 1 (shell, pure): the field mapping — known property fact fills its field; unknown → blank;
 * offer-term fields untouched; bare city/state never mis-filled. Layer 2 (live, creds-gated): resolve
 * KNOWN facts from a real seeded listing → build the prefill → assert only property fields filled,
 * legal description blank (unknown), terms untouched → clean up.
 *
 * Run: npx tsx scripts/offer-property-prefill-simulator.ts   (npm run test:offer-property-prefill)
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { buildPropertyPrefill } from "../lib/intelligence/offer-property-prefill"
import { blankComments } from "./strip-comments"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function report() {
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Offer property prefill verified — only KNOWN property info filled; terms left to the agent.")
  console.log(" OFFER_PROPERTY_PREFILL_PASS")
  process.exit(0)
}

const OFFER_FORM_FIELDS = [
  "Property Address", "Legal Description", "Property County", "Property City", "Property State", "Property Zip", "APN",
  // offer-term fields the AGENT fills — must NEVER be auto-filled:
  "Offer Price", "Earnest Money", "Down Payment", "Financing Type", "Closing Date", "Inspection Period",
  // a bare buyer field — must not be mis-filled with the property's:
  "Buyer City",
]

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Offer property prefill simulator")
  console.log("══════════════════════════════════════════════════\n")

  console.log("[Layer 0 · the combinator is WIRED, not orphaned — rule, not a byte offset]")
  const runnerSrc = blankComments(readFileSync(resolve(process.cwd(), "lib/intelligence/offer-property-prefill-runner.ts"), "utf8"))
  const actionSrc = blankComments(readFileSync(resolve(process.cwd(), "app/actions/buyer-offer/prefill-offer.ts"), "utf8"))
  const wizardSrc = blankComments(readFileSync(resolve(process.cwd(), "app/components/form-wizard/FormWizard.tsx"), "utf8"))

  check("prefillOfferFormProperty is still exported (the wire did not delete the combinator)",
    /export\s+async\s+function\s+prefillOfferFormProperty\b/.test(runnerSrc))
  check("resolveOfferPropertyPrefillAction exists as a real async server action",
    /export\s+async\s+function\s+resolveOfferPropertyPrefillAction\b/.test(actionSrc))
  check("resolveOfferPropertyPrefillAction actually CALLS prefillOfferFormProperty (not a stub)",
    /prefillOfferFormProperty\s*\(/.test(actionSrc) &&
    /import\s*\{[^}]*\bprefillOfferFormProperty\b[^}]*\}\s*from\s*["']@\/lib\/intelligence\/offer-property-prefill-runner["']/.test(actionSrc))
  check("FormWizard imports resolveOfferPropertyPrefillAction from the buyer-offer action module",
    /import\s*\{[^}]*\bresolveOfferPropertyPrefillAction\b[^}]*\}\s*from\s*["']@\/app\/actions\/buyer-offer\/prefill-offer["']/.test(wizardSrc))
  check("FormWizard actually CALLS resolveOfferPropertyPrefillAction (not just imports it)",
    /resolveOfferPropertyPrefillAction\s*\(/.test(wizardSrc))
  // POSITIVE CONTROL (§2): the "actually CALLS" checkers above must be ABLE to
  // fail, or a vacuous regex proves nothing. A synthetic pre-wire snippet —
  // an import with NO call site, exactly the "counted as a reference but never
  // invoked" shape orphan-export-guard is built to catch — run through the
  // SAME call-site pattern the real checks use, must come back false.
  const unusedImportOnly = blankComments(
    `import { resolveOfferPropertyPrefillAction } from "@/app/actions/buyer-offer/prefill-offer"\nfunction unrelated() { return 1 }`,
  )
  check("control · the call-site pattern correctly finds NO invocation in an import-only snippet",
    !/resolveOfferPropertyPrefillAction\s*\(/.test(unusedImportOnly))
  const wiredSnippet = blankComments(
    `import { resolveOfferPropertyPrefillAction } from "@/app/actions/buyer-offer/prefill-offer"\nresolveOfferPropertyPrefillAction({ listingId })`,
  )
  check("control · the SAME pattern correctly finds the invocation once one exists",
    /resolveOfferPropertyPrefillAction\s*\(/.test(wiredSnippet))

  console.log("\n[Layer 1 · field mapping]")
  const r = buildPropertyPrefill(OFFER_FORM_FIELDS, {
    address: "742 Evergreen Ter", legalDescription: "LOT 4 BLK 2 SPRINGFIELD ADD", county: "Hampden",
    propertyCity: "Springfield", propertyState: "MA", propertyZip: "01103", apn: "123-456-789",
  })
  const filledFields = r.filled.map((f) => f.formField)
  check("known property ADDRESS fills the address field", r.filled.some((f) => f.formField === "Property Address" && f.value === "742 Evergreen Ter"))
  check("known LEGAL DESCRIPTION fills its field", r.filled.some((f) => f.formField === "Legal Description" && /LOT 4 BLK 2/.test(f.value)))
  check("property city/state/zip/apn/county fill (property-qualified)", ["Property County", "Property City", "Property State", "Property Zip", "APN"].every((f) => filledFields.includes(f)))
  check("OFFER-TERM fields are NEVER touched (agent fills)", !["Offer Price", "Earnest Money", "Down Payment", "Financing Type", "Closing Date", "Inspection Period"].some((f) => filledFields.includes(f)) && !r.unresolved.includes("Offer Price"))
  check("a bare 'Buyer City' is NOT mis-filled with the property's city", !filledFields.includes("Buyer City"))

  // Unknown property facts → left BLANK (unresolved), never fabricated.
  const partial = buildPropertyPrefill(OFFER_FORM_FIELDS, { address: "742 Evergreen Ter" /* legal description unknown */ })
  check("unknown legal description → blank (unresolved), not fabricated", partial.unresolved.includes("Legal Description") && !partial.filled.some((f) => f.formField === "Legal Description"))
  check("with no known facts → nothing filled, all recognized property fields blank", buildPropertyPrefill(OFFER_FORM_FIELDS, {}).filled.length === 0)

  console.log("\n[Layer 2 · live: resolve KNOWN facts from a real listing → prefill]")
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) { console.log("  ⏭  Skipped — SUPABASE creds not set (Layer 1 ran)."); return report() }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { prefillOfferFormProperty } = await import("../lib/intelligence/offer-property-prefill-runner")
  const svc = createServiceClient()
  const { data: brokerage } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brokerage) { console.log("  ⏭  Skipped — need a real brokerage."); return report() }
  const brokerageId = (brokerage as any).id
  const cleanup: Array<{ table: string; id: string }> = []
  try {
    const { data: listing } = await svc.from("listings").insert({
      brokerage_id: brokerageId, address: "9 Birch St", city: "Austin", state: "TX", zip: "78701", status: "active",
    }).select("id").single()
    const listingId = (listing as any)?.id
    if (listingId) cleanup.push({ table: "listings", id: listingId })

    const result = await prefillOfferFormProperty(OFFER_FORM_FIELDS, { listingId }, svc)
    check("resolved the listing ADDRESS into the form (grounded)", result.filled.some((f) => f.formField === "Property Address" && f.value === "9 Birch St"), JSON.stringify(result.filled))
    check("property city/state/zip resolved from the listing", result.filled.some((f) => f.formField === "Property City" && f.value === "Austin") && result.filled.some((f) => f.formField === "Property State" && f.value === "TX"))
    check("LEGAL DESCRIPTION stays BLANK (not stored anywhere → honestly unknown)", result.unresolved.includes("Legal Description") && !result.filled.some((f) => f.formField === "Legal Description"))
    check("offer terms remain untouched on the live path", !result.filled.some((f) => /price|earnest|financing|closing|inspection/i.test(f.formField)))
  } finally {
    for (const c of [...cleanup].reverse()) await svc.from(c.table).delete().eq("id", c.id).then(() => {}, () => {})
    if (cleanup[0]) { const { count } = await svc.from("listings").select("id", { count: "exact", head: true }).eq("id", cleanup[0].id); check("cleanup: seed listing removed (count == 0)", (count ?? 0) === 0) }
  }
  report()
}

main().catch((e) => { console.error(e); process.exit(1) })

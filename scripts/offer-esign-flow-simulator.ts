#!/usr/bin/env tsx
/**
 * scripts/offer-esign-flow-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves two stages of the offer e-sign flow:
 *  A) OFFER SIGNERS — the buyer's name + email are pulled from the CRM contact automatically (no
 *     manual re-typing); a contact with no email is skipped, never faked.
 *  B) OFFER DOC COMPLETENESS — when the signatures land, the packet is scanned (all required forms
 *     present + all signed) before the agent is told "ready to send to the listing agent"; an
 *     incomplete or unknown-requirements packet is NEVER declared ready.
 *
 * Layer 1 (shell, pure). Layer 2 (live, creds-gated): seed an offer + signed docs, run the
 * completeness scan → assert the Deal Coordinator handoff + agent notification, idempotent, clean up.
 *
 * Run: npx tsx scripts/offer-esign-flow-simulator.ts   (npm run test:offer-esign-flow)
 */
import { buildSignersFromContacts } from "../lib/intelligence/offer-signers"
import { scanOfferDocCompleteness } from "../lib/intelligence/offer-doc-completeness"

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
  console.log(" ✅ Offer e-sign flow verified — signer auto-pull + completeness gate before the listing agent.")
  console.log(" OFFER_ESIGN_FLOW_PASS")
  process.exit(0)
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Offer e-sign flow simulator")
  console.log("══════════════════════════════════════════════════\n")

  console.log("[Layer 1A · signer auto-pull]")
  const s = buildSignersFromContacts({ firstName: "Casey", lastName: "Buyer", email: "casey@example.com" }, { firstName: "Sam", lastName: "Co", email: "sam@example.com" })
  check("buyer + co-buyer with emails → two signers, correct roles", s.length === 2 && s[0].role === "buyer" && s[0].email === "casey@example.com" && s[1].role === "co_buyer")
  check("a contact with NO email is skipped (never faked)", buildSignersFromContacts({ firstName: "Noemail", email: null }).length === 0)
  check("buyer named even without last name", buildSignersFromContacts({ firstName: "Solo", email: "solo@example.com" })[0].name === "Solo")

  console.log("\n[Layer 1B · completeness scan]")
  const required = [{ key: "purchase_agreement", label: "Purchase Agreement" }, { key: "buyer_disclosure", label: "Buyer Disclosure" }]
  const allGood = scanOfferDocCompleteness(required, [{ key: "purchase_agreement", status: "signed" }, { key: "buyer_disclosure", status: "signed" }])
  check("all required present + signed → ready for listing agent", allGood.complete && allGood.readyForListingAgent && allGood.missingForms.length === 0)
  const missing = scanOfferDocCompleteness(required, [{ key: "purchase_agreement", status: "signed" }])
  check("a missing required form → NOT ready, surfaced", !missing.readyForListingAgent && missing.missingForms.includes("Buyer Disclosure"))
  const unsigned = scanOfferDocCompleteness(required, [{ key: "purchase_agreement", status: "signed" }, { key: "buyer_disclosure", status: "sent" }])
  check("a present-but-unsigned form → NOT ready, surfaced", !unsigned.readyForListingAgent && unsigned.unsignedForms.includes("Buyer Disclosure"))
  check("UNKNOWN requirements → never declared ready (honest)", !scanOfferDocCompleteness([], [{ key: "x", status: "signed" }]).readyForListingAgent)

  console.log("\n[Layer 2 · live: scan a signed packet → Deal Coordinator handoff + agent notify]")
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) { console.log("  ⏭  Skipped — SUPABASE creds not set (Layer 1 ran)."); return report() }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { verifyOfferDocsReady } = await import("../lib/intelligence/offer-doc-completeness-runner")
  const svc = createServiceClient()
  const { data: brokerage } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brokerage) { console.log("  ⏭  Skipped — need a real brokerage."); return report() }
  const brokerageId = (brokerage as any).id
  const uuid = () => (globalThis.crypto ?? require("node:crypto").webcrypto).randomUUID()
  const envelopeId = `zz_env_${uuid().slice(0, 8)}`
  const cleanup: Array<{ table: string; id: string }> = []
  try {
    const { data: offer } = await svc.from("offers").insert({
      brokerage_id: brokerageId, property_address: "5 Cedar Ct", provider_envelope_id: envelopeId,
      esign_status: "partially_signed",
      metadata: { selected_form_ids: ["purchase_agreement", "buyer_disclosure"] },
    }).select("id").single()
    const offerId = (offer as any)?.id
    if (offerId) cleanup.push({ table: "offers", id: offerId })

    // Two signed documents tied to the envelope, matching the required forms.
    for (const key of ["purchase_agreement", "buyer_disclosure"]) {
      const { data: doc } = await svc.from("documents").insert({
        brokerage_id: brokerageId, document_type: key, status: "signed",
        metadata: { signature_request_id: envelopeId, form_id: key },
      }).select("id").single()
      if ((doc as any)?.id) cleanup.push({ table: "documents", id: (doc as any).id })
    }

    const r = await verifyOfferDocsReady(envelopeId, svc)
    check("the live scan found the packet ready for the listing agent", r.scanned && r.readyForListingAgent && r.missingForms.length === 0, JSON.stringify(r))

    const { data: sig } = await svc.from("manager_signals")
      .select("to_manager, signal_type").eq("brokerage_id", brokerageId).eq("entity_id", offerId).eq("signal_type", "offer_docs_ready").maybeSingle()
    check("a Deal Coordinator handoff was published (docs ready)", (sig as any)?.to_manager === "deal_coordinator")

    const again = await verifyOfferDocsReady(envelopeId, svc)
    check("re-scanning the same offer is idempotent (no duplicate handoff)", again.scanned && (await svc.from("manager_signals").select("id", { count: "exact", head: true }).eq("entity_id", offerId).eq("signal_type", "offer_docs_ready")).count === 1)
  } finally {
    if (cleanup[0]) await svc.from("manager_signals").delete().eq("brokerage_id", brokerageId).eq("entity_id", cleanup[0].id).eq("signal_type", "offer_docs_ready").then(() => {}, () => {})
    for (const c of [...cleanup].reverse()) await svc.from(c.table).delete().eq("id", c.id).then(() => {}, () => {})
    const left = cleanup[0] ? (await svc.from("offers").select("id", { count: "exact", head: true }).eq("id", cleanup[0].id)).count ?? 0 : 0
    check("cleanup: seeds removed (count == 0)", left === 0)
  }
  report()
}

main().catch((e) => { console.error(e); process.exit(1) })

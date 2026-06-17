#!/usr/bin/env tsx
/**
 * scripts/esign-anchor-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the PROVIDER-AGNOSTIC E-SIGN ANCHOR layer — "tag once, sign on any provider":
 *  · deriveEsignAnchors maps a form's field names to canonical anchors (role+type), and REFUSES to
 *    auto-assign a field that names no party or two parties (ambiguous → manual placement).
 *  · the per-provider adapters translate the canonical anchors to each provider's native tag shape
 *    (Dotloop, DocuSign, SkySlope, Authentisign) with the right recipient-role naming.
 *  · evalAnchorPlacement proves a signature can never reach the wrong party; evalAnchorExecution
 *    proves a tagged form must be signed before "complete" (the tagged → signed → verified close).
 *  · buildEsignAnchorPlan runs the whole thing against a REAL PDF (pdf-lib, Node — fully headless).
 *
 * Run: npx tsx scripts/esign-anchor-simulator.ts   (npm run test:esign-anchors)
 */
import { PDFDocument } from "pdf-lib"
import { deriveEsignAnchors } from "../lib/forms/esign-anchors"
import { anchorsForProvider, recipientRolesForProvider, docusignTabsByRecipient, type EsignProvider } from "../lib/forms/esign-anchor-adapters"
import { evalAnchorPlacement, evalAnchorExecution } from "../lib/forms/esign-anchor-eval"
import { buildEsignAnchorPlan } from "../lib/forms/esign-anchor-plan"

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
  console.log(" ✅ E-sign anchors verified — tag once, sign on any provider; never the wrong party's line.")
  console.log(" ESIGN_ANCHORS_PASS")
  process.exit(0)
}

async function makeSignablePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  const form = doc.getForm()
  // A realistic mix: clean role+type fields, a data field, and two ambiguous fields.
  const names = ["Buyer Signature", "Buyer Initials", "Seller Signature", "Listing Agent Signature", "Buyer Signature Date", "Offer Price", "Signature", "Buyer and Seller Signature"]
  let y = 740
  for (const n of names) { const tf = form.createTextField(n); tf.addToPage(page, { x: 200, y, width: 340, height: 16 }); y -= 24 }
  return doc.save()
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" E-sign anchor simulator")
  console.log("══════════════════════════════════════════════════\n")

  console.log("[derivation — role+type, ambiguous refused]")
  const d = deriveEsignAnchors(["Buyer Signature", "Buyer Initials", "Seller Signature", "Offer Price", "Signature", "Buyer and Seller Signature"])
  check("buyer signature + initial + seller signature derived (clean)", d.anchors.some(a => a.role === "buyer" && a.type === "signature") && d.anchors.some(a => a.role === "buyer" && a.type === "initial") && d.anchors.some(a => a.role === "seller" && a.type === "signature"))
  check("a data field (Offer Price) is NOT an anchor", !d.anchors.some(a => a.fieldName === "Offer Price"))
  check("a party-less 'Signature' is AMBIGUOUS (manual placement)", d.ambiguous.some(a => a.fieldName === "Signature" && a.matchedRoles.length === 0))
  check("a two-party 'Buyer and Seller Signature' is AMBIGUOUS (never auto-assigned)", d.ambiguous.some(a => a.fieldName === "Buyer and Seller Signature" && a.matchedRoles.length >= 2))
  check("co-buyer beats base buyer (specificity)", deriveEsignAnchors(["Co-Buyer Signature"]).anchors[0]?.role === "co_buyer")
  check("listing agent beats base agent", deriveEsignAnchors(["Listing Agent Signature"]).anchors[0]?.role === "listing_agent")

  console.log("\n[per-provider adapters — native tags + recipient roles]")
  for (const p of ["dotloop", "docusign", "skyslope", "authentisign"] as EsignProvider[]) {
    const tags = anchorsForProvider(p, d.anchors)
    check(`${p}: every anchor → a native tag with a recipient role`, tags.length === d.anchors.length && tags.every(t => !!t.recipientRole && !!t.tab))
  }
  check("docusign uses signHere anchor tabs", anchorsForProvider("docusign", d.anchors).some(t => (t.tab as any).tabType === "signHere" && (t.tab as any).anchorString === "Buyer Signature"))
  check("dotloop maps buyer → BUYER participant role", recipientRolesForProvider("dotloop", d.anchors).includes("BUYER"))

  console.log("\n[provider send — tags flow to the recipient payload]")
  const dsTags = anchorsForProvider("docusign", d.anchors)
  check("docusign tags are SignatureTag-shaped (anchorKey/role/type/recipientRole/tab)", dsTags.every(t => !!t.anchorKey && !!t.role && !!t.type && !!t.recipientRole && !!t.tab))
  const grouped = docusignTabsByRecipient(dsTags)
  check("docusign tabs group per recipient into signHereTabs/initialHereTabs", !!grouped["Buyer"]?.signHereTabs && (grouped["Buyer"].signHereTabs as unknown[]).length >= 1 && !!grouped["Buyer"]?.initialHereTabs)
  check("a buyer's tabs never land under the seller recipient", !((grouped["Seller"]?.signHereTabs as unknown[] | undefined)?.some((t: any) => /buyer/i.test(String(t.anchorString)))))

  console.log("\n[placement safety eval — wrong party impossible]")
  check("clean anchors pass placement safety", evalAnchorPlacement(d).ok)
  // A deliberately corrupted anchor (role doesn't match the field) must be caught.
  const corrupt = { anchors: [{ role: "seller" as const, type: "signature" as const, key: "x", fieldName: "Buyer Signature" }], ambiguous: [] }
  check("a mis-assigned anchor (seller role on a Buyer field) is CAUGHT", !evalAnchorPlacement(corrupt).ok)

  console.log("\n[execution eval — tagged → signed → verified]")
  const exec = evalAnchorExecution([
    { formKey: "purchase_agreement", anchorCount: 3, signed: true },
    { formKey: "disclosure", anchorCount: 2, signed: false }, // tagged but not signed
    { formKey: "info_sheet", anchorCount: 0, signed: false },  // no signature needed — fine
  ])
  check("a tagged-but-unsigned form blocks completion", !exec.allExecuted && exec.incomplete.includes("disclosure") && !exec.incomplete.includes("info_sheet"))
  check("all tagged forms signed → executed", evalAnchorExecution([{ formKey: "pa", anchorCount: 2, signed: true }]).allExecuted)

  console.log("\n[end-to-end plan against a REAL PDF]")
  const pdf = await makeSignablePdf()
  const plan = await buildEsignAnchorPlan(pdf, "docusign")
  check("plan derived anchors from the real PDF fields", plan.anchors.length >= 4 && plan.tags.length === plan.anchors.length)
  check("plan flags the ambiguous fields for manual placement", plan.needsManualPlacement && plan.ambiguous.length === 2)
  check("plan placement-safety passes (no wrong-party risk)", plan.safety.ok)
  check("plan lists the signer roles required", plan.roles.includes("buyer") && plan.roles.includes("seller") && plan.roles.includes("listing_agent"))

  report()
}

main().catch((e) => { console.error(e); process.exit(1) })

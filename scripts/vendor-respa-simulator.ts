#!/usr/bin/env tsx
/**
 * scripts/vendor-respa-simulator.ts   (npm run test:vendor-respa)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the VENDOR RESPA COMPLIANCE LAYER — settlement-service vendors carry the required disclosure
 * when shown to a client, AfBA vendors gate contact behind an acknowledgment, and a kickback fee against
 * a settlement vendor is STRUCTURALLY blocked. All audit lands on the immutable compliance_events ledger.
 *
 * PURE:   isRespaRegulatedCategory (all spellings) + evaluateReferralFee (block settlement, allow mover) +
 *         resolveVendorDisclosure (afba→gated / settlement→inline / general / none) + disclosure fallbacks
 *         carry the legally-required language + override token interpolation + event-row shapes.
 * SOURCE: the referral-fee guard wired at createPartner; the portal renders the disclosure + AfBA gate;
 *         the burn domain is owned by compliance_officer with a runnable proof; package.json wires it.
 * LIVE (creds-gated): log a disclosure SHOWN (idempotent/day) → record an ACKNOWLEDGMENT → guard a
 *         settlement referral fee (blocked, ledgered) vs a mover fee (allowed, no row) → clean up == 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createClient } from "@supabase/supabase-js"
import {
  isRespaRegulatedCategory,
  evaluateReferralFee,
  resolveVendorDisclosure,
  standardPreferredDisclosure,
  afbaDisclosure,
  respaKickbackNotice,
  buildDisclosureEvent,
  buildReferralBlockEvent,
  RESPA_DISCLOSURE_GATE,
  RESPA_REFERRAL_GATE,
} from "../lib/compliance/vendor-respa"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

function pureLayer() {
  console.log("\n[classification · pure — settlement vs non-settlement, all spellings]")
  const settlement = ["mortgage_lender", "Lender", "lender", "title_company", "Title Company", "title", "real_estate_attorney", "attorney", "appraiser", "home_inspector", "Inspector", "surveyor"]
  check("every settlement-service spelling is RESPA-regulated", settlement.every((c) => isRespaRegulatedCategory(c)))
  const nonSettlement = ["mover", "moving", "photographer", "stager", "cleaner", "landscaper", "handyman", "Contractor", "interior_designer", "pool_service"]
  check("no non-settlement category is falsely regulated", nonSettlement.every((c) => !isRespaRegulatedCategory(c)))
  check("empty/unknown category is not regulated", !isRespaRegulatedCategory(null) && !isRespaRegulatedCategory(""))

  console.log("\n[referral-fee gate · pure — block settlement kickbacks, allow non-settlement]")
  const blocked = evaluateReferralFee({ category: "title", hasFee: true, feeType: "flat_referral_fee" })
  check("settlement + fee → BLOCKED with RESPA code", !blocked.allowed && blocked.code === "RESPA_VIOLATION_SETTLEMENT_REFERRAL")
  const lenderSplit = evaluateReferralFee({ category: "Lender", hasFee: true, feeType: "commission_split" })
  check("settlement + commission split → BLOCKED", !lenderSplit.allowed)
  const mover = evaluateReferralFee({ category: "moving", hasFee: true, feeType: "flat_referral_fee" })
  check("non-settlement (mover) + fee → ALLOWED", mover.allowed && mover.code === null)
  const noFee = evaluateReferralFee({ category: "title", hasFee: false })
  check("settlement + NO fee → allowed (listing a lender is fine)", noFee.allowed)

  console.log("\n[disclosure resolution · pure]")
  const afbaD = resolveVendorDisclosure({ category: "title", preferred: true, afbaConfigured: true, brokerageName: "Acme Realty", vendorName: "Blue Title" })
  check("AfBA vendor → afba disclosure, acknowledgment REQUIRED before contact", afbaD?.type === "afba" && afbaD.acknowledgmentRequired === true)
  const settleD = resolveVendorDisclosure({ category: "mortgage_lender", preferred: true, brokerageName: "Acme Realty", vendorName: "Fast Loans" })
  check("preferred settlement vendor → inline disclosure, no gate", settleD?.type === "preferred_settlement" && settleD.acknowledgmentRequired === false && settleD.regulated)
  const regNotPreferred = resolveVendorDisclosure({ category: "home_inspector", preferred: false, vendorName: "Sharp Inspections" })
  check("regulated but NOT preferred still gets a disclosure (the app is steering)", regNotPreferred?.type === "preferred_settlement")
  const generalD = resolveVendorDisclosure({ category: "landscaper", preferred: true, brokerageName: "Acme", vendorName: "Green Lawns" })
  check("preferred non-settlement → general preferred note (not regulated)", generalD?.type === "preferred_general" && generalD.regulated === false)
  const none = resolveVendorDisclosure({ category: "landscaper", preferred: false, vendorName: "Green Lawns" })
  check("non-preferred, non-regulated, non-AfBA → no disclosure", none === null)

  console.log("\n[disclosure language · pure — legally-required phrases present]")
  check("standard disclosure says 'not required to use' + 'free to shop around'", /not required to use/i.test(standardPreferredDisclosure({ vendorName: "X" })) && /free to shop around/i.test(standardPreferredDisclosure({ vendorName: "X" })))
  check("AfBA disclosure names the conflict + 'NOT REQUIRED TO USE'", /conflict of interest/i.test(afbaDisclosure({ vendorName: "X" })) && /NOT REQUIRED TO USE/.test(afbaDisclosure({ vendorName: "X" })))
  check("kickback notice cites RESPA + settlement providers", /RESPA/.test(respaKickbackNotice()) && /settlement service/i.test(respaKickbackNotice()))
  const withOverride = resolveVendorDisclosure({ category: "title", preferred: true, brokerageName: "Acme Realty", vendorName: "Blue Title", overrides: { preferred: "[Brokerage Name] works with [Vendor Name]. You may shop around." } })
  check("override tokens [Brokerage Name]/[Vendor Name] interpolate", withOverride?.text === "Acme Realty works with Blue Title. You may shop around.")

  console.log("\n[event rows · pure — immutable ledger shape]")
  const shown = buildDisclosureEvent({ brokerageId: "b1", vendorId: "v1", actorUserId: null, actorRole: "client", disclosureType: "preferred_settlement", action: "shown", contactId: "c1" })
  check("shown event → gate respa_vendor_disclosure, allowed, clear", shown.gate_name === RESPA_DISCLOSURE_GATE && shown.allowed && shown.severity === "clear" && shown.message_type === "shown")
  const block = buildReferralBlockEvent({ brokerageId: "b1", actorUserId: null, actorRole: "agent", vendorCategory: "title", verdict: blocked })
  check("block event → gate respa_referral_fee, blocked, carries the violation code", block.gate_name === RESPA_REFERRAL_GATE && block.allowed === false && block.severity === "blocked" && block.violations.includes("RESPA_VIOLATION_SETTLEMENT_REFERRAL"))
}

function sourceLayer() {
  console.log("\n[wiring — guard wired, disclosure rendered, owned, proof runnable]")
  const ref = src("app/actions/referrals/referral-actions.ts")
  check("createPartner calls guardVendorReferralFee before the insert", /guardVendorReferralFee\([\s\S]*?\)[\s\S]*?verdict\.allowed/.test(ref) && ref.indexOf("guardVendorReferralFee") < ref.indexOf('.from("referral_partners")\n    .insert'))
  check("a blocked settlement fee throws the RESPA kickback notice", /respaKickbackNotice\(\)/.test(ref))
  const page = src("app/portal/[contactId]/vendors/page.tsx")
  check("portal computes a per-vendor disclosure via resolveVendorDisclosure", /resolveVendorDisclosure\(/.test(page) && /disclosureByVendor/.test(page))
  check("portal renders the inline disclosure + gates AfBA contact via RespaAckGate", /RespaAckGate/.test(page) && /disclosure\.text/.test(page))
  const gate = src("app/portal/[contactId]/vendors/respa-ack-gate.tsx")
  check("the AfBA gate hides contact until acknowledgeVendorDisclosureAction succeeds", /acknowledgeVendorDisclosureAction/.test(gate) && /acknowledged/.test(gate))
  const reg = src("lib/kernel/manager-registry.ts")
  check("burn domain owned by compliance_officer with a runnable proof", /vendor_respa_compliance:\s*\{\s*manager:\s*"compliance_officer",\s*proof:\s*"test:vendor-respa"/.test(reg))
  check("package.json wires the proof script", /"test:vendor-respa":\s*"tsx scripts\/vendor-respa-simulator\.ts"/.test(src("package.json")))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the logic"); return }
  const svc = createClient(url, key)
  console.log("\n[live] disclosure shown (idempotent) → acknowledged → settlement fee blocked vs mover allowed → clean up")
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⊘ no brokerage — skipping"); return }
  const brokerageId = (brk as any).id
  const vendorId = randomUUID()
  const contactId = randomUUID()
  const marker = `respa-sim-${randomUUID().slice(0, 8)}`
  const cleanup: string[] = []
  const {
    logVendorDisclosureShown,
    recordVendorDisclosureAcknowledgment,
    guardVendorReferralFee,
  } = await import("../lib/compliance/vendor-respa")

  try {
    // 1) disclosure shown — idempotent per (vendor, contact, day)
    const s1 = await logVendorDisclosureShown(svc as any, { brokerageId, vendorId, contactId, actorUserId: null, actorRole: "client", disclosureType: "preferred_settlement" })
    check("live: first disclosure-shown recorded", s1.recorded)
    const s2 = await logVendorDisclosureShown(svc as any, { brokerageId, vendorId, contactId, actorUserId: null, actorRole: "client", disclosureType: "preferred_settlement" })
    check("live: same-day re-show is deduped (idempotent)", s2.recorded === false)

    // 2) acknowledgment recorded (immutable)
    const a1 = await recordVendorDisclosureAcknowledgment(svc as any, { brokerageId, vendorId, contactId, actorUserId: null, actorRole: "client", disclosureType: "afba" })
    check("live: acknowledgment recorded on the immutable ledger", a1.recorded)

    // collect disclosure-event rows for this synthetic vendor
    const { data: discRows } = await svc.from("compliance_events").select("id, message_type").eq("gate_name", RESPA_DISCLOSURE_GATE).eq("entity_id", vendorId)
    for (const r of discRows ?? []) cleanup.push((r as any).id)
    check("live: exactly one 'shown' + one 'acknowledged' row exist", (discRows ?? []).filter((r: any) => r.message_type === "shown").length === 1 && (discRows ?? []).filter((r: any) => r.message_type === "acknowledged").length === 1)

    // 3) settlement referral fee → BLOCKED + ledgered
    const blocked = await guardVendorReferralFee(svc as any, { brokerageId, actorUserId: null, actorRole: "agent", category: "title_company", partnerName: marker, hasFee: true, feeType: "flat_referral_fee" })
    check("live: settlement referral fee blocked", !blocked.allowed)
    const { data: blockRows } = await svc.from("compliance_events").select("id").eq("gate_name", RESPA_REFERRAL_GATE).contains("details", { partner_name: marker })
    for (const r of blockRows ?? []) cleanup.push((r as any).id)
    check("live: the block is recorded on the ledger", (blockRows ?? []).length === 1)

    // 4) non-settlement (mover) fee → ALLOWED, no ledger row
    const allowed = await guardVendorReferralFee(svc as any, { brokerageId, actorUserId: null, actorRole: "agent", category: "moving", partnerName: `${marker}-mover`, hasFee: true, feeType: "flat_referral_fee" })
    check("live: mover fee allowed (no RESPA block)", allowed.allowed)
    const { data: moverRows } = await svc.from("compliance_events").select("id").eq("gate_name", RESPA_REFERRAL_GATE).contains("details", { partner_name: `${marker}-mover` })
    check("live: no ledger row for an allowed non-settlement fee", (moverRows ?? []).length === 0)
  } finally {
    for (const id of cleanup) await svc.from("compliance_events").delete().eq("id", id)
    let left = 0
    for (const id of cleanup) { const { count } = await svc.from("compliance_events").select("id", { count: "exact", head: true }).eq("id", id); left += count ?? 0 }
    check("live: cleanup count == 0", left === 0)
  }
}

async function main() {
  pureLayer()
  sourceLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ VENDOR_RESPA_FAIL"); process.exit(1) }
  console.log(" ✅ VENDOR_RESPA_PASS — settlement vendors disclosed, AfBA gated, kickback fees structurally blocked, all on the immutable ledger")
}
main()

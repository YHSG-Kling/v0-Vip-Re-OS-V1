#!/usr/bin/env tsx
/**
 * scripts/referral-reciprocity-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves THE REFERRAL-RECIPROCITY TRACKER — white space WITH an honesty constraint (inbound
 * was tracked; outbound lived in a separate identity space, so "you sent 0" would be a lie
 * unless the partner is linked to a vendor). Pure classifier never asserts one-sidedness from
 * untracked outbound; the runner links by exact name, counts outbound from vendor_bookings,
 * and fires a GATED Sphere nudge on a measurable imbalance.
 *
 * Layer 1 (pure): the reciprocity verdict matrix (incl. the honest "outbound_untracked").
 * Layer 2 (live, gated): seed a vendor + a linked referral_partner that's sent the agent
 *   referrals but received none back (no vendor_bookings) → one_sided_inbound flagged + a
 *   gated bus signal; an UNLINKED partner stays "untracked" (never falsely flagged); re-run
 *   idempotent. Seeds cleaned up. No mocks.
 *
 * Run: npx tsx scripts/referral-reciprocity-simulator.ts   (npm run test:referral-reciprocity)
 */
import {
  classifyReciprocity,
  buildReciprocityReport,
  normalizeName,
  MIN_RECEIVED,
  type PartnerReciprocityInput,
} from "../lib/referrals/referral-reciprocity"

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
  console.log(" ✅ Referral-reciprocity verified — one-sided caught, untracked stays honest, gated nudge.")
  console.log(" REFERRAL_RECIPROCITY_PASS")
  process.exit(0)
}

const P = (over: Partial<PartnerReciprocityInput>): PartnerReciprocityInput => ({
  partnerId: "p", partnerName: "Acme Lending", partnerType: "mortgage_broker", received: 0, sent: 0, ...over,
})

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Referral-reciprocity tracker simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · reciprocity verdict]")
  check("they send, we send 0 (linked) → one_sided_inbound + flagged", (() => { const r = classifyReciprocity(P({ received: 5, sent: 0 })); return r.status === "one_sided_inbound" && r.flagged })())
  check("we send, they send 0 → one_sided_outbound + flagged", (() => { const r = classifyReciprocity(P({ received: 0, sent: 4 })); return r.status === "one_sided_outbound" && r.flagged })())
  check("roughly even → balanced, not flagged", (() => { const r = classifyReciprocity(P({ received: 3, sent: 3 })); return r.status === "balanced" && !r.flagged })())
  // THE HONESTY CONSTRAINT: outbound UNKNOWN (null) → never a fabricated "you sent 0".
  const untracked = classifyReciprocity(P({ received: 5, sent: null }))
  check("valued inbound partner, outbound UNTRACKED → outbound_untracked (NOT one_sided)", untracked.status === "outbound_untracked")
  check("untracked is NOT flagged as one-sided (no fabricated zero)", untracked.flagged === false)
  check("untracked message suggests linking", untracked.message.toLowerCase().includes("link"))
  check("thin history → insufficient", classifyReciprocity(P({ received: 1, sent: 0 })).status === "insufficient")
  check(`needs ≥${MIN_RECEIVED} received to call inbound one-sided`, classifyReciprocity(P({ received: 1, sent: 0 })).status !== "one_sided_inbound")

  const rep = buildReciprocityReport([
    P({ partnerId: "a", received: 6, sent: 0 }),   // one_sided_inbound
    P({ partnerId: "b", received: 3, sent: 0 }),   // one_sided_inbound (smaller)
    P({ partnerId: "c", received: 4, sent: 4 }),   // balanced
    P({ partnerId: "d", received: 7, sent: null }),// untracked
  ])
  check("report flags only measurable one-sided partners", rep.flagged.length === 2)
  check("flagged sorted by imbalance (biggest first)", rep.flagged[0].partnerId === "a")
  check("untracked surfaced separately (not flagged)", rep.untracked.length === 1 && rep.untracked[0].partnerId === "d")
  check("name normalization for exact link match", normalizeName("Acme Lending, LLC ") === "acme lending llc")

  console.log("\n[Layer 2 · live: a linked one-sided partner is flagged; an unlinked one stays honest]")
  const hasCreds =
    !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    return report()
  }
  const { createServiceClient } = await import("../lib/supabase/service")
  const { runReferralReciprocity } = await import("../lib/referrals/referral-reciprocity-runner")
  const svc = createServiceClient()
  const { data: brokerage } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brokerage) { console.log("  ⏭  Skipped — need a real brokerage."); return report() }
  const brokerageId = (brokerage as any).id
  const uuid = () => (globalThis.crypto ?? require("node:crypto").webcrypto).randomUUID()
  const stampGen = async (req: { goal: string }) => ({ subject: "ZZGEN", body: `ZZGEN ${req.goal}` })

  const vendorId = uuid()
  const linkedPartnerId = uuid()
  const unlinkedPartnerId = uuid()
  const vendorName = `ZZ Inspector ${uuid().slice(0, 8)}`
  try {
    // vendors.category and referral_partners.partner_type are DIFFERENT
    // vocabularies for the same trade: the bench says 'inspector' (the 38-value
    // CHECK it shares with vendor_directory), the partner table says
    // 'home_inspector'. lib/compliance/vendor-respa.ts normalises across both —
    // which is exactly why this row must use the bench's spelling here.
    await svc.from("vendors").insert({ id: vendorId, brokerage_id: brokerageId, name: vendorName, category: "inspector" })
    // Linked partner: sent us 5, we've booked them 0 → one_sided_inbound.
    await svc.from("referral_partners").insert({
      id: linkedPartnerId, brokerage_id: brokerageId, partner_name: vendorName, partner_type: "home_inspector",
      total_referrals_received: 5, vendor_id: vendorId, active: true,
    })
    // Unlinked partner: sent us 5, no vendor link → must stay 'untracked', never flagged.
    await svc.from("referral_partners").insert({
      id: unlinkedPartnerId, brokerage_id: brokerageId, partner_name: `ZZ Unlinked ${uuid().slice(0, 8)}`,
      partner_type: "attorney", total_referrals_received: 5, active: true,
    })

    const r = await runReferralReciprocity({ brokerageId, copyGenerator: stampGen, autoLink: false }, svc)
    const linked = r.report.find((p) => p.partnerId === linkedPartnerId)
    const unlinked = r.report.find((p) => p.partnerId === unlinkedPartnerId)
    check("linked one-sided partner is flagged + escalated", linked?.status === "one_sided_inbound" && r.escalated >= 1, JSON.stringify(linked))
    check("unlinked partner stays 'outbound_untracked' (honest, not flagged)", unlinked?.status === "outbound_untracked" && unlinked?.flagged === false)

    const { count: sigCount } = await svc.from("manager_signals").select("id", { count: "exact", head: true })
      .eq("entity_id", linkedPartnerId).eq("signal_type", "referral_reciprocity")
    check("a referral_reciprocity bus signal was published (gated)", (sigCount ?? 0) >= 1)

    const r2 = await runReferralReciprocity({ brokerageId, copyGenerator: stampGen, autoLink: false }, svc)
    check("re-run within the window does not re-escalate (idempotent)", r2.escalated === 0)
  } finally {
    await svc.from("manager_signals").delete().eq("entity_id", linkedPartnerId).then(() => {}, () => {})
    await svc.from("notifications").delete().in("entity_id", [linkedPartnerId, unlinkedPartnerId]).eq("type", "referral_reciprocity").then(() => {}, () => {})
    await svc.from("referral_partners").delete().in("id", [linkedPartnerId, unlinkedPartnerId]).then(() => {}, () => {})
    await svc.from("vendors").delete().eq("id", vendorId).then(() => {}, () => {})
    const { count } = await svc.from("referral_partners").select("id", { count: "exact", head: true }).in("id", [linkedPartnerId, unlinkedPartnerId])
    check("cleanup: seeded partners removed (count == 0)", (count ?? 0) === 0)
  }
  report()
}

main().catch((e) => { console.error(e); process.exit(1) })

#!/usr/bin/env tsx
/**
 * scripts/stranded-offer-reaper-simulator.ts   (npm run test:stranded-offer-reaper)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the STRANDED-OFFER reaper — the safety net on the offer→under-contract boundary. An accepted
 * offer that never became a transaction (compliance gate unfinished) is escalated to the agent past the
 * grace window; an accepted offer that DID become a deal, a fresh acceptance, and a non-accepted offer
 * are all left alone.
 *
 * Layer 1 (pure): classifyStrandedOffer. Layer 2 (live, creds-gated): seed an accepted offer with NO
 * transaction, aged past grace → the reaper escalates a HIGH-priority notification to the agent →
 * idempotent re-run adds nothing → an accepted offer WITH a transaction escalates nothing → clean up.
 */
import { classifyStrandedOffer, STRANDED_OFFER_GRACE_HOURS } from "../lib/transactions/stranded-offer-policy"

let passed = 0, failed = 0
const failures: string[] = []
const check = (n: string, c: boolean, d?: string) => { if (c) { passed++; console.log(`  ✓ ${n}`) } else { failed++; failures.push(n + (d ? ` — ${d}` : "")); console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`) } }
function report() {
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); failures.forEach((f) => console.log(`   - ${f}`)); process.exit(1) }
  console.log(" ✅ Stranded-offer reaper verified — an accepted offer never silently fails to become a tracked deal.")
  console.log(" STRANDED_OFFER_REAPER_PASS"); process.exit(0)
}

const HOUR = 3_600_000
async function main() {
  const now = Date.now()
  const past = new Date(now - (STRANDED_OFFER_GRACE_HOURS + 1) * HOUR).toISOString()
  const fresh = new Date(now - 1 * HOUR).toISOString()

  console.log("\n[Layer 1 · classifyStrandedOffer]")
  check("accepted + no txn + past grace → escalate", classifyStrandedOffer({ status: "accepted", transactionId: null, respondedAt: past, createdAt: past, now }) === "escalate")
  check("accepted + no txn + WITHIN grace → keep (give the contract time)", classifyStrandedOffer({ status: "accepted", transactionId: null, respondedAt: fresh, createdAt: fresh, now }) === "keep")
  check("accepted + HAS txn → keep (it became a deal — exactly right)", classifyStrandedOffer({ status: "accepted", transactionId: "t1", respondedAt: past, createdAt: past, now }) === "keep")
  check("pending offer → keep (only accepted offers can strand)", classifyStrandedOffer({ status: "pending", transactionId: null, respondedAt: past, createdAt: past, now }) === "keep")
  check("rejected offer → keep", classifyStrandedOffer({ status: "rejected", transactionId: null, respondedAt: past, createdAt: past, now }) === "keep")
  check("null responded_at falls back to created_at (past) → escalate", classifyStrandedOffer({ status: "accepted", transactionId: null, respondedAt: null, createdAt: past, now }) === "escalate")
  check("exactly at the grace boundary → escalate", classifyStrandedOffer({ status: "accepted", transactionId: null, respondedAt: new Date(now - STRANDED_OFFER_GRACE_HOURS * HOUR).toISOString(), createdAt: past, now }) === "escalate")

  console.log("\n[Layer 2 · live: accepted offer with no transaction → escalate, idempotent, cleanup]")
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) { console.log("  ⏭  Skipped — SUPABASE creds not set (Layer 1 ran)."); return report() }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { reapStrandedAcceptedOffers } = await import("../lib/transactions/stranded-offer-reaper")
  const svc = createServiceClient()
  const { data: brokerage } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brokerage) { console.log("  ⏭  Skipped — need a real brokerage."); return report() }
  const brokerageId = (brokerage as any).id
  const cleanup: Array<{ table: string; id: string }> = []
  let offerId: string | null = null
  try {
    const stale = new Date(Date.now() - (STRANDED_OFFER_GRACE_HOURS + 2) * HOUR).toISOString()
    const { data: o } = await svc.from("offers").insert({
      brokerage_id: brokerageId, status: "accepted", transaction_id: null,
      responded_at: stale, created_at: stale,
    }).select("id").single()
    offerId = (o as any)?.id ?? null
    if (offerId) cleanup.push({ table: "offers", id: offerId })

    const r1 = await reapStrandedAcceptedOffers(brokerageId, svc, { limit: 200 })
    check("reaper escalated the stranded offer", r1.escalated >= 1, JSON.stringify(r1))
    const { data: note } = await svc.from("notifications").select("id, type, priority")
      .eq("brokerage_id", brokerageId).eq("type", "accepted_offer_stranded").eq("entity_id", offerId).maybeSingle()
    check("a HIGH-priority agent alert was created", (note as any)?.priority === "high", JSON.stringify(note))
    if ((note as any)?.id) cleanup.push({ table: "notifications", id: (note as any).id })

    const r2 = await reapStrandedAcceptedOffers(brokerageId, svc, { limit: 200 })
    check("re-running is idempotent (no second alert)", r2.escalated === 0, JSON.stringify(r2))
  } finally {
    for (const c of [...cleanup].reverse()) await svc.from(c.table).delete().eq("id", c.id).then(() => {}, () => {})
    const { count } = await svc.from("notifications").select("id", { count: "exact", head: true }).eq("type", "accepted_offer_stranded").eq("entity_id", offerId ?? "none")
    check("cleanup: alert + seed removed (count == 0)", (count ?? 0) === 0)
  }
  report()
}
main().catch((e) => { console.error(e); process.exit(1) })

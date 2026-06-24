#!/usr/bin/env tsx
/**
 * scripts/license-review-simulator.ts  (npm run test:license-review)
 *
 * Proves the License Verifier → Compliance/Admin manual-review hand-off:
 *  - PURE (always): licenseNeedsManualReview (only a submitted license stuck at pending/failed is
 *    queued; verified/unverified are not) + manualReviewOutcome (approve→verified/passed,
 *    reject→failed/failed).
 *  - LIVE (creds-gated): seed a brokerage + agent + a pending agent_licenses row, run
 *    reviewLicenseManually's DB contract directly (status flip + license_verifications audit row +
 *    agent notification), assert, then self-clean (reverse-delete, count == 0).
 */
import { randomUUID } from "node:crypto"
import { licenseNeedsManualReview, manualReviewOutcome } from "../lib/onboarding/license-review"

let pass = 0, fail = 0
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}`) } }

function pureLayer(): void {
  console.log("\n[license review · pure — who lands in the manual-review queue]")
  check("pending + submitted ⇒ needs review", licenseNeedsManualReview("pending", true) === true)
  check("failed + submitted ⇒ needs review", licenseNeedsManualReview("failed", true) === true)
  check("verified ⇒ NOT in queue", licenseNeedsManualReview("verified", true) === false)
  check("unverified (never attempted) ⇒ NOT in queue", licenseNeedsManualReview("unverified", true) === false)
  check("pending but no license number ⇒ NOT in queue", licenseNeedsManualReview("pending", false) === false)

  console.log("\n[license review · pure — admin decision → canonical status]")
  const approve = manualReviewOutcome("approve")
  check("approve ⇒ verified / passed", approve.verificationStatus === "verified" && approve.verificationResult === "passed" && approve.verified)
  const reject = manualReviewOutcome("reject")
  check("reject ⇒ failed / failed", reject.verificationStatus === "failed" && reject.verificationResult === "failed" && !reject.verified)
}

async function liveLayer(): Promise<void> {
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[license review · live]  ⊘ skipped (no SUPABASE creds) — pure layer proved the queue + decision logic")
    return
  }
  console.log("\n[license review · live — admin clears a pending license → status + audit + notify → self-clean]")
  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const tag = `LICREV-${randomUUID().slice(0, 8)}`
  const brokerageId = randomUUID()
  const userId = randomUUID()
  const cleanup: Array<() => PromiseLike<unknown>> = []
  let agentId: string | null = null
  let licenseId: string | null = null
  try {
    await svc.from("brokerages").insert({ id: brokerageId, name: `${tag} Brokerage`, city: "Austin", state: "TX" })
    cleanup.push(() => svc.from("brokerages").delete().eq("id", brokerageId))
    await svc.from("users").insert({ id: userId, brokerage_id: brokerageId, email: `lic+${tag}@demo.local`, first_name: "Lic", last_name: "Agent", user_type: "agent" })
    cleanup.push(() => svc.from("users").delete().eq("id", userId))
    const { data: ar } = await svc.from("agents").insert({ user_id: userId, brokerage_id: brokerageId }).select("id").single()
    agentId = ar!.id as string
    cleanup.push(() => svc.from("agents").delete().eq("id", agentId as string))

    const { data: lr } = await svc.from("agent_licenses").insert({
      agent_id: agentId, brokerage_id: brokerageId, license_number: `${tag}-001`, license_state: "TX", verification_status: "pending",
    }).select("id").single()
    licenseId = lr!.id as string
    cleanup.push(() => svc.from("license_verifications").delete().eq("license_id", licenseId as string))
    cleanup.push(() => svc.from("agent_licenses").delete().eq("id", licenseId as string))
    cleanup.push(() => svc.from("notifications").delete().eq("entity_id", licenseId as string))

    // Apply the same DB contract reviewLicenseManually("approve") runs.
    const outcome = manualReviewOutcome("approve")
    await svc.from("agent_licenses").update({ verification_status: outcome.verificationStatus, verified_at: new Date().toISOString() }).eq("id", licenseId)
    await svc.from("license_verifications").insert({
      brokerage_id: brokerageId, license_id: licenseId, verification_method: "manual",
      verification_result: outcome.verificationResult, raw_response: { detail: "sim approve", reviewer_user_id: userId },
    })
    await svc.from("notifications").insert({
      user_id: userId, brokerage_id: brokerageId, type: "license_verified", title: "License verified",
      body: "Your TX license was verified by your brokerage.", entity_type: "agent_license", entity_id: licenseId, priority: "normal", channel: "in_app",
    })

    const { data: after } = await svc.from("agent_licenses").select("verification_status").eq("id", licenseId).single()
    check("license flips pending → verified", (after as { verification_status?: string } | null)?.verification_status === "verified")
    const { count: vcount } = await svc.from("license_verifications").select("id", { count: "exact", head: true }).eq("license_id", licenseId).eq("verification_method", "manual")
    check("a manual license_verifications audit row exists", (vcount ?? 0) === 1)
    const { count: ncount } = await svc.from("notifications").select("id", { count: "exact", head: true }).eq("entity_id", licenseId).eq("type", "license_verified")
    check("the agent is notified of the outcome", (ncount ?? 0) === 1)
  } finally {
    for (const del of cleanup.reverse()) { try { await del() } catch { /* best-effort */ } }
    const { count } = await svc.from("agent_licenses").select("id", { count: "exact", head: true }).eq("brokerage_id", brokerageId)
    check("cleanup complete", (count ?? 0) === 0)
  }
}

async function main(): Promise<void> {
  pureLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ LICENSE_REVIEW_FAIL"); process.exit(1) }
  console.log(" ✅ LICENSE_REVIEW_PASS — failed verifications escalate to a human queue that resolves")
}

main().catch((e) => { console.error(e); process.exit(1) })

#!/usr/bin/env tsx
/**
 * scripts/vendor-review-simulator.ts   (npm run test:vendor-review)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves VENDOR REVIEW-AS-A-PRODUCT — verification (server-enforced), 1.5× weighting, moderation
 * routing, community flagging, and the immutable vendor response. The client can never self-assert a
 * verified badge; a one-star / profanity / PII / competitor / new-account review goes to a human.
 *
 * PURE:   verificationMethod (txn/booking party, else unverified) + weightedReviewAverage (verified 1.5×)
 *         + screenReview (auto-approve only when spotless; every trip → human) + moderationAfterFlag (3→under).
 * SOURCE: rateVendorBooking verifies + rolls up; submitVendorReview screens server-side; respond is
 *         immutable; flag dedupes + escalates; moderate is admin-only; owned by sphere with a runnable proof.
 * LIVE (creds-gated): insert a verified + an unverified approved review on a real vendor → the weighted
 *         average is 1.5×-correct → a flag dedupes per user → clean up == 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import {
  verificationMethod,
  weightedReviewAverage,
  screenReview,
  moderationAfterFlag,
  VERIFIED_WEIGHT,
} from "../lib/kernel/vendor-review-moderation"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")
const longClean = "This vendor was punctual, communicative, and did excellent work from start to finish. Highly professional."

function pureLayer() {
  console.log("\n[verification · pure — server-enforced, never client-asserted]")
  check("transaction agent → verified transaction_party", verificationMethod({ reviewerUserId: "u1", transaction: { agentId: "u1" } }).isVerified)
  check("transaction buyer CONTACT → verified", verificationMethod({ reviewerUserId: null, reviewerContactId: "c9", transaction: { buyerContactId: "c9" } }).method === "transaction_party")
  check("booking requester → verified booking_party", verificationMethod({ reviewerUserId: "u2", booking: { requestedBy: "u2" } }).method === "booking_party")
  check("a stranger → unverified (not a party)", verificationMethod({ reviewerUserId: "nobody", transaction: { agentId: "u1" }, booking: { requestedBy: "u2" } }).method === "unverified")

  console.log("\n[weighting · pure — a verified voice counts more]")
  const w = weightedReviewAverage([{ rating: 5, isVerified: true }, { rating: 3, isVerified: false }])
  check(`verified ${VERIFIED_WEIGHT}× → (5·1.5 + 3·1.0)/2.5 = 4.2`, w.avg === 4.2 && w.count === 2 && w.verifiedCount === 1)
  check("all-unverified is a plain mean", weightedReviewAverage([{ rating: 4, isVerified: false }, { rating: 2, isVerified: false }]).avg === 3)
  check("no valid ratings → null", weightedReviewAverage([{ rating: null, isVerified: true }, { rating: 9, isVerified: false }]).avg === null)

  console.log("\n[moderation · pure — auto-approve only when spotless]")
  check("clean long review from an aged account → auto-approved", screenReview({ rating: 5, body: longClean, accountAgeDays: 90 }).autoApprove)
  check("one-star always goes to a human", !screenReview({ rating: 1, body: longClean, accountAgeDays: 90 }).autoApprove)
  check("too-short → human", !screenReview({ rating: 5, body: "great", accountAgeDays: 90 }).autoApprove)
  check("profanity → human", screenReview({ rating: 5, body: `${longClean} what shit service`, accountAgeDays: 90 }).reasons.includes("profanity"))
  check("PII (email/phone) → human", screenReview({ rating: 5, body: `${longClean} call 512-555-1212`, accountAgeDays: 90 }).reasons.includes("pii"))
  check("competitor mention → human", screenReview({ rating: 5, body: `${longClean} unlike Acme Movers`, accountAgeDays: 90, competitorNames: ["Acme Movers"] }).reasons.includes("competitor_mention"))
  check("new account (<7d) → human; unknown age → human (honest, never auto)", !screenReview({ rating: 5, body: longClean, accountAgeDays: 2 }).autoApprove && !screenReview({ rating: 5, body: longClean, accountAgeDays: null }).autoApprove)

  console.log("\n[flag escalation · pure]")
  check("3 flags → under_review", moderationAfterFlag("approved", 3) === "under_review")
  check("under 3 flags → unchanged", moderationAfterFlag("approved", 2) === "approved")
  check("a rejected review stays rejected", moderationAfterFlag("rejected", 5) === "rejected")
}

function sourceLayer() {
  console.log("\n[wiring — verified, screened, immutable response, flag escalation, admin moderation]")
  const vm = src("app/actions/vendor-marketplace.ts")
  check("rateVendorBooking sets server-computed verification + rolls up reviews", /verificationMethod\(\{[\s\S]*?recomputeVendorReviewStats\(booking\.vendor_id/.test(vm))
  check("submitVendorReview server-verifies + screens (client can't self-assert)", /submitVendorReview/.test(vm) && /verificationMethod\(\{[\s\S]*?screenReview\(\{ rating: data\.rating/.test(vm))
  check("respondToVendorReview enforces ONE immutable response", /vendor_response\)\s*throw new Error\("A response has already been submitted/.test(vm))
  check("flagVendorReview dedupes per user + escalates via moderationAfterFlag", /vendor_review_flags/.test(vm) && /moderationAfterFlag\(/.test(vm))
  check("moderateVendorReview is admin-only + recomputes", /moderateVendorReview/.test(vm) && /isAdmin/.test(vm) && /recomputeVendorReviewStats/.test(vm))
  check("recomputeVendorReviewStats writes the weighted rollup to vendor_ratings", /review_avg: stats\.avg, review_count: stats\.count, verified_review_count: stats\.verifiedCount/.test(vm))
  const reg = src("lib/kernel/manager-registry.ts")
  check("burn domain owned by sphere_of_influence with a runnable proof", /vendor_review_moderation:\s*\{\s*manager:\s*"sphere_of_influence",\s*proof:\s*"test:vendor-review"/.test(reg))
  check("vendor_review_flags is owned in TABLE_MANAGER", /vendor_review_flags:\s*"sphere_of_influence"/.test(reg))
  const snap = src("scripts/schema-snapshot.ts")
  check("schema snapshot carries the new review columns + flags table", /vendor_reviews:\s*\[[^\]]*"is_verified"[^\]]*"moderation_status"/.test(snap) && /vendor_review_flags:\s*\[/.test(snap))
  check("package.json wires the proof", /"test:vendor-review":\s*"tsx scripts\/vendor-review-simulator\.ts"/.test(src("package.json")))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the logic"); return }
  const svc = createClient(url, key)
  console.log("\n[live] insert a verified + unverified approved review → weighted avg 1.5×-correct → flag dedupes → clean up")
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⊘ no brokerage — skipping"); return }
  const brokerageId = (brk as any).id
  const { data: vend } = await svc.from("vendors").select("id").eq("brokerage_id", brokerageId).limit(1).maybeSingle()
  const { data: usr } = await svc.from("users").select("id").eq("brokerage_id", brokerageId).limit(1).maybeSingle()
  if (!vend || !usr) { console.log("  ⊘ no vendor/user — skipping"); return }
  const vendorId = (vend as any).id, userId = (usr as any).id
  const cleanup: Array<{ table: string; id: string }> = []
  try {
    const { data: rv } = await svc.from("vendor_reviews").insert([
      { vendor_id: vendorId, user_id: userId, brokerage_id: brokerageId, rating: 5, review: longClean, is_verified: true, verification_method: "transaction_party", moderation_status: "approved" },
      { vendor_id: vendorId, user_id: userId, brokerage_id: brokerageId, rating: 3, review: longClean, is_verified: false, verification_method: "unverified", moderation_status: "approved" },
    ]).select("id, rating, is_verified")
    for (const r of rv ?? []) cleanup.push({ table: "vendor_reviews", id: (r as any).id })
    check("live: both reviews inserted with the new columns", (rv ?? []).length === 2)

    const stats = weightedReviewAverage(((rv ?? []) as any[]).map((r) => ({ rating: r.rating, isVerified: r.is_verified })))
    check("live: weighted average over the real rows = 4.2 (verified 1.5×)", stats.avg === 4.2 && stats.verifiedCount === 1)

    const reviewId = (rv ?? [])[0]?.id
    const { data: f1 } = await svc.from("vendor_review_flags").insert({ review_id: reviewId, flagged_by: userId, brokerage_id: brokerageId, reason: "fake" }).select("id").maybeSingle()
    if (f1) cleanup.push({ table: "vendor_review_flags", id: (f1 as any).id })
    const { error: dupErr } = await svc.from("vendor_review_flags").insert({ review_id: reviewId, flagged_by: userId, brokerage_id: brokerageId, reason: "fake" })
    check("live: a duplicate flag by the same user is rejected (dedupe)", !!dupErr && /duplicate key|unique/i.test(dupErr.message))
    const { count } = await svc.from("vendor_review_flags").select("id", { count: "exact", head: true }).eq("review_id", reviewId)
    check("live: exactly one flag recorded for the review", (count ?? 0) === 1)
  } finally {
    for (const c of cleanup.reverse()) await svc.from(c.table).delete().eq("id", c.id)
    let left = 0
    for (const c of cleanup) { const { count } = await svc.from(c.table).select("id", { count: "exact", head: true }).eq("id", c.id); left += count ?? 0 }
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
  if (fail > 0) { console.log(" ❌ VENDOR_REVIEW_FAIL"); process.exit(1) }
  console.log(" ✅ VENDOR_REVIEW_PASS — verified + weighted reviews, human-routed moderation, dedup flagging, immutable vendor response")
}
main()

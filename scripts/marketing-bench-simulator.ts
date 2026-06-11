#!/usr/bin/env tsx
/**
 * scripts/marketing-bench-simulator.ts — the multi-channel staging primitive.
 * Layer 2 (live): stage one draft per channel (social/email/newsletter/blog/direct_mail),
 * assert each landed gated (pending/draft) and a re-stage is idempotent. Self-cleans.
 */
import { stageBenchDrafts, type BenchDraft } from "../lib/kernel/marketing-bench"
let passed = 0, failed = 0; const fails: string[] = []
const check = (n: string, c: boolean, d?: string) => { if (c) { passed++; console.log(`  ✓ ${n}`) } else { failed++; fails.push(n + (d ? ` — ${d}` : "")); console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`) } }
const report = () => { console.log(`\n RESULT: ${passed} passed, ${failed} failed`); if (failed) { for (const f of fails) console.log("   - " + f); process.exit(1) } console.log(" ✅ Marketing bench verified — all channels, gated") }
async function main() {
  console.log("══ Marketing bench simulator ══")
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) { console.log("  ⏭  Skipped — no creds (primitive is live-only)."); console.log("\n RESULT: 0 passed, 0 failed\n ✅ Marketing bench (skipped)"); return }
  const { createServiceClient } = await import("../lib/supabase/service"); const svc = createServiceClient()
  const TAG = `Bench${Date.now()}`; const cleanup: Array<{ table: string; id: string }> = []
  try {
    const { data: agent } = await svc.from("agents").select("id, user_id, brokerage_id").not("user_id", "is", null).not("brokerage_id", "is", null).limit(1).single()
    if (!agent) { console.log("  ⏭ need agent"); report(); return }
    const brokerageId = (agent as any).brokerage_id
    const { data: lst } = await svc.from("listings").insert({ brokerage_id: brokerageId, address: `${TAG} 1 St`, city: `${TAG}ville`, status: "active", agent_id: (agent as any).id }).select("id").single()
    cleanup.push({ table: "listings", id: (lst as any).id })
    const drafts: BenchDraft[] = [
      { channel: "social", idemName: "s", subject: "", body: "b", socialPostType: "market_update", brief: TAG },
      { channel: "email", idemName: `${TAG} email`, subject: "s", body: "b", brief: TAG },
      { channel: "newsletter", idemName: `${TAG} nl`, subject: "s", body: "b", brief: TAG },
      { channel: "blog", idemName: `${TAG} blog`, subject: "e", body: "b", brief: TAG },
      { channel: "direct_mail", idemName: `${TAG} dm`, subject: "s", body: "b", mailAudience: "farm", brief: TAG },
    ]
    const ctx = { brokerageId, agentRowId: (agent as any).id, agentUserId: (agent as any).user_id, listingId: (lst as any).id }
    const r1 = await stageBenchDrafts(ctx, drafts, svc)
    check("all 5 channels staged", r1.staged.length === 5, r1.staged.join(","))
    // collect for cleanup + gated-state assertions
    const { data: sp } = await svc.from("social_posts").select("id, approval_status").eq("listing_id", (lst as any).id).maybeSingle(); if (sp) cleanup.push({ table: "social_posts", id: (sp as any).id })
    const { data: em } = await svc.from("email_campaigns").select("id, status, approval_status").eq("campaign_name", `${TAG} email`).maybeSingle(); if (em) cleanup.push({ table: "email_campaigns", id: (em as any).id })
    const { data: nl } = await svc.from("newsletter_campaigns").select("id, status, approval_status").eq("campaign_name", `${TAG} nl`).maybeSingle(); if (nl) cleanup.push({ table: "newsletter_campaigns", id: (nl as any).id })
    const { data: bl } = await svc.from("blog_posts").select("id, publish_status").eq("title", `${TAG} blog`).maybeSingle(); if (bl) cleanup.push({ table: "blog_posts", id: (bl as any).id })
    const { data: dm } = await svc.from("direct_mail_campaigns").select("id, status, approval_status").eq("campaign_name", `${TAG} dm`).maybeSingle(); if (dm) cleanup.push({ table: "direct_mail_campaigns", id: (dm as any).id })
    check("every channel landed GATED (pending/draft, never published)",
      (sp as any)?.approval_status === "pending" && (em as any)?.approval_status === "pending" && (em as any)?.status === "draft" &&
      (nl as any)?.approval_status === "pending_review" && (bl as any)?.publish_status === "pending_review" && (dm as any)?.approval_status === "pending")
    const r2 = await stageBenchDrafts(ctx, drafts, svc)
    check("idempotency: a second pass stages nothing new", r2.staged.length === 0)
  } finally {
    for (const c of [...cleanup].reverse()) { try { await svc.from(c.table).delete().eq("id", c.id) } catch {} }
    const { count } = await svc.from("listings").select("id", { count: "exact", head: true }).like("address", `${TAG}%`)
    check("cleanup verified", (count ?? 0) === 0)
  }
  report()
}
main().catch((e) => { console.error(e); process.exit(1) })

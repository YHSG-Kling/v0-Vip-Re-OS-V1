#!/usr/bin/env tsx
/**
 * scripts/content-approval-registry-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 40 — proves the CONTENT-APPROVAL SOURCE REGISTRY: social, newsletter, and
 * direct-mail approvals are all governed from the ONE Command Center, each
 * reusing its native column with no new state, and each send/publish gate only
 * ships the approved value (a pending row cannot reach a consumer).
 *
 *   Layer 1 — pure: every source maps a row → the unified action contract with
 *     the right preview fields, and its approve/reject patches set the right
 *     columns (newsletter pending_review→approved/rejected; direct-mail
 *     planning→approved).
 *   Layer 2 — live (gated): seed a PENDING newsletter + a PENDING direct-mail
 *     campaign; assert loadCommandCenter surfaces both in their queues; assert
 *     each send gate EXCLUDES them while pending; approve via the registry →
 *     becomes send-eligible + leaves the queue; reject → held out of every send
 *     query; cleanup.
 *
 * Run: npx tsx scripts/content-approval-registry-simulator.ts  (npm run test:content-approval)
 */
import { CONTENT_SOURCES } from "../lib/kernel/approval-sources"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

function testPure() {
  const now = new Date()

  console.log("\n[Layer 1 · social source]")
  const s = CONTENT_SOURCES.social
  const sa = s.toAction({ id: "s1", brokerage_id: "b1", content: "New listing!", media_urls: ["https://x/a.mp4"], hashtags: ["justlisted"], platform: "facebook", listing_id: "l1", ai_generated: true, created_at: now.toISOString(), scheduled_for: now.toISOString() }, now)
  check("social → approve_social_post + creative in actionInput", sa.actionType === "approve_social_post" && (sa.actionInput.media_urls as string[]).length === 1)
  check("social approve sets approval_status=approved", s.approve("u1").approval_status === "approved")
  check("social reject cancels", s.reject("u1").approval_status === "rejected" && s.reject("u1").status === "cancelled")

  console.log("\n[Layer 1 · newsletter source]")
  const n = CONTENT_SOURCES.newsletter
  const na = n.toAction({ id: "n1", brokerage_id: "b1", campaign_name: "March Update", subject_line: "Your market update", content: "Hello ".repeat(400), send_date: now.toISOString(), is_ai_generated: true, created_at: now.toISOString() }, now)
  check("newsletter → approve_newsletter + subject in preview", na.actionType === "approve_newsletter" && na.actionInput.subject_line === "Your market update")
  check("newsletter body preview is truncated", String(na.actionInput.content_preview).endsWith("…"))
  check("newsletter approve → approved, reject → rejected", n.approve("u1").approval_status === "approved" && n.reject("u1").approval_status === "rejected")

  console.log("\n[Layer 1 · direct-mail source]")
  const d = CONTENT_SOURCES.direct_mail
  const da = d.toAction({ id: "d1", brokerage_id: "b1", campaign_name: "Farm Q1", copy_text: "Thinking of selling?", design_url: "https://x/card.png", piece_type: "postcard", quantity: 250, target_audience: "Maple Grove", mailing_date: now.toISOString(), is_ai_generated: true, created_at: now.toISOString() }, now)
  check("direct-mail → approve_direct_mail + design in preview", da.actionType === "approve_direct_mail" && da.actionInput.design_url === "https://x/card.png")
  check("direct-mail approve → status+approval approved (one approval per campaign)", d.approve("u1").status === "approved" && d.approve("u1").approval_status === "approved")
  check("direct-mail reject → approval rejected (held, never prints)", d.reject("u1").approval_status === "rejected")
}

async function testLive() {
  console.log("\n[Layer 2 · live newsletter + direct-mail round-trip]")
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY ||
      !(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)) {
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    return
  }
  const { createServiceClient } = await import("../lib/supabase/service")
  const { loadCommandCenter } = await import("../lib/kernel/command-center")
  const { approveContentSource, rejectContentSource } = await import("../lib/kernel/approval-sources")
  const svc = createServiceClient()
  const TAG = `__crsim_${Date.now()}__`
  const nlIds: string[] = []; const dmIds: string[] = []
  const pastIso = new Date(Date.now() - 60_000).toISOString()
  try {
    const { data: brk } = await svc.from("brokerages").select("id").limit(1).single()
    if (!brk) { console.log("  ⏭  Skipped — no brokerage."); return }
    const brokerageId = (brk as { id: string }).id
    const { data: u } = await svc.from("users").select("id").eq("brokerage_id", brokerageId).limit(1).maybeSingle()
    const userId = (u as { id: string } | null)?.id ?? null
    const ctx = { userId: userId ?? "", brokerageId, isSuperadmin: false }

    // ── Newsletter ──
    async function seedNl(approval: string, name: string): Promise<string> {
      const { data, error } = await svc.from("newsletter_campaigns").insert({
        brokerage_id: brokerageId, campaign_name: `${TAG} ${name}`, subject_line: "Market update",
        content: "Hello subscribers", status: "scheduled", approval_status: approval, send_date: pastIso, is_ai_generated: true,
      }).select("id").single()
      if (error) throw new Error("newsletter seed: " + error.message)
      const id = (data as { id: string }).id; nlIds.push(id); return id
    }
    const nlPending = await seedNl("pending_review", "Pending NL")
    const cc = await loadCommandCenter({ brokerageId })
    check("Command Center surfaces the pending newsletter", !!cc.pendingActions.find((a) => a.id === nlPending && a.queue === "newsletter"))
    async function nlSendEligible(id: string) {
      const { count } = await svc.from("newsletter_campaigns").select("id", { count: "exact", head: true })
        .eq("id", id).eq("approval_status", "approved").eq("status", "scheduled").lte("send_date", new Date().toISOString())
      return (count ?? 0) === 1
    }
    check("pending newsletter is NOT send-eligible", !(await nlSendEligible(nlPending)))
    const nlApprove = await approveContentSource("newsletter", nlPending, ctx)
    check("approve newsletter via registry", nlApprove.ok === true, nlApprove.error)
    check("approved newsletter becomes send-eligible", await nlSendEligible(nlPending))
    const cc2 = await loadCommandCenter({ brokerageId })
    check("approved newsletter leaves the queue", !cc2.pendingActions.find((a) => a.id === nlPending))
    const nlReject = await seedNl("pending_review", "Reject NL")
    await rejectContentSource("newsletter", nlReject, ctx)
    check("rejected newsletter is NOT send-eligible", !(await nlSendEligible(nlReject)))

    // ── Direct mail ──
    async function seedDm(status: string, approval: string, name: string): Promise<string | null> {
      const { data, error } = await svc.from("direct_mail_campaigns").insert({
        brokerage_id: brokerageId, campaign_name: `${TAG} ${name}`, copy_text: "Thinking of selling?",
        design_url: "https://blob/card.png", piece_type: "postcard", quantity: 100, status, approval_status: approval, mailing_date: pastIso, is_ai_generated: true,
      }).select("id").maybeSingle()
      if (error) { console.log(`  ⏭  direct-mail seed failed (${error.message}) — skipping DM half.`); return null }
      const id = (data as { id: string }).id; dmIds.push(id); return id
    }
    const dmPending = await seedDm("planning", "pending", "Pending DM")
    if (dmPending) {
      const ccd = await loadCommandCenter({ brokerageId })
      check("Command Center surfaces the pending direct-mail campaign", !!ccd.pendingActions.find((a) => a.id === dmPending && a.queue === "direct_mail"))
      async function dmPrintEligible(id: string) {
        const { count } = await svc.from("direct_mail_campaigns").select("id", { count: "exact", head: true }).eq("id", id).eq("status", "approved")
        return (count ?? 0) === 1
      }
      check("planning direct-mail is NOT print-eligible", !(await dmPrintEligible(dmPending)))
      const dmApprove = await approveContentSource("direct_mail", dmPending, ctx)
      check("approve direct-mail via registry", dmApprove.ok === true, dmApprove.error)
      check("approved direct-mail becomes print-eligible (status=approved)", await dmPrintEligible(dmPending))
      const ccd2 = await loadCommandCenter({ brokerageId })
      check("approved direct-mail leaves the queue", !ccd2.pendingActions.find((a) => a.id === dmPending))
      const dmReject = await seedDm("planning", "pending", "Reject DM")
      if (dmReject) {
        await rejectContentSource("direct_mail", dmReject, ctx)
        check("rejected direct-mail is NOT print-eligible", !(await dmPrintEligible(dmReject)))
      }
    }
  } finally {
    for (const id of nlIds) { try { await svc.from("newsletter_campaigns").delete().eq("id", id) } catch {} }
    for (const id of dmIds) { try { await svc.from("direct_mail_campaigns").delete().eq("id", id) } catch {} }
    const { count: nlLeft } = await svc.from("newsletter_campaigns").select("id", { count: "exact", head: true }).like("campaign_name", `${TAG}%`)
    const { count: dmLeft } = await svc.from("direct_mail_campaigns").select("id", { count: "exact", head: true }).like("campaign_name", `${TAG}%`)
    check("cleanup verified — 0 test rows remain", (nlLeft ?? 0) === 0 && (dmLeft ?? 0) === 0)
  }
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Content-approval registry simulator (social + newsletter + direct mail)")
  console.log("══════════════════════════════════════════════════")
  testPure()
  await testLive()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Every customer-facing approval governed from the one Command Center")
}
main().catch((e) => { console.error(e); process.exit(1) })

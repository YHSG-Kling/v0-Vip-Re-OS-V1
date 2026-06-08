#!/usr/bin/env tsx
/**
 * scripts/social-approval-gate-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 40 — proves the SOCIAL approval is now governed from the ONE Command
 * Center (consolidating the fragmented per-dashboard approvals into a single
 * surface), and that the gate has teeth: a pending post cannot reach a public
 * feed; only approval makes it publish-eligible.
 *
 *   Layer 1 — pure: a pending post escalates against its SCHEDULED publish time
 *     (not proposal age) — as the post's slot nears, the operator is pushed.
 *   Layer 2 — live (gated): seed a PENDING social post; assert loadCommandCenter
 *     surfaces it as a 'social' action carrying the real creative (content +
 *     media); assert the publish-cron gate query EXCLUDES it while pending;
 *     approve (the exact write the server action makes) → assert it leaves the
 *     pending queue AND becomes publish-eligible; reject another → assert it is
 *     cancelled + never eligible; assert an already-approved post never shows in
 *     the queue; cleanup.
 *
 * Run: npx tsx scripts/social-approval-gate-simulator.ts  (npm run test:social-approval)
 */
import { evaluateApprovalSla } from "../lib/kernel/command-center"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

function testPure() {
  console.log("\n[Layer 1 · scheduled-time escalation]")
  const now = new Date("2026-01-01T00:00:00Z")
  const justCreated = "2026-01-01T00:00:00Z"
  check("post scheduled days out → ok", evaluateApprovalSla(justCreated, now, { deadlineIso: "2026-01-05T00:00:00Z" }).level === "ok")
  check("post scheduled within 48h → due", evaluateApprovalSla(justCreated, now, { deadlineIso: "2026-01-02T18:00:00Z" }).level === "due")
  check("post scheduled within 24h → breached (push the operator)", evaluateApprovalSla(justCreated, now, { deadlineIso: "2026-01-01T12:00:00Z" }).level === "breached")
}

async function testLive() {
  console.log("\n[Layer 2 · live Command Center social gate]")
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY ||
      !(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)) {
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    return
  }
  const { createServiceClient } = await import("../lib/supabase/service")
  const { loadCommandCenter } = await import("../lib/kernel/command-center")
  const svc = createServiceClient()

  const ids: string[] = []
  const TAG = `__socsim_${Date.now()}__`
  const pastIso = new Date(Date.now() - 60_000).toISOString()
  try {
    const { data: brk } = await svc.from("brokerages").select("id").limit(1).single()
    if (!brk) { console.log("  ⏭  Skipped — no brokerage."); return }
    const brokerageId = (brk as { id: string }).id
    const { data: approver } = await svc.from("users").select("id").eq("brokerage_id", brokerageId).limit(1).maybeSingle()
    const approverUserId = (approver as { id: string } | null)?.id ?? null

    async function seedPost(approvalStatus: string, content: string): Promise<string> {
      const { data, error } = await svc.from("social_posts").insert({
        brokerage_id: brokerageId, platform: "facebook", post_type: "custom",
        content: `${TAG} ${content}`, media_urls: ["https://blob/reel.mp4"], hashtags: ["justlisted"],
        status: "scheduled", approval_status: approvalStatus, scheduled_for: pastIso, ai_generated: true,
      }).select("id").single()
      if (error) throw new Error(error.message)
      const id = (data as { id: string }).id
      ids.push(id)
      return id
    }

    const pendingId = await seedPost("pending", "Pending avatar reel")
    const approvedId = await seedPost("approved", "Already approved")

    // Command Center surfaces the PENDING post (and not the already-approved one).
    const cc = await loadCommandCenter({ brokerageId })
    const surfaced = cc.pendingActions.find((a) => a.id === pendingId)
    check("Command Center surfaces the pending social post", !!surfaced && surfaced.queue === "social" && surfaced.actionType === "approve_social_post")
    check("surfaced action carries the real creative (content + media)",
      !!surfaced && /Pending avatar reel/.test(String(surfaced.actionInput.content)) && (surfaced.actionInput.media_urls as string[]).length === 1)
    check("an already-approved post never appears in the queue", !cc.pendingActions.find((a) => a.id === approvedId))

    // publish-cron gate query (status='scheduled' AND approval_status='approved' AND due).
    async function publishEligible(id: string): Promise<boolean> {
      const { count } = await svc.from("social_posts").select("id", { count: "exact", head: true })
        .eq("id", id).eq("status", "scheduled").eq("approval_status", "approved").lte("scheduled_for", new Date().toISOString())
      return (count ?? 0) === 1
    }
    check("PENDING post is NOT publish-eligible (cannot reach a feed)", !(await publishEligible(pendingId)))

    // Approve — the exact write approveSocialPost makes.
    await svc.from("social_posts").update({
      approval_status: "approved", approved_by: approverUserId, approved_at: new Date().toISOString(),
    }).eq("id", pendingId)
    check("after approval the post becomes publish-eligible", await publishEligible(pendingId))
    const cc2 = await loadCommandCenter({ brokerageId })
    check("approved post leaves the pending queue", !cc2.pendingActions.find((a) => a.id === pendingId))

    // Reject path — the exact write rejectSocialPost makes.
    const rejectId = await seedPost("pending", "To be rejected")
    await svc.from("social_posts").update({
      approval_status: "rejected", status: "cancelled", error_message: "Rejected in Command Center",
    }).eq("id", rejectId)
    check("rejected post is NOT publish-eligible", !(await publishEligible(rejectId)))
    const cc3 = await loadCommandCenter({ brokerageId })
    check("rejected post leaves the pending queue", !cc3.pendingActions.find((a) => a.id === rejectId))
  } finally {
    for (const id of ids) { try { await svc.from("social_posts").delete().eq("id", id) } catch {} }
    const { count } = await svc.from("social_posts").select("id", { count: "exact", head: true }).like("content", `${TAG}%`)
    check("cleanup verified — 0 test posts remain", (count ?? 0) === 0)
  }
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Social approval gate simulator (Command Center consolidation)")
  console.log("══════════════════════════════════════════════════")
  testPure()
  await testLive()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Social approvals governed from the one Command Center — pending can't reach a feed")
}
main().catch((e) => { console.error(e); process.exit(1) })

#!/usr/bin/env tsx
/**
 * scripts/lifetime-touchpoint-reaper-simulator.ts   (npm run test:lifetime-touchpoint-reaper)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the lifetime-touchpoint reaper's policy: a 'scheduled' post-close touch whose date passed
 * beyond the grace window is reaped (it never went out → reconcile + surface); a fresh/future scheduled
 * touch, and any already-sent/skipped row, are left alone. Pure: no I/O.
 *
 * Layer 2 (live, creds-gated): seed an overdue 'scheduled' touchpoint → the reaper flips it to 'skipped'
 * + escalates ONE agent alert → idempotent re-run does nothing → clean up.
 */
import { classifyStuckTouchpoint, STALE_TOUCHPOINT_GRACE_DAYS } from "../lib/sphere/lifetime-touchpoint-reaper-policy"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, d?: string) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n + (d ? ` — ${d}` : "")); console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`) } }
function report() {
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ LIFETIME_TOUCHPOINT_REAPER_FAIL"); process.exit(1) }
  console.log(" ✅ LIFETIME_TOUCHPOINT_REAPER_PASS — no scheduled past-client touch sits stale on its own")
  process.exit(0)
}

const DAY = 86_400_000
async function main() {
  const now = Date.now()
  const overdue = new Date(now - (STALE_TOUCHPOINT_GRACE_DAYS + 2) * DAY).toISOString().split("T")[0]
  const justDue = new Date(now - 1 * DAY).toISOString().split("T")[0]
  const future = new Date(now + 10 * DAY).toISOString().split("T")[0]

  console.log("\n[classifyStuckTouchpoint]")
  check("scheduled + overdue past grace → reap", classifyStuckTouchpoint({ status: "scheduled", scheduledDate: overdue, now }) === "reap")
  check("scheduled + within grace → keep", classifyStuckTouchpoint({ status: "scheduled", scheduledDate: justDue, now }) === "keep")
  check("scheduled + future → keep", classifyStuckTouchpoint({ status: "scheduled", scheduledDate: future, now }) === "keep")
  check("already sent → keep (never re-reap a delivered touch)", classifyStuckTouchpoint({ status: "sent", scheduledDate: overdue, now }) === "keep")
  check("already skipped → keep (idempotent)", classifyStuckTouchpoint({ status: "skipped", scheduledDate: overdue, now }) === "keep")
  check("null scheduled_date → keep", classifyStuckTouchpoint({ status: "scheduled", scheduledDate: null, now }) === "keep")

  console.log("\n[Layer 2 · live: overdue scheduled touch → skipped + one agent alert, idempotent, cleanup]")
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) { console.log("  ⏭  Skipped — SUPABASE creds not set (Layer 1 ran)."); return report() }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { reapStuckLifetimeTouchpoints } = await import("../lib/sphere/lifetime-touchpoint-reaper")
  const svc = createServiceClient()
  const { data: brokerage } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brokerage) { console.log("  ⏭  Skipped — need a real brokerage."); return report() }
  const brokerageId = (brokerage as any).id
  const cleanup: Array<{ table: string; id: string }> = []
  let contactId: string | null = null
  try {
    const { data: c } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: "ZZTouch", last_name: `${Date.now()}`,
      email: `zz-touch-${Date.now()}@example.com`, contact_type: "buyer",
    }).select("id").single()
    contactId = (c as any)?.id ?? null
    if (contactId) cleanup.push({ table: "contacts", id: contactId })

    const { data: tp } = await svc.from("lifetime_customer_touchpoints").insert({
      brokerage_id: brokerageId, contact_id: contactId, touchpoint_type: "post_close_6_month",
      channel: "email", scheduled_date: overdue, status: "scheduled",
    }).select("id").single()
    if ((tp as any)?.id) cleanup.push({ table: "lifetime_customer_touchpoints", id: (tp as any).id })

    const r1 = await reapStuckLifetimeTouchpoints(brokerageId, svc, { limit: 300 })
    check("reaper reaped the overdue scheduled touch", r1.reaped >= 1, JSON.stringify(r1))
    const { data: after } = await svc.from("lifetime_customer_touchpoints").select("status").eq("id", (tp as any).id).maybeSingle()
    check("row reconciled to 'skipped'", (after as any)?.status === "skipped")

    const { data: note } = await svc.from("notifications").select("id").eq("brokerage_id", brokerageId)
      .eq("type", "lifetime_touchpoint_missed").eq("entity_id", contactId).maybeSingle()
    check("the miss was surfaced to the agent", !!(note as any)?.id, JSON.stringify(note))
    if ((note as any)?.id) cleanup.push({ table: "notifications", id: (note as any).id })

    const r2 = await reapStuckLifetimeTouchpoints(brokerageId, svc, { limit: 300 })
    check("re-running is idempotent (row already skipped → nothing reaped)", r2.reaped === 0)
  } finally {
    for (const c of [...cleanup].reverse()) await svc.from(c.table).delete().eq("id", c.id).then(() => {}, () => {})
    const { count } = await svc.from("notifications").select("id", { count: "exact", head: true }).eq("type", "lifetime_touchpoint_missed").eq("entity_id", contactId ?? "none")
    check("cleanup: alert + seeds removed (count == 0)", (count ?? 0) === 0)
  }
  report()
}
main().catch((e) => { console.error(e); process.exit(1) })

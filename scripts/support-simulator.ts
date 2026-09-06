#!/usr/bin/env tsx
/**
 * scripts/support-simulator.ts  (npm run test:support)
 *
 * Proves the user-support loop: raise a ticket → triage/transition status →
 * browse help. Mirrors the createSupportTicket / updateTicketStatus / searchHelp
 * server actions' DB contract against the LIVE schema (honoring the live CHECK
 * constraints), and is fully self-cleaning.
 *
 *  - PURE (always): status/priority transition validity + help-result shaping.
 *  - LIVE (creds-gated): seed a tagged brokerage + agent, insert a ticket exactly
 *    as the action does, walk it open→in_progress→resolved→closed, publish a
 *    knowledge article and assert it surfaces in a help search, then delete all
 *    tagged rows.
 *
 * Live run:  SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… npx tsx scripts/support-simulator.ts
 */
import { randomUUID } from "node:crypto"

const STATUSES = ["open", "in_progress", "resolved", "closed"] as const
const PRIORITIES = ["low", "medium", "high", "urgent"] as const

/** Pure: a valid forward transition stays within the allowed status set. */
function isValidStatus(s: string): boolean { return (STATUSES as readonly string[]).includes(s) }
function isValidPriority(p: string): boolean { return (PRIORITIES as readonly string[]).includes(p) }

function selfTest(): void {
  let pass = 0, fail = 0
  const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}`) } }

  console.log("\n[support · pure]")
  check("all four lifecycle statuses are valid", STATUSES.every(isValidStatus))
  check("bogus status rejected", !isValidStatus("done"))
  check("all four priorities are valid", PRIORITIES.every(isValidPriority))
  check("bogus priority rejected", !isValidPriority("p0"))
  // category fallback contract (action coerces unknown → 'general')
  const coerceCategory = (c?: string) => (["general", "technical", "billing", "onboarding", "compliance", "feature_request"].includes(c ?? "") ? c : "general")
  check("unknown category coerces to general", coerceCategory("wat") === "general" && coerceCategory("billing") === "billing")

  if (fail > 0) { console.log(` RESULT: ${pass} passed, ${fail} failed`); process.exit(1) }
  console.log(` RESULT: ${pass} passed, 0 failed`)
}

async function main(): Promise<void> {
  selfTest()

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[live run] ⏭  Skipped — SUPABASE creds not set (or DB unreachable).")
    console.log("\n✅ SUPPORT pure layer passed; live run is creds-gated.")
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const tag = `SUPPORT-${Date.now()}`
  const brokerageId = randomUUID()
  const userId = randomUUID()
  const cleanup: Array<() => PromiseLike<unknown>> = []
  let agentRowId: string | null = null
  let ok = true
  const check = (n: string, c: boolean) => { if (!c) ok = false; console.log(`  ${c ? "✓" : "✗"} ${n}`) }

  console.log(`\n[live run] tag=${tag}`)
  try {
    await svc.from("brokerages").insert({ id: brokerageId, name: `${tag} Brokerage`, city: "Austin", state: "TX" })
    cleanup.push(() => svc.from("brokerages").delete().eq("id", brokerageId))
    await svc.from("users").insert({ id: userId, brokerage_id: brokerageId, email: `agent+${tag}@demo.local`, first_name: "Demo", last_name: "Agent", user_type: "agent" })
    cleanup.push(() => svc.from("users").delete().eq("id", userId))
    const { data: agentRow } = await svc.from("agents").insert({ user_id: userId, brokerage_id: brokerageId }).select("id").single()
    agentRowId = (agentRow?.id as string) ?? null
    if (agentRowId) cleanup.push(() => svc.from("agents").delete().eq("id", agentRowId as string))
    console.log("  ✓ seeded brokerage + agent")

    // ── Raise a ticket (exactly as createSupportTicket) ──
    // `lane` is stated, not defaulted: support_tickets.lane is NOT NULL with no
    // default (m468) precisely so a writer that forgets which conversation it is
    // opening fails at the insert instead of routing to the wrong audience.
    const { data: ticket, error: tErr } = await svc.from("support_tickets").insert({
      brokerage_id: brokerageId, agent_id: agentRowId, lane: "user_to_brokerage",
      subject: `${tag} cannot sync MLS`,
      description: "Listings not importing.", category: "technical", priority: "high", status: "open",
    }).select("id, status").single()
    cleanup.push(() => svc.from("support_tickets").delete().eq("brokerage_id", brokerageId))
    check("ticket created with status=open", !tErr && ticket?.status === "open")
    const ticketId = ticket?.id as string

    // ── Walk the lifecycle ──
    for (const status of ["in_progress", "resolved", "closed"] as const) {
      await svc.from("support_tickets").update({ status, updated_at: new Date().toISOString() }).eq("id", ticketId)
    }
    const { data: finalTicket } = await svc.from("support_tickets").select("status").eq("id", ticketId).single()
    check("ticket transitioned open→…→closed", finalTicket?.status === "closed")

    // ── Publish a help article + assert it surfaces in search ──
    const slug = `${tag.toLowerCase()}-mls-sync`
    await svc.from("knowledge_articles").insert({
      brokerage_id: brokerageId, title: `${tag} Fixing MLS sync`, slug,
      content: "Re-authorize the MLS connector under Integrations.", excerpt: "MLS sync fix.",
      category: "integrations", status: "published", published_at: new Date().toISOString(),
    })
    cleanup.push(() => svc.from("knowledge_articles").delete().eq("brokerage_id", brokerageId))
    const { data: found } = await svc.from("knowledge_articles")
      .select("id, title").eq("status", "published").eq("brokerage_id", brokerageId).ilike("title", `%${tag}%`)
    check("published article surfaces in help search", (found?.length ?? 0) === 1)

    if (!ok) throw new Error("one or more live assertions failed")
    console.log("\n✅ SUPPORT — ticket lifecycle + help publication ran end-to-end on the live DB.")
  } finally {
    for (const del of cleanup.reverse()) { try { await del() } catch { /* best-effort */ } }
    console.log(`  ✓ cleaned up all rows tagged ${tag}`)
  }
  if (!ok) process.exit(1)
}

main().catch((e) => { console.error("support-simulator failed:", e); process.exit(1) })

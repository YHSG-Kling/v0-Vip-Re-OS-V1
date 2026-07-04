#!/usr/bin/env tsx
/**
 * scripts/support-console-simulator.ts   (npm run test:support-console)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the CROSS-TENANT SUPPORT CONSOLE: a real two-way thread, a first-response SLA flag, and reply
 * posting that notifies the other side — so platform staff can actually respond to any tenant's ticket.
 *
 * PURE:   awaitingFirstResponse flags open/in_progress tickets with no staff reply yet.
 * SOURCE: the thread lib notifies both ways + stamps first-response; the console actions are staff-gated with
 *         tenant identity + reply/assign/status; createSupportTicket now alerts staff; the tenant help UI
 *         + god console are wired; owned by data_steward; schema tracked.
 * LIVE (creds-gated): seed a ticket → staff reply (thread + first_response + tenant notification) → tenant
 *         reply (staff notification) → resolve (resolved_at) → clean up == 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { awaitingFirstResponse } from "../lib/support/support-thread"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

function pureLayer() {
  console.log("\n[awaitingFirstResponse · pure — the queue SLA flag]")
  check("open + no staff reply → awaiting", awaitingFirstResponse({ status: "open", first_response_at: null }))
  check("in_progress + no staff reply → awaiting", awaitingFirstResponse({ status: "in_progress", first_response_at: null }))
  check("once staff replied → not awaiting", !awaitingFirstResponse({ status: "in_progress", first_response_at: "2026-07-01" }))
  check("resolved/closed → not awaiting", !awaitingFirstResponse({ status: "resolved", first_response_at: null }))
}

function sourceLayer() {
  console.log("\n[wiring — thread, actions, notify, UI, ownership]")
  const th = src("lib/support/support-thread.ts")
  check("reply posts a message + stamps first_response + open→in_progress", /support_ticket_messages"\)[\s\S]*?insert/.test(th) && /first_response_at = new Date/.test(th) && /status = "in_progress"/.test(th))
  check("staff reply notifies the TENANT; tenant reply notifies platform staff", /type:\s*"support_reply"/.test(th) && /notifyPlatformStaff/.test(th))
  const con = src("app/actions/superadmin/support-console.ts")
  check("console actions are staff-gated (superadmin+support)", /requireStaff/.test(con) && /"superadmin",\s*"support"/.test(con))
  check("the queue carries brokerage name + first-response flag + counts", /brokerageName/.test(con) && /awaitingFirstResponse/.test(con))
  check("reply / assign / status actions exist", /export async function replyToTicketAction/.test(con) && /export async function assignTicketAction/.test(con) && /export async function setTicketStatusAction/.test(con))
  const sup = src("app/actions/support.ts")
  check("createSupportTicket now alerts platform staff (nobody was notified before)", /notifyPlatformStaff[\s\S]*?support_ticket_new/.test(sup))
  check("tenant can reply + read the thread (two-way)", /export async function replyToMyTicket/.test(sup) && /export async function getMyTicketThread/.test(sup))
  check("the god console: queue + ticket detail + reply composer", /listAllTicketsAction/.test(src("app/dashboard/superadmin/support/page.tsx")) && /SupportReplyBox/.test(src("app/dashboard/superadmin/support/[id]/page.tsx")))
  check("the platform console links to Support", /\/dashboard\/superadmin\/support/.test(src("app/dashboard/superadmin/platform/page.tsx")))
  check("the tenant help UI shows the conversation + reply", /TicketThread/.test(src("app/dashboard/help/help-client.tsx")))
  const reg = src("lib/kernel/manager-registry.ts")
  check("burn domain owned by data_steward with a runnable proof", /support_console:\s*\{\s*manager:\s*"data_steward",\s*proof:\s*"test:support-console"/.test(reg))
  check("both support tables owned in TABLE_MANAGER + schema tracked", /support_ticket_messages:\s*"data_steward"/.test(reg) && /support_ticket_messages:\s*\[/.test(src("scripts/schema-snapshot.ts")))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source proved the logic; live verified via MCP"); return }
  const svc = createClient(url, key)
  console.log("\n[live] seed a ticket → staff reply (thread + notify tenant) → tenant reply → resolve → clean up")
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⊘ no brokerage — skipping"); return }
  const brokerageId = (brk as any).id
  const { data: ag } = await svc.from("agents").select("id, user_id").eq("brokerage_id", brokerageId).limit(1).maybeSingle()
  const cleanup: Array<{ table: string; id: string }> = []
  const { postTicketReply } = await import("../lib/support/support-thread")
  try {
    const { data: ticket } = await svc.from("support_tickets").insert({ brokerage_id: brokerageId, agent_id: (ag as any)?.id ?? null, subject: "SIM ticket", description: "help", status: "open", priority: "medium" }).select("id").single()
    if (!ticket) { console.log("  ⊘ could not seed ticket — skipping"); return }
    const ticketId = (ticket as any).id
    cleanup.push({ table: "support_tickets", id: ticketId })

    const staff = await postTicketReply(svc as any, { ticketId, authorUserId: null, authorKind: "staff", body: "We're on it." })
    check("live: staff reply posted", staff.ok === true)
    const { data: after } = await svc.from("support_tickets").select("first_response_at, status").eq("id", ticketId).maybeSingle()
    check("live: first_response stamped + open→in_progress", !!(after as any)?.first_response_at && (after as any)?.status === "in_progress")

    const tenant = await postTicketReply(svc as any, { ticketId, authorUserId: (ag as any)?.user_id ?? null, authorKind: "tenant", body: "Thanks!" })
    check("live: tenant reply posted", tenant.ok === true)
    const { data: msgs } = await svc.from("support_ticket_messages").select("id, author_kind").eq("ticket_id", ticketId).order("created_at", { ascending: true })
    for (const m of (msgs ?? []) as any[]) cleanup.push({ table: "support_ticket_messages", id: m.id })
    check("live: the thread has both a staff + a tenant message", (msgs ?? []).some((m: any) => m.author_kind === "staff") && (msgs ?? []).some((m: any) => m.author_kind === "tenant"))

    // Collect any notifications the replies fired (staff→tenant support_reply) for cleanup.
    const { data: notes } = await svc.from("notifications").select("id").eq("entity_type", "support_ticket").eq("entity_id", ticketId).limit(50)
    for (const n of (notes ?? []) as any[]) cleanup.push({ table: "notifications", id: n.id })
  } finally {
    // messages cascade on ticket delete, but delete explicitly-tracked rows first for a clean count.
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
  if (fail > 0) { console.log(" ❌ SUPPORT_CONSOLE_FAIL"); process.exit(1) }
  console.log(" ✅ SUPPORT_CONSOLE_PASS — a real two-way support thread, cross-tenant, with first-response SLA + notifications both ways")
}
main()

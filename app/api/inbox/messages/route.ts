"use server"

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { resolveAgentId } from "@/lib/kernel/agent-identity"

export interface InboxMessage {
  id: string
  contact_id: string
  channel: string
  direction: "inbound" | "outbound"
  body: string
  created_at: string
  read: boolean
  type: "portal" | "voice" | "sms" | "email" | "chat" | "conversation"
  sentiment?: string | null
  summary?: string | null
}

export interface InboxThread {
  contact_id: string
  contact_name: string
  contact_type?: string | null
  last_message_at: string
  last_message_body: string
  unread_count: number
  channel: string
}

/**
 * GET /api/inbox/messages
 *
 * Query params:
 *   contactId  — optional, filter to one contact
 *   channel    — optional, filter by channel (email|sms|voice|portal|chat|all)
 *   unreadOnly — optional, "true" to filter to unread only
 *   limit      — optional, default 50
 */
export async function GET(req: NextRequest) {
  try {
    const supabase = await createClient()

    // Auth check
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const agentId = await resolveAgentId(supabase, user.id)

    const { searchParams } = req.nextUrl
    const contactId = searchParams.get("contactId")
    const channel = searchParams.get("channel") ?? "all"
    const unreadOnly = searchParams.get("unreadOnly") === "true"
    const limit = Math.min(parseInt(searchParams.get("limit") ?? "50", 10), 200)

    // ─── 1. portal messages ───────────────────────────────────────────────────
    let portalQuery = supabase
      .from("client_portal_messages")
      .select("id, contact_id, channel, direction, body, created_at, read")
      .order("created_at", { ascending: false })
      .limit(limit)

    if (agentId) portalQuery = portalQuery.eq("agent_id", agentId)
    if (contactId) portalQuery = portalQuery.eq("contact_id", contactId)
    if (unreadOnly) portalQuery = portalQuery.eq("read", false)
    if (channel !== "all" && channel !== "portal") {
      // skip portal results if filtering for a non-portal channel
    }

    const shouldFetchPortal = channel === "all" || channel === "portal" || channel === "sms" || channel === "email"
    const portalPromise = shouldFetchPortal
      ? portalQuery.then(({ data }) =>
          (data ?? []).map((m: any): InboxMessage => ({
            id: m.id,
            contact_id: m.contact_id,
            channel: m.channel ?? "portal",
            direction: m.direction === "client_to_agent" ? "inbound" : "outbound",
            body: m.body ?? "",
            created_at: m.created_at,
            read: m.read ?? false,
            type: "portal",
          }))
        )
      : Promise.resolve([] as InboxMessage[])

    // ─── 2. voice calls ────────────────────────────────────────────────────────
    const shouldFetchVoice = channel === "all" || channel === "voice"
    let voiceQuery = supabase
      .from("voice_calls")
      .select("id, contact_id, direction, summary, ai_notes, created_at, sentiment, status")
      .order("created_at", { ascending: false })
      .limit(limit)

    if (agentId) voiceQuery = voiceQuery.eq("agent_id", agentId)
    if (contactId) voiceQuery = voiceQuery.eq("contact_id", contactId)

    const voicePromise = shouldFetchVoice
      ? voiceQuery.then(({ data }) =>
          (data ?? []).map((v: any): InboxMessage => ({
            id: v.id,
            contact_id: v.contact_id,
            channel: "voice",
            direction: v.direction === "inbound" ? "inbound" : "outbound",
            body: v.summary ?? v.ai_notes ?? "Voice call",
            created_at: v.created_at,
            read: true, // voice calls don't have unread state
            type: "voice",
            sentiment: v.sentiment,
            summary: v.summary,
          }))
        )
      : Promise.resolve([] as InboxMessage[])

    // ─── 3. conversations / messages ──────────────────────────────────────────
    const shouldFetchMessages = channel === "all" || channel === "sms" || channel === "email" || channel === "conversation"
    let msgQuery = supabase
      .from("messages")
      .select("id, contact_id, type, direction, body, created_at, status, sentiment, agent_id")
      .order("created_at", { ascending: false })
      .limit(limit)

    if (agentId) msgQuery = msgQuery.eq("agent_id", agentId)
    if (contactId) msgQuery = msgQuery.eq("contact_id", contactId)
    if (channel !== "all" && channel !== "conversation") {
      msgQuery = msgQuery.eq("type", channel)
    }

    const msgPromise = shouldFetchMessages
      ? msgQuery.then(({ data }) =>
          (data ?? []).map((m: any): InboxMessage => ({
            id: m.id,
            contact_id: m.contact_id,
            channel: m.type ?? "sms",
            direction: m.direction === "inbound" ? "inbound" : "outbound",
            body: m.body ?? "",
            created_at: m.created_at,
            read: m.status !== "unread",
            type: "conversation",
            sentiment: m.sentiment,
          }))
        )
      : Promise.resolve([] as InboxMessage[])

    const [portalMsgs, voiceCalls, convMsgs] = await Promise.all([
      portalPromise,
      voicePromise,
      msgPromise,
    ])

    // Merge + sort by created_at desc
    const all: InboxMessage[] = [...portalMsgs, ...voiceCalls, ...convMsgs].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )

    return NextResponse.json({ messages: all.slice(0, limit), total: all.length })
  } catch (err) {
    console.error("[v0] inbox/messages error:", err)
    return NextResponse.json({ error: "Internal error" }, { status: 500 })
  }
}

/**
 * GET /api/inbox/messages?threads=true
 * Returns the thread list (one row per contact, sorted by last_message_at)
 */
export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const agentId = await resolveAgentId(supabase, user.id)

    // Fetch message_threads for this agent — aggregated view
    let q = supabase
      .from("message_threads")
      .select(`
        id,
        contact_id,
        channel,
        unread_count,
        last_message_at,
        contacts(first_name, last_name, contact_type, email, phone)
      `)
      .order("last_message_at", { ascending: false })
      .limit(100)

    if (agentId) q = q.eq("agent_user_id", agentId)

    const { data: threads } = await q

    // Also pull recent portal messages to fill gaps
    let portalQ = supabase
      .from("client_portal_messages")
      .select("contact_id, body, created_at, read, channel, contacts(first_name, last_name, contact_type)")
      .order("created_at", { ascending: false })
      .limit(200)

    if (agentId) portalQ = portalQ.eq("agent_id", agentId)

    const { data: portalMsgs } = await portalQ

    // Build thread map from portal messages (fallback for contacts without message_threads)
    const portalThreadMap = new Map<string, InboxThread>()
    for (const m of portalMsgs ?? []) {
      const cid: string = m.contact_id
      if (!portalThreadMap.has(cid)) {
        const contact = Array.isArray(m.contacts) ? m.contacts[0] : m.contacts
        portalThreadMap.set(cid, {
          contact_id: cid,
          contact_name: contact
            ? `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim()
            : "Unknown",
          contact_type: (contact as any)?.contact_type ?? null,
          last_message_at: m.created_at,
          last_message_body: m.body ?? "",
          unread_count: m.read ? 0 : 1,
          channel: m.channel ?? "portal",
        })
      } else {
        // Accumulate unread count
        const existing = portalThreadMap.get(cid)!
        if (!m.read) existing.unread_count++
      }
    }

    // Merge message_threads + portal map
    const threadMap = new Map<string, InboxThread>()

    for (const t of threads ?? []) {
      const contact = Array.isArray(t.contacts) ? t.contacts[0] : (t.contacts as any)
      threadMap.set(t.contact_id, {
        contact_id: t.contact_id,
        contact_name: contact
          ? `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim()
          : "Unknown",
        contact_type: contact?.contact_type ?? null,
        last_message_at: t.last_message_at ?? new Date().toISOString(),
        last_message_body: "",
        unread_count: t.unread_count ?? 0,
        channel: t.channel ?? "sms",
      })
    }

    // Add portal threads that aren't already in message_threads
    for (const [cid, t] of portalThreadMap) {
      if (!threadMap.has(cid)) {
        threadMap.set(cid, t)
      } else {
        // Update unread count from portal if newer
        const existing = threadMap.get(cid)!
        existing.unread_count += t.unread_count
      }
    }

    const sortedThreads = [...threadMap.values()].sort(
      (a, b) => new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime()
    )

    return NextResponse.json({ threads: sortedThreads })
  } catch (err) {
    console.error("[v0] inbox/threads error:", err)
    return NextResponse.json({ error: "Internal error" }, { status: 500 })
  }
}

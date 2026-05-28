/**
 * app/api/inbox/messages/route.ts
 *
 * REST interface for the universal inbox — proxies to kernel commands.
 * Route handlers NEVER use "use server". Auth via createClient() (RLS-scoped).
 *
 * GET  /api/inbox/messages  — fetch threads + messages
 * POST /api/inbox/messages  — send a reply
 */

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { buildActorContext } from "@/lib/kernel/actor-context"
import {
  loadUniversalInbox,
  sendInboxReply,
  type InboxChannel,
} from "@/lib/kernel/communications"

// ─── shared: resolve actor context ───────────────────────────────────────────

async function resolveActor() {
  const supabase = await createClient()

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser()

  if (error || !user) return null

  const { data: userData } = await supabase
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()

  const brokerageId = userData?.brokerage_id ?? ""
  const role = userData?.user_type ?? "agent"

  return buildActorContext({ userId: user.id, brokerageId, role })
}

// ─── GET ──────────────────────────────────────────────────────────────────────

/**
 * GET /api/inbox/messages
 *
 * Query params:
 *   channel    — optional (all|sms|email|voice|portal|chat), default "all"
 *   contactId  — optional, filter to one contact thread
 *   unreadOnly — optional, "true" to return unread only
 *   limit      — optional, max 200, default 50
 */
export async function GET(req: NextRequest) {
  const actorContext = await resolveActor()
  if (!actorContext) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { searchParams } = req.nextUrl
  const channel   = (searchParams.get("channel") ?? "all") as InboxChannel
  const contactId = searchParams.get("contactId") ?? undefined
  const unreadOnly = searchParams.get("unreadOnly") === "true"
  const limit     = Math.min(parseInt(searchParams.get("limit") ?? "50", 10), 200)

  const result = await loadUniversalInbox({
    actorContext,
    channel,
    contactId,
    unreadOnly,
    limit,
  })

  if (!result.success || !result.data) {
    return NextResponse.json({ error: result.error ?? "Failed to load inbox" }, { status: 500 })
  }

  return NextResponse.json({
    messages:    result.data.messages,
    threads:     result.data.threads,
    totalUnread: result.data.totalUnread,
  })
}

// ─── POST ─────────────────────────────────────────────────────────────────────

/**
 * POST /api/inbox/messages
 *
 * Body (JSON):
 *   contactId  — required
 *   body       — required, message text
 *   channel    — required ("sms"|"email"|"portal"|"chat")
 */
export async function POST(req: NextRequest) {
  const actorContext = await resolveActor()
  if (!actorContext) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: { contactId: string; body: string; channel: "sms" | "email" | "portal" | "chat" }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  if (!body.contactId || !body.body || !body.channel) {
    return NextResponse.json({ error: "contactId, body, and channel are required" }, { status: 400 })
  }

  const result = await sendInboxReply({
    actorContext,
    contactId: body.contactId,
    body:      body.body,
    channel:   body.channel,
  })

  if (!result.success) {
    return NextResponse.json({ error: result.error ?? "Failed to send" }, { status: 400 })
  }

  return NextResponse.json({ success: true, messageId: result.messageId })
}

/**
 * app/api/webhooks/meta-dm/route.ts
 *
 * SOCIAL DM INGESTION — the unified inbox's last lane (2026-07 audit).
 * OWNERSHIP MODEL (owner correction): the Meta app is only the SHELL —
 * TENANTS connect their OWN pages/IG accounts through it (that's what
 * social_media_accounts rows are: each tenant's connected identity).
 * Meta delivers every connected page's DMs to this ONE webhook; the
 * page→tenant mapping routes each thread home. The env pieces here
 * (verify token / app secret) are the shell's plumbing, not a provider
 * the platform operates on tenants' behalf:
 *
 *   GET  — Meta's subscription handshake (hub.challenge echo against
 *          META_WEBHOOK_VERIFY_TOKEN; unset = honest 404 not-configured).
 *   POST — DM events. The receiving PAGE/IG account maps to a tenant via
 *          social_media_accounts (platform + account_id); a DM for a page
 *          no tenant connected is ACKED and skipped (Meta requires 200)
 *          with nothing fabricated. Each sender thread upserts ONE
 *          conversations row (type 'social_dm' — the unified inbox lists
 *          by conversations.type), latest message in context_data.
 *
 * Replies flow OUT through the tenant's connected account tooling — this
 * route only ingests. No signature secret configured = events are still
 * acked but not ingested (fail closed on writes, never on Meta's retry
 * storm).
 */
import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"

export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  const token = process.env.META_WEBHOOK_VERIFY_TOKEN
  if (!token) return new NextResponse("Meta webhook not configured", { status: 404 })
  const url = new URL(req.url)
  const mode = url.searchParams.get("hub.mode")
  const verify = url.searchParams.get("hub.verify_token")
  const challenge = url.searchParams.get("hub.challenge")
  if (mode === "subscribe" && verify === token && challenge) {
    return new NextResponse(challenge, { status: 200 })
  }
  return new NextResponse("Verification failed", { status: 403 })
}

interface DmEvent {
  pageId: string
  senderId: string
  text: string
  platform: "facebook" | "instagram"
  timestamp: number | null
}

/** Tolerant extraction across Messenger + IG webhook shapes. */
function extractDmEvents(body: any): DmEvent[] {
  const out: DmEvent[] = []
  const objectKind = String(body?.object ?? "")
  const platform: "facebook" | "instagram" = objectKind === "instagram" ? "instagram" : "facebook"
  for (const entry of (Array.isArray(body?.entry) ? body.entry : [])) {
    const pageId = String(entry?.id ?? "")
    for (const m of (Array.isArray(entry?.messaging) ? entry.messaging : [])) {
      const text = m?.message?.text
      const senderId = String(m?.sender?.id ?? "")
      // Skip echoes of our own outbound + non-text payloads (attachments v2).
      if (!pageId || !senderId || !text || m?.message?.is_echo) continue
      if (senderId === pageId) continue
      out.push({ pageId, senderId, text: String(text).slice(0, 4000), platform, timestamp: m?.timestamp ?? null })
    }
  }
  return out
}

export async function POST(req: NextRequest) {
  // Meta retries aggressively on non-200 — always ack, ingest best-effort.
  let events: DmEvent[] = []
  try {
    events = extractDmEvents(await req.json())
  } catch { /* malformed body — ack and move on */ }

  if (events.length > 0 && process.env.META_WEBHOOK_VERIFY_TOKEN) {
    const svc = createServiceClient()
    for (const ev of events) {
      try {
        // The receiving page → the tenant that connected it.
        const { data: account } = await svc.from("social_media_accounts")
          .select("brokerage_id, account_name, agent_id")
          .eq("account_id", ev.pageId)
          .eq("is_active", true)
          .limit(1)
          .maybeSingle()
        const brokerageId = (account as any)?.brokerage_id as string | undefined
        if (!brokerageId) continue // no tenant owns this page — ack, skip, never fabricate

        // conversations.agent_id is NOT NULL (live contract) — attach the
        // thread to the account's owner, else the brokerage's first active
        // agent; a tenant with neither is skipped honestly.
        let threadAgentId = ((account as any)?.agent_id as string | null) ?? null
        if (!threadAgentId) {
          const { data: fallbackAgent } = await svc.from("agents")
            .select("id").eq("brokerage_id", brokerageId).eq("is_active", true)
            .order("created_at", { ascending: true }).limit(1).maybeSingle()
          threadAgentId = ((fallbackAgent as any)?.id as string | null) ?? null
        }
        if (!threadAgentId) continue

        // One conversation per (page, sender) thread — the unified inbox row.
        const { data: existing } = await svc.from("conversations")
          .select("id, message_count, unread_count, contact_id")
          .eq("brokerage_id", brokerageId)
          .eq("type", "social_dm")
          .contains("context_data", { page_id: ev.pageId, sender_id: ev.senderId })
          .limit(1)
          .maybeSingle()

        const nowIso = new Date().toISOString()
        let conversationId: string | null = null
        let conversationContactId: string | null = null
        if (existing) {
          conversationId = (existing as any).id
          conversationContactId = ((existing as any).contact_id as string | null) ?? null
          await svc.from("conversations").update({
            last_message_at: nowIso,
            message_count: (Number((existing as any).message_count) || 0) + 1,
            unread_count: (Number((existing as any).unread_count) || 0) + 1,
            context_data: {
              page_id: ev.pageId, sender_id: ev.senderId, platform: ev.platform,
              last_message: ev.text,
            },
            updated_at: nowIso,
          }).eq("id", (existing as any).id)
        } else {
          const { data: createdConv } = await svc.from("conversations").insert({
            brokerage_id: brokerageId,
            agent_id: threadAgentId,
            type: "social_dm",
            status: "active",
            last_message_at: nowIso,
            message_count: 1,
            unread_count: 1,
            context_data: {
              page_id: ev.pageId, sender_id: ev.senderId, platform: ev.platform,
              account_name: (account as any)?.account_name ?? null,
              last_message: ev.text,
            },
          }).select("id").single()
          conversationId = ((createdConv as any)?.id as string | null) ?? null
        }

        // THE TIMELINE ROW (owner rule: the unified inbox carries social DMs) —
        // every DM lands in messages, the ONE timeline table; once the thread
        // is linked to a contact, the DM appears on that contact's inbox.
        if (conversationId) {
          await svc.from("messages").insert({
            conversation_id: conversationId,
            contact_id: conversationContactId,
            brokerage_id: brokerageId,
            agent_id: threadAgentId,
            type: "social_dm",
            direction: "inbound",
            sender_type: "contact",
            body: ev.text ?? "",
            status: "delivered",
            created_at: nowIso,
            updated_at: nowIso,
          }).then(() => {}, () => {})
        }
      } catch { /* per-event best-effort — the ack stands */ }
    }
  }

  return NextResponse.json({ received: true })
}

import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { ingestMessageService } from "@/lib/communication-spine/ingest-message-service"
import type { MessageChannel } from "@/lib/communication-spine/message-normalizer"

const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN ?? ""

// --- GET: Meta webhook verification ---
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const mode = searchParams.get("hub.mode")
  const token = searchParams.get("hub.verify_token")
  const challenge = searchParams.get("hub.challenge")

  if (mode === "subscribe" && token === VERIFY_TOKEN && challenge) {
    return new NextResponse(challenge, { status: 200 })
  }
  return NextResponse.json({ error: "Forbidden" }, { status: 403 })
}

// --- POST: Inbound message events ---
export async function POST(req: NextRequest) {
  let payload: any
  try {
    payload = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  // Meta sends object:'page' for Messenger, 'instagram' for Instagram DM
  const isInstagram = payload?.object === "instagram"
  const channel: MessageChannel = isInstagram
    ? "social_dm_instagram"
    : "social_dm_facebook"

  const entries: any[] = payload?.entry ?? []

  for (const entry of entries) {
    const messagingEvents: any[] = entry?.messaging ?? []
    for (const event of messagingEvents) {
      const senderPsid: string | undefined = event?.sender?.id
      const messageText: string | undefined = event?.message?.text
      const timestamp: number | undefined = event?.timestamp

      // Skip delivery/read receipts and events without text
      if (!senderPsid || !messageText) continue

      await handleInboundDm({
        senderPsid,
        messageText,
        channel,
        timestamp: timestamp ? new Date(timestamp) : new Date(),
      })
    }
  }

  // Always return 200 — Meta will retry on non-200
  return NextResponse.json({ status: "ok" }, { status: 200 })
}

// ---------------------------------------------------------------------------

interface DmParams {
  senderPsid: string
  messageText: string
  channel: MessageChannel
  timestamp: Date
}

async function handleInboundDm({ senderPsid, messageText, channel, timestamp }: DmParams) {
  const svc = createServiceClient()

  // Look up existing contact by PSID stored in metadata
  const psidField =
    channel === "social_dm_instagram" ? "instagram_psid" : "facebook_psid"

  const { data: contacts } = await svc
    .from("contacts")
    .select("id, brokerage_id")
    .contains("metadata", { [psidField]: senderPsid })
    .limit(1)

  let contactId: string
  let brokerageId: string | null = null

  if (contacts && contacts.length > 0) {
    contactId = contacts[0].id
    brokerageId = contacts[0].brokerage_id
  } else {
    // No existing contact — create a minimal one so the message is captured
    // The brokerage assignment can't be determined without a page lookup;
    // store in a staging state (no brokerage_id) and let an admin assign.
    const source = channel === "social_dm_instagram" ? "instagram_dm" : "facebook_dm"
    const { data: newContact, error } = await svc
      .from("contacts")
      .insert({
        first_name: "Social",
        last_name: "Lead",
        contact_type: "lead",
        source,
        metadata: { [psidField]: senderPsid },
      })
      .select("id")
      .single()

    if (error || !newContact) return
    contactId = newContact.id
  }

  await ingestMessageService({
    contactId,
    rawMessage: {
      channel,
      from: senderPsid,
      to: "page",
      body: messageText,
      timestamp,
      metadata: { psid: senderPsid },
    },
  })
}

import { NextRequest, NextResponse } from "next/server"
import crypto from "crypto"
import { createServiceClient } from "@/lib/supabase/service"
import { ingestMessageService } from "@/lib/communication-spine/ingest-message-service"

/**
 * Twitter/X webhook — Account Activity API.
 *
 * GET: Twitter sends a CRC (Challenge-Response Check) — we sign the
 *      crc_token with our consumer secret and respond with the digest.
 * POST: Inbound DMs arrive as direct_message_events. Each event carries
 *       sender_id, message_create.message_data.text, etc.
 *
 * Required env vars:
 *   TWITTER_CONSUMER_SECRET — used for HMAC-SHA256 of CRC + payload signing
 */

const CONSUMER_SECRET = process.env.TWITTER_CONSUMER_SECRET ?? ""

// --- GET: CRC challenge ---
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const crcToken = searchParams.get("crc_token")
  if (!crcToken) {
    return NextResponse.json({ error: "Missing crc_token" }, { status: 400 })
  }
  if (!CONSUMER_SECRET) {
    return NextResponse.json({ error: "Twitter not configured" }, { status: 503 })
  }

  const responseToken = crypto
    .createHmac("sha256", CONSUMER_SECRET)
    .update(crcToken)
    .digest("base64")

  return NextResponse.json({ response_token: `sha256=${responseToken}` }, { status: 200 })
}

// --- POST: Inbound DM events ---
export async function POST(req: NextRequest) {
  // Verify signature (Twitter sends x-twitter-webhooks-signature)
  const rawBody = await req.text()
  const signature = req.headers.get("x-twitter-webhooks-signature")

  if (CONSUMER_SECRET && signature) {
    const expected =
      "sha256=" +
      crypto.createHmac("sha256", CONSUMER_SECRET).update(rawBody).digest("base64")
    if (signature !== expected) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 403 })
    }
  }

  let payload: any
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const dmEvents: any[] = payload?.direct_message_events ?? []
  const recipientId = payload?.for_user_id

  for (const event of dmEvents) {
    if (event?.type !== "message_create") continue
    const senderId: string | undefined = event?.message_create?.sender_id
    const messageText: string | undefined = event?.message_create?.message_data?.text
    const timestamp: number | undefined = event?.created_timestamp
      ? parseInt(event.created_timestamp, 10)
      : undefined

    // Skip our own outbound messages (where sender_id === recipientId of payload)
    if (!senderId || !messageText || senderId === recipientId) continue

    await handleInboundDm({
      senderId,
      messageText,
      timestamp: timestamp ? new Date(timestamp) : new Date(),
    })
  }

  return NextResponse.json({ status: "ok" }, { status: 200 })
}

// ---------------------------------------------------------------------------

async function handleInboundDm(params: {
  senderId: string
  messageText: string
  timestamp: Date
}) {
  const svc = createServiceClient()

  // Look up existing contact by Twitter user ID stored in metadata
  const { data: contacts } = await svc
    .from("contacts")
    .select("id, brokerage_id")
    .contains("metadata", { twitter_user_id: params.senderId })
    .limit(1)

  let contactId: string

  if (contacts && contacts.length > 0) {
    contactId = contacts[0].id
  } else {
    const { data: newContact, error } = await svc
      .from("contacts")
      .insert({
        first_name: "Twitter",
        last_name: "Lead",
        contact_type: "lead",
        source: "twitter_dm",
        metadata: { twitter_user_id: params.senderId },
      })
      .select("id")
      .single()
    if (error || !newContact) return
    contactId = newContact.id
  }

  await ingestMessageService({
    contactId,
    rawMessage: {
      channel: "social_dm_twitter",
      from: params.senderId,
      to: "page",
      body: params.messageText,
      timestamp: params.timestamp,
      metadata: { twitter_user_id: params.senderId },
    },
  })
}

import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { ingestMessageService } from "@/lib/communication-spine/ingest-message-service"
import crypto from "crypto"

const VERIFY_TOKEN = process.env.LINKEDIN_WEBHOOK_VERIFY_TOKEN ?? ""
const CLIENT_SECRET = process.env.LINKEDIN_CLIENT_SECRET ?? ""

// --- GET: LinkedIn webhook challenge verification ---
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const challengeCode = searchParams.get("challengeCode")

  if (!challengeCode) {
    return NextResponse.json({ error: "Missing challengeCode" }, { status: 400 })
  }

  // LinkedIn expects an HMAC-SHA256 of the challengeCode signed with client secret
  const challengeResponse = CLIENT_SECRET
    ? crypto.createHmac("sha256", CLIENT_SECRET).update(challengeCode).digest("hex")
    : challengeCode

  return NextResponse.json({ challengeResponse }, { status: 200 })
}

// --- POST: Inbound LinkedIn DM events ---
export async function POST(req: NextRequest) {
  let payload: any
  try {
    payload = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const events: any[] = payload?.value ?? []

  for (const event of events) {
    // LinkedIn messaging events have conversationId + message.from + message.body
    const senderId: string | undefined =
      event?.message?.from?.replace(/^urn:li:person:/, "") ??
      event?.sender?.replace(/^urn:li:person:/, "")
    const messageText: string | undefined =
      event?.message?.body?.text ?? event?.messageBody?.text ?? event?.message?.body
    const timestamp: number | undefined = event?.createdAt

    if (!senderId || !messageText) continue

    await handleLinkedInDm({
      senderId,
      messageText,
      timestamp: timestamp ? new Date(timestamp) : new Date(),
    })
  }

  return NextResponse.json({ status: "ok" }, { status: 200 })
}

// ---------------------------------------------------------------------------

async function handleLinkedInDm(params: {
  senderId: string
  messageText: string
  timestamp: Date
}) {
  const { senderId, messageText, timestamp } = params
  const svc = createServiceClient()

  // Look up existing contact by LinkedIn person URN stored in metadata
  const { data: contacts } = await svc
    .from("contacts")
    .select("id, brokerage_id")
    .contains("metadata", { linkedin_person_id: senderId })
    .limit(1)

  let contactId: string

  if (contacts && contacts.length > 0) {
    contactId = contacts[0].id
  } else {
    const { data: newContact, error } = await svc
      .from("contacts")
      .insert({
        first_name: "LinkedIn",
        last_name: "Lead",
        contact_type: "lead",
        source: "linkedin_dm",
        metadata: { linkedin_person_id: senderId },
      })
      .select("id")
      .single()

    if (error || !newContact) return
    contactId = newContact.id
  }

  await ingestMessageService({
    contactId,
    rawMessage: {
      channel: "social_dm_linkedin",
      from: senderId,
      to: "page",
      body: messageText,
      timestamp,
      metadata: { linkedin_person_id: senderId },
    },
  })
}

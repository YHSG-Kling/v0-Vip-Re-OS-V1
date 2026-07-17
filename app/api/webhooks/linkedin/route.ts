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
    // Receiving side of the DM — the connected page/org this event was delivered to.
    // Used to resolve which brokerage owns the conversation.
    const recipientId: string | undefined = (
      event?.message?.to ?? event?.recipient ?? event?.owner ?? undefined
    )?.replace?.(/^urn:li:(person|organization|organizationBrand):/, "")

    if (!senderId || !messageText) continue

    await handleLinkedInDm({
      senderId,
      recipientId,
      messageText,
      timestamp: timestamp ? new Date(timestamp) : new Date(),
    })
  }

  return NextResponse.json({ status: "ok" }, { status: 200 })
}

// ---------------------------------------------------------------------------

async function handleLinkedInDm(params: {
  senderId: string
  recipientId?: string
  messageText: string
  timestamp: Date
}) {
  const { senderId, recipientId, messageText, timestamp } = params
  const svc = createServiceClient()

  // tenant anchor (scope burn-down): resolve which brokerage owns the receiving
  // LinkedIn account so the identity match + new-contact insert are tenant-stamped.
  let brokerageId: string | null = null
  if (recipientId) {
    const { data: acct } = await svc
      .from("social_media_accounts")
      .select("brokerage_id")
      .eq("platform", "linkedin")
      .eq("account_id", recipientId)
      .eq("is_active", true)
      .limit(1)
      .maybeSingle()
    brokerageId = (acct as { brokerage_id: string | null } | null)?.brokerage_id ?? null
  }

  // Look up existing contact by LinkedIn person URN stored in metadata —
  // scoped to the resolved brokerage when the webhook carried one; otherwise the
  // person URN is a unique-ish identity and the match stays capped at one row.
  let contactQuery = svc
    .from("contacts")
    .select("id, brokerage_id")
    .contains("metadata", { linkedin_person_id: senderId })
    .limit(1)
  if (brokerageId) contactQuery = contactQuery.eq("brokerage_id", brokerageId)
  const { data: contacts } = await contactQuery

  let contactId: string

  if (contacts && contacts.length > 0) {
    contactId = contacts[0].id
  } else {
    // tenant anchor (scope burn-down): stamp the resolved brokerage; when the
    // receiving account can't be mapped the row stays in staging (null tenant)
    // for an admin to assign, same as the Meta webhook.
    const { data: newContact, error } = await svc
      .from("contacts")
      .insert({
        brokerage_id: brokerageId,
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

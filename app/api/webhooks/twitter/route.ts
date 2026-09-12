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
  // Verify signature (Twitter sends x-twitter-webhooks-signature).
  //
  // THIS CHECK USED TO FAIL OPEN: `if (CONSUMER_SECRET && signature)` meant an
  // unset env var OR a simply-omitted header skipped verification entirely and
  // the body was ingested as a real DM — the exact fail-open shape
  // lib/cron-auth.ts's docblock was written to prevent, and it is reachable by
  // anyone who knows the URL (this handler writes into the tenant inbox via
  // ingestMessageService). Now: no secret configured = 503 "not configured",
  // matching the CRC handler above (line 27); missing or wrong signature = 403.
  const rawBody = await req.text()
  const signature = req.headers.get("x-twitter-webhooks-signature")

  if (!CONSUMER_SECRET) {
    return NextResponse.json({ error: "Twitter not configured" }, { status: 503 })
  }
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", CONSUMER_SECRET).update(rawBody).digest("base64")
  const sigBuf = Buffer.from(signature ?? "")
  const expBuf = Buffer.from(expected)
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 403 })
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
      recipientId,
      messageText,
      timestamp: timestamp ? new Date(timestamp) : new Date(),
    })
  }

  return NextResponse.json({ status: "ok" }, { status: 200 })
}

// ---------------------------------------------------------------------------

async function handleInboundDm(params: {
  senderId: string
  /** payload.for_user_id — the connected account this event was delivered for. */
  recipientId?: string
  messageText: string
  timestamp: Date
}) {
  const svc = createServiceClient()

  // tenant anchor (scope burn-down): resolve which brokerage connected the
  // receiving Twitter/X account so the identity match + insert are tenant-stamped.
  let brokerageId: string | null = null
  if (params.recipientId) {
    const { data: acct } = await svc
      .from("social_media_accounts")
      .select("brokerage_id")
      .eq("platform", "twitter")
      .eq("account_id", params.recipientId)
      .eq("is_active", true)
      .limit(1)
      .maybeSingle()
    brokerageId = (acct as { brokerage_id: string | null } | null)?.brokerage_id ?? null
  }

  // Look up existing contact by Twitter user ID stored in metadata — scoped to
  // the resolved brokerage when the account could be mapped; the user id is a
  // unique-ish identity so the unresolved path stays a limit(1) match.
  let contactQuery = svc
    .from("contacts")
    .select("id, brokerage_id")
    .contains("metadata", { twitter_user_id: params.senderId })
  // AMBIGUITY IS NOT A MATCH (tenant fail-closed, CLAUDE.md §4). The tenant
  // predicate below is CONDITIONAL — applied only when the receiving account could
  // be mapped to a brokerage — so on the unresolved path the query ran with NO
  // tenant boundary at all, on the SERVICE client, and `.limit(1)` handed back
  // whichever brokerage's row happened to sort first. The same person can be a
  // contact at two brokerages (app/api/webhooks/inbound-mail/route.ts documents
  // exactly that), and this identity feeds a message INSERT — so the wrong first
  // row files a client's inbound message into another tenant's CRM. limit(2) +
  // "one distinct tenant or nothing" is the rule already in force in
  // app/api/webhooks/sendgrid-events/route.ts; unresolved falls through to the
  // staging insert with a null tenant, this handler's documented behaviour for an
  // unmappable account.
    .limit(2)
  if (brokerageId) contactQuery = contactQuery.eq("brokerage_id", brokerageId)
  const { data: contactRows } = await contactQuery
  const candidates = (contactRows ?? []) as Array<{ id: string; brokerage_id: string | null }>
  const contacts = new Set(candidates.map((c) => c.brokerage_id)).size === 1 ? candidates : []

  let contactId: string

  if (contacts.length > 0) {
    contactId = contacts[0].id
  } else {
    // tenant anchor (scope burn-down): stamp the resolved brokerage; unresolved
    // events stay in staging (null tenant) for an admin to assign.
    const { data: newContact, error } = await svc
      .from("contacts")
      .insert({
        brokerage_id: brokerageId,
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

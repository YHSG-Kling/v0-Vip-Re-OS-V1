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
    // entry.id is the receiving page (Messenger) / IG business account id —
    // the key that maps this event to the brokerage that connected the page.
    const pageId: string | undefined = entry?.id
    const messagingEvents: any[] = entry?.messaging ?? []
    for (const event of messagingEvents) {
      const senderPsid: string | undefined = event?.sender?.id
      const messageText: string | undefined = event?.message?.text
      const timestamp: number | undefined = event?.timestamp

      // Skip delivery/read receipts and events without text
      if (!senderPsid || !messageText) continue

      await handleInboundDm({
        senderPsid,
        pageId,
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
  pageId?: string
  messageText: string
  channel: MessageChannel
  timestamp: Date
}

async function handleInboundDm({ senderPsid, pageId, messageText, channel, timestamp }: DmParams) {
  const svc = createServiceClient()

  // tenant anchor (scope burn-down): resolve which brokerage connected the
  // receiving page/IG account so the identity match + insert are tenant-stamped.
  let brokerageId: string | null = null
  if (pageId) {
    const { data: acct } = await svc
      .from("social_media_accounts")
      .select("brokerage_id")
      .eq("platform", channel === "social_dm_instagram" ? "instagram" : "facebook")
      .eq("account_id", pageId)
      .eq("is_active", true)
      .limit(1)
      .maybeSingle()
    brokerageId = (acct as { brokerage_id: string | null } | null)?.brokerage_id ?? null
  }

  // Look up existing contact by PSID stored in metadata — scoped to the
  // resolved brokerage when the page could be mapped; PSIDs are page-scoped
  // unique so the unresolved path stays a limit(1) identity match.
  const psidField =
    channel === "social_dm_instagram" ? "instagram_psid" : "facebook_psid"

  let contactQuery = svc
    .from("contacts")
    .select("id, brokerage_id")
    .contains("metadata", { [psidField]: senderPsid })
  // AMBIGUITY IS NOT A MATCH (tenant fail-closed, CLAUDE.md §4). The tenant
  // predicate here is CONDITIONAL — applied only when the receiving account could
  // be mapped to a brokerage — so on the unresolved path the query ran with no
  // tenant boundary at all, on the SERVICE client, and `.limit(1)` then handed back
  // whichever brokerage's row happened to sort first. The same person can be a
  // contact at two brokerages (see app/api/webhooks/inbound-mail/route.ts, which
  // documents exactly that), and this identity feeds a message INSERT — so the
  // wrong first row files a client's inbound DM into another tenant's CRM.
  // limit(2) + "one distinct tenant or nothing" is the rule already in force in
  // app/api/webhooks/sendgrid-events/route.ts; unresolved falls through to the
  // staging insert with a null tenant, which is this handler's documented
  // behaviour for an unmappable account.
    .limit(2)
  if (brokerageId) contactQuery = contactQuery.eq("brokerage_id", brokerageId)
  const { data: contactRows } = await contactQuery
  const candidates = (contactRows ?? []) as Array<{ id: string; brokerage_id: string | null }>
  const contacts = new Set(candidates.map((c) => c.brokerage_id)).size === 1 ? candidates : []

  let contactId: string

  if (contacts.length > 0) {
    contactId = contacts[0].id
    brokerageId = brokerageId ?? contacts[0].brokerage_id
  } else {
    // No existing contact — create a minimal one so the message is captured.
    // tenant anchor (scope burn-down): stamp the brokerage resolved from the
    // receiving page; when the page can't be mapped the row stays in a staging
    // state (null tenant) for an admin to assign.
    const source = channel === "social_dm_instagram" ? "instagram_dm" : "facebook_dm"
    const { data: newContact, error } = await svc
      .from("contacts")
      .insert({
        brokerage_id: brokerageId,
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

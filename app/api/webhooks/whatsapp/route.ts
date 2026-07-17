import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { ingestMessageService } from "@/lib/communication-spine/ingest-message-service"

/**
 * WhatsApp Business webhook — Meta's Cloud API.
 *
 * Verification: shares Meta's hub.challenge / hub.verify_token pattern
 * with Messenger/Instagram, but the message payload shape is different
 * (entry[].changes[].value.messages instead of entry[].messaging).
 *
 * Required env: META_VERIFY_TOKEN (shared with /api/webhooks/meta) or
 * a separate WHATSAPP_VERIFY_TOKEN if the brokerage wants isolation.
 */

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN ?? process.env.META_VERIFY_TOKEN ?? ""

// --- GET: Hub challenge verification ---
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

// --- POST: WhatsApp message events ---
export async function POST(req: NextRequest) {
  let payload: any
  try {
    payload = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  // Meta sends object: 'whatsapp_business_account'
  if (payload?.object !== "whatsapp_business_account") {
    return NextResponse.json({ status: "ok" }, { status: 200 })
  }

  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value
      if (!value) continue

      // Status updates (delivered/read receipts) — skip
      if (value?.statuses) continue

      // The receiving business number — the key that maps this event to the
      // brokerage that connected the WhatsApp Business account.
      const businessNumberId: string | undefined =
        value?.metadata?.phone_number_id ?? value?.metadata?.display_phone_number

      const messages: any[] = value?.messages ?? []
      for (const msg of messages) {
        const senderWaId: string | undefined = msg?.from
        // Text messages — most common; ignore media/audio/etc. for V1
        const messageText: string | undefined =
          msg?.text?.body ??
          msg?.button?.text ??
          msg?.interactive?.button_reply?.title ??
          msg?.interactive?.list_reply?.title

        const timestamp: number | undefined = msg?.timestamp
          ? parseInt(msg.timestamp, 10) * 1000
          : undefined

        if (!senderWaId || !messageText) continue

        await handleInboundWhatsapp({
          senderWaId,
          businessNumberId,
          messageText,
          timestamp: timestamp ? new Date(timestamp) : new Date(),
        })
      }
    }
  }

  return NextResponse.json({ status: "ok" }, { status: 200 })
}

// ---------------------------------------------------------------------------

async function handleInboundWhatsapp(params: {
  senderWaId: string  // E.164 phone digits without + (e.g. "14155551234")
  /** value.metadata.phone_number_id — the receiving business number. */
  businessNumberId?: string
  messageText: string
  timestamp: Date
}) {
  const svc = createServiceClient()

  // tenant anchor (scope burn-down): resolve which brokerage connected the
  // receiving WhatsApp Business number so identity matches + the insert are
  // tenant-stamped.
  let brokerageId: string | null = null
  if (params.businessNumberId) {
    const { data: acct } = await svc
      .from("social_media_accounts")
      .select("brokerage_id")
      .eq("platform", "whatsapp")
      .eq("account_id", params.businessNumberId)
      .eq("is_active", true)
      .limit(1)
      .maybeSingle()
    brokerageId = (acct as { brokerage_id: string | null } | null)?.brokerage_id ?? null
  }

  // WhatsApp ID is the recipient's phone number — we can match against
  // contacts.phone (digits-only comparison) OR metadata.whatsapp_id
  const phoneDigits = params.senderWaId.replace(/\D/g, "")

  let contactId: string | null = null

  // Try metadata match first — scoped to the resolved brokerage when the
  // business number could be mapped; the WhatsApp ID is a unique-ish identity
  // (E.164 phone) so the unresolved path stays a limit(1) match.
  let metaQuery = svc
    .from("contacts")
    .select("id")
    .contains("metadata", { whatsapp_id: params.senderWaId })
    .limit(1)
  if (brokerageId) metaQuery = metaQuery.eq("brokerage_id", brokerageId)
  const { data: byMeta } = await metaQuery
  if (byMeta && byMeta.length > 0) {
    contactId = byMeta[0].id
  }

  // Fallback: phone-digits match (strip + and non-digits, compare last 10) —
  // same brokerage scoping as the metadata match above.
  if (!contactId && phoneDigits.length >= 10) {
    const last10 = phoneDigits.slice(-10)
    let phoneQuery = svc
      .from("contacts")
      .select("id, phone")
      .ilike("phone", `%${last10}%`)
      .limit(1)
    if (brokerageId) phoneQuery = phoneQuery.eq("brokerage_id", brokerageId)
    const { data: byPhone } = await phoneQuery
    if (byPhone && byPhone.length > 0) {
      contactId = byPhone[0].id
      // Backfill the WhatsApp ID into metadata for future direct matching
      await svc
        .from("contacts")
        .update({
          metadata: { whatsapp_id: params.senderWaId },
        })
        .eq("id", contactId)
    }
  }

  // Create new contact if none matched.
  // tenant anchor (scope burn-down): stamp the resolved brokerage; unresolved
  // events stay in staging (null tenant) for an admin to assign.
  if (!contactId) {
    const { data: newContact, error } = await svc
      .from("contacts")
      .insert({
        brokerage_id: brokerageId,
        first_name: "WhatsApp",
        last_name: "Lead",
        contact_type: "lead",
        source: "whatsapp_business",
        phone: `+${phoneDigits}`,
        metadata: { whatsapp_id: params.senderWaId },
      })
      .select("id")
      .single()
    if (error || !newContact) return
    contactId = newContact.id
  }

  if (!contactId) return

  await ingestMessageService({
    contactId,
    rawMessage: {
      channel: "social_dm_whatsapp",
      from: params.senderWaId,
      to: "business",
      body: params.messageText,
      timestamp: params.timestamp,
      metadata: { whatsapp_id: params.senderWaId },
    },
  })
}

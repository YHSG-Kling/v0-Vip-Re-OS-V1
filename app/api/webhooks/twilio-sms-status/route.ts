/**
 * app/api/webhooks/twilio-sms-status/route.ts
 *
 * TWILIO SMS STATUS CALLBACK — the truth channel for the SMS lane.
 *
 * Before this existed, Twilio's create response was the LAST thing the OS ever heard
 * about a text: it returns "queued", the dispatcher reported success, and every SMS
 * read as sent forever. Carrier rejection — a landline, a disconnected number, a
 * blocked sender, a spam filter — arrives ONLY here, minutes later. So a client who
 * never got the message was indistinguishable from one who did, on the seller report,
 * in the touch caps, and in the broker's trust in autonomy.
 *
 * Auth: shared secret (?secret= / x-webhook-secret) against
 * TWILIO_STATUS_WEBHOOK_SECRET — unset = 404, following the sendgrid-events and
 * meta-dm pattern: never a silently-open endpoint. Twilio also signs requests
 * (X-Twilio-Signature); the shared secret is used here because the callback URL is
 * minted by this app and the secret travels in it, so it is verifiable without
 * reconstructing Twilio's canonical string across proxy rewrites.
 *
 * Correlation is EXACT on both writes: MessageSid is the same id sendViaTwilio
 * returned, which recordOutcomeClaim stored as provider_ref and which the sender
 * stores in messages.metadata.twilio_sid. No fuzzy recipient matching is needed or
 * wanted for this lane — unlike email, an SMS thread has one provider id per row.
 *
 * Always ACKs 200 — a non-2xx makes Twilio retry, and a retry storm on a bad row
 * loses every OTHER message's truth behind it. Twilio posts form-encoded.
 */

import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { ingestProviderTruth } from "@/lib/outcomes/reconciliation-ledger"
import { recordProviderEventOnLog } from "@/lib/outcomes/provider-event-fanout"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Twilio SMS status → the messages.status vocabulary the inbox chips render. */
const INBOX_STATUS: Record<string, string> = {
  delivered: "delivered",
  undelivered: "failed",
  failed: "failed",
  canceled: "failed",
  sent: "sent",
}

export async function POST(request: NextRequest) {
  const secret = process.env.TWILIO_STATUS_WEBHOOK_SECRET
  if (!secret) return NextResponse.json({ error: "not found" }, { status: 404 })
  const given = request.nextUrl.searchParams.get("secret") ?? request.headers.get("x-webhook-secret")
  if (given !== secret) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  let sid = ""
  let status = ""
  let errorCode: string | null = null
  try {
    const form = await request.formData()
    sid = String(form.get("MessageSid") ?? form.get("SmsSid") ?? "")
    status = String(form.get("MessageStatus") ?? form.get("SmsStatus") ?? "").toLowerCase()
    const code = form.get("ErrorCode")
    errorCode = code ? String(code) : null
  } catch {
    // Malformed body: ACK anyway. Twilio must not retry something we cannot parse.
    return NextResponse.json({ ok: true, ignored: "unparseable body" })
  }
  if (!sid || !status) return NextResponse.json({ ok: true, ignored: "missing sid or status" })

  const now = new Date().toISOString()

  // 1. Reconcile the claim. An unknown sid no-ops — it is a message this OS did not
  //    send (a console test, another environment on the same account), and inventing
  //    a ledger row for it would record a touch that never came from us.
  const recon = await ingestProviderTruth({
    channel: "sms",
    providerRef: sid,
    truth: { status, at: now, detail: errorCode ? { error_code: errorCode } : null },
  })

  // 1b. Stamp the DISPATCH AUDIT ROW with the provider's own time and verdict.
  //     message_provider_logs carries `sent_at` (when WE handed it over) and
  //     `event_at` (when the PROVIDER reported back). Only the first was ever
  //     written, so the delivery rate on the system-health board was computed
  //     entirely from what the sender CLAIMED — a carrier rejection minutes
  //     later never touched it. Correlated on the same MessageSid the ledger
  //     already matched, scoped to the brokerage that claim resolved to.
  const logged = await recordProviderEventOnLog(createServiceClient(), {
    providerMessageId: sid,
    providerEvent: status,
    providerStatus: INBOX_STATUS[status] === "failed" ? "failed" : "sent",
    at: now,
    brokerageId: recon.brokerageId ?? null,
  })
  if (logged.refusal) {
    // A refused audit write is not "the provider said nothing" — say which.
    console.error("[twilio-sms-status] provider log stamp refused:", logged.refusal)
  }

  // 2. Mirror onto the inbox thread, so the agent sees the truth where they work.
  //    Correlated by the same sid the send stored in metadata.
  // SCOPED BY TENANT, from the ledger row rather than trusted from the provider.
  // test:tenant-scope refused the unscoped version and was right to: the platform
  // runs Twilio as SUBACCOUNTS under one master, so two tenants can share an
  // account and "a sid is globally unique" is not a tenancy boundary. No matching
  // claim means no brokerage, which means nothing to mirror.
  let inboxUpdated = false
  const mapped = INBOX_STATUS[status]
  if (mapped && recon.brokerageId) {
    try {
      const svc = createServiceClient()
      // messages has NO provider-id column — only metadata jsonb. Correlate the
      // way the SendGrid webhook already does: containment on the key the send
      // stored. (Caught by test:schema-drift: the first draft filtered on a
      // messages.provider_message_id that does not exist, which would have matched
      // nothing and silently mirrored no status at all.)
      const { data: msg } = await svc
        .from("messages")
        .select("id, status")
        .eq("brokerage_id", recon.brokerageId)
        .contains("metadata", { twilio_sid: sid })
        .limit(1)
        .maybeSingle()
      if (msg) {
        const row = msg as { id: string; status: string | null }
        // Never downgrade: a late 'sent' after 'delivered' must not erase delivery.
        const rank: Record<string, number> = { sent: 1, delivered: 2, read: 3, failed: 2 }
        const current = rank[row.status ?? ""] ?? 0
        if ((rank[mapped] ?? 0) >= current) {
          await svc.from("messages").update({ status: mapped, updated_at: now }).eq("id", row.id)
          inboxUpdated = true
        }
      }
    } catch {
      // The reconciliation already landed; a mirror failure must not un-ACK.
    }
  }

  return NextResponse.json({
    ok: true,
    sid,
    status,
    verdict: recon.verdict,
    escalated: recon.escalated,
    inboxUpdated,
  })
}

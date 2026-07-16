/**
 * app/api/webhooks/sendgrid-events/route.ts
 *
 * SENDGRID EVENT WEBHOOK — delivered/read for the unified inbox (owner
 * rule: email entries carry delivered/read) + suppression hygiene on
 * bounces/complaints. Auth: shared secret (?secret= / x-webhook-secret)
 * against SENDGRID_WEBHOOK_SECRET — unset = 404 (the meta-dm pattern:
 * never a silently-open endpoint). Correlation, honestly: when the send
 * stored a provider message id (messages.metadata->sg_message_id) we
 * match exactly; else we match the RECIPIENT's most recent outbound
 * email message within 72h — correct in practice for 1:1 mail, and a
 * non-match simply no-ops (never mislabels). Always ACKs 200 so
 * SendGrid doesn't retry-storm.
 */

import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const STATUS_BY_EVENT: Record<string, string> = {
  delivered: "delivered",
  open: "read",
  click: "read", // a click implies the mail was read
  bounce: "bounced",
  dropped: "failed",
  spamreport: "bounced",
}

// email_tracking is the engagement event stream (lead-nurture scoring + bundle
// attribution both read it) — live CHECK vocabulary for event_type.
const TRACKING_EVENT: Record<string, string> = {
  delivered: "delivered",
  open: "open",
  click: "click",
  bounce: "bounce",
  dropped: "dropped",
  spamreport: "spam_complaint",
}

export async function POST(request: NextRequest) {
  const secret = process.env.SENDGRID_WEBHOOK_SECRET
  if (!secret) return NextResponse.json({ error: "not found" }, { status: 404 })
  const given = request.nextUrl.searchParams.get("secret") ?? request.headers.get("x-webhook-secret")
  if (given !== secret) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  let events: any[] = []
  try {
    const body = await request.json()
    events = Array.isArray(body) ? body : []
  } catch {
    return NextResponse.json({ ok: true, processed: 0 })
  }

  const svc = createServiceClient()
  let processed = 0

  for (const ev of events.slice(0, 200)) {
    try {
      const kind = String(ev?.event ?? "")
      const status = STATUS_BY_EVENT[kind]
      const email = String(ev?.email ?? "").trim().toLowerCase()
      if (!status || !email) continue

      // Suppression hygiene FIRST — a spam COMPLAINT never gets re-mailed
      // (the exact reason the vocabulary has; bounces get the status chip +
      // recovery rail instead of a mislabeled suppression reason).
      if (kind === "spamreport") {
        try {
          const { addToSuppressionList } = await import("@/lib/platform/suppression-list")
          await addToSuppressionList({ email, reason: "spam_complaint", notes: "SendGrid spamreport event webhook" })
        } catch { /* hygiene is best-effort */ }
      }

      // Exact correlation when the send stored the provider id.
      const sgId = String(ev?.sg_message_id ?? "").split(".")[0]
      let matched = false
      if (sgId) {
        const { data: exact } = await svc.from("messages")
          .select("id, status")
          .contains("metadata", { sg_message_id: sgId })
          .limit(1).maybeSingle()
        if (exact) {
          await svc.from("messages").update({ status, updated_at: new Date().toISOString() }).eq("id", (exact as any).id)
          matched = true
        }
      }

      // ENGAGEMENT STREAM (burn-down round 3): open/click land as email_tracking
      // rows — the writer-less half of the SendGrid loop. Contact-correlated
      // (brokerage stamped from the contact); email_send_id stays NULL when the
      // send didn't record a provider id — honest partial correlation.
      const trackingType = TRACKING_EVENT[kind]
      const { data: trackContacts } = await svc.from("contacts")
        .select("id, brokerage_id").ilike("email", email).limit(1)
      const trackContact = ((trackContacts ?? []) as any[])[0] ?? null
      if (trackingType && trackContact) {
        await svc.from("email_tracking").insert({
          contact_id: trackContact.id,
          brokerage_id: trackContact.brokerage_id ?? null,
          event_type: trackingType,
          url: kind === "click" ? (String(ev?.url ?? "") || null) : null,
          user_agent: String(ev?.useragent ?? "") || null,
          metadata: { sg_message_id: sgId || null, sg_event_id: String(ev?.sg_event_id ?? "") || null },
          event_at: ev?.timestamp ? new Date(Number(ev.timestamp) * 1000).toISOString() : new Date().toISOString(),
        })
      }

      // Fallback: the recipient's most recent outbound email within 72h.
      // 'read' never downgrades to 'delivered'; terminal failures always win.
      if (!matched) {
        const since = new Date(Date.now() - 72 * 3_600_000).toISOString()
        const { data: contacts } = await svc.from("contacts")
          .select("id").ilike("email", email).limit(5)
        const ids = ((contacts ?? []) as any[]).map((c) => c.id)
        if (ids.length > 0) {
          const { data: msg } = await svc.from("messages")
            .select("id, status")
            .in("contact_id", ids)
            .eq("type", "email")
            .eq("direction", "outbound")
            .gte("created_at", since)
            .order("created_at", { ascending: false })
            .limit(1).maybeSingle()
          if (msg && !((msg as any).status === "read" && status === "delivered")) {
            await svc.from("messages").update({ status, updated_at: new Date().toISOString() }).eq("id", (msg as any).id)
            matched = true
          }
        }
      }
      if (matched) processed++
    } catch { /* per-event best-effort — the ack stands */ }
  }

  return NextResponse.json({ ok: true, processed })
}

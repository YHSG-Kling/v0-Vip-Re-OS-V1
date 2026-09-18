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
import { resolveUnambiguousTenant } from "@/lib/kernel/unambiguous-tenant"
import { fanOutEmailEngagement, recordProviderEventOnLog } from "@/lib/outcomes/provider-event-fanout"

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

// The verdict a NON-engagement event carries for message_provider_logs.
// Its vocabulary is the one the five inserters already write and that
// app/actions/system-health.ts aggregates — 'sent' | 'failed' | 'bounced' —
// so a provider verdict lands in the same words as a sender claim and the
// health board can compare them.
const DELIVERY_EVENT: Record<string, string> = {
  delivered: "sent",
  bounce: "bounced",
  spamreport: "bounced",
  dropped: "failed",
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
      // The provider id is the ONLY authoritative link between an event and a tenant.
      // Everything below is scoped to the brokerage it yields, because a recipient
      // email address is not unique across tenants.
      let eventBrokerageId: string | null = null
      if (sgId) {
        const { data: exact } = await svc.from("messages")
          .select("id, status, brokerage_id")
          .contains("metadata", { sg_message_id: sgId })
          .limit(1).maybeSingle()
        if (exact) {
          eventBrokerageId = ((exact as any).brokerage_id as string | null) ?? null
          await svc.from("messages").update({ status, updated_at: new Date().toISOString() }).eq("id", (exact as any).id)
          matched = true
        }
      }

      // ENGAGEMENT STREAM (burn-down round 3): open/click land as email_tracking
      // rows — the writer-less half of the SendGrid loop. Contact-correlated
      // (brokerage stamped from the contact); email_send_id stays NULL when the
      // send didn't record a provider id — honest partial correlation.
      const trackingType = TRACKING_EVENT[kind]
      // Was .ilike("email", …).limit(1) with no tenant predicate, so an open/click was
      // attributed to whichever tenant's contact happened to sort first. Scope to the
      // brokerage the send came from; without one, only an unambiguous match counts.
      let trackQuery = svc.from("contacts").select("id, brokerage_id").ilike("email", email)
      if (eventBrokerageId) trackQuery = trackQuery.eq("brokerage_id", eventBrokerageId)
      // ONE SPELLING OF THE RULE (§6): this used to build its own Set and test
      // `size === 1` here, and again forty lines down, and again in
      // app/api/webhooks/inbound-mail/route.ts. Survivor:
      // lib/kernel/unambiguous-tenant.ts:resolveUnambiguousTenant. Same answer —
      // one distinct brokerage_id across the candidates, or nothing.
      const { data: trackContacts } = await trackQuery.limit(2)
      const trackMatch = resolveUnambiguousTenant(
        (trackContacts ?? []) as Array<{ id: string; brokerage_id: string | null }>,
      )
      const trackContact = trackMatch.ok ? trackMatch.rows[0] : null
      const eventAt = ev?.timestamp
        ? new Date(Number(ev.timestamp) * 1000).toISOString()
        : new Date().toISOString()

      // ── THE PER-SEND LEDGERS, walked back from the provider id ─────────────
      // This webhook already landed the engagement STREAM (email_tracking) and
      // the inbox chip (messages.status), and stopped there. The rows that
      // recorded the outbound — newsletter_sends, sequence_step_executions,
      // open_house_invitations, email_sends, message_provider_logs — carried
      // opened_at/clicked_at/event_at columns that every reporting surface in
      // the product reads and that NOTHING wrote, so a real campaign rendered a
      // permanent 0% open / 0% click to the agent deciding what to send next.
      // Correlation is exact on the id we ourselves stored at send time; an id
      // we never stored matches nothing and no-ops.
      let fanout: Awaited<ReturnType<typeof fanOutEmailEngagement>> | null = null
      if ((kind === "open" || kind === "click") && sgId) {
        fanout = await fanOutEmailEngagement(svc, {
          providerMessageId: sgId,
          kind,
          at: eventAt,
          brokerageId: eventBrokerageId ?? trackContact?.brokerage_id ?? null,
        })
        // A REFUSED per-send write is not "nobody engaged" — that conflation is
        // the exact failure this fan-out exists to close, so it is said aloud.
        if (fanout.refusals.length > 0) {
          console.error("[sendgrid-events] per-send engagement stamp refused:", fanout.refusals.join(" | "))
        }
      } else if (sgId && DELIVERY_EVENT[kind]) {
        // Delivery / bounce / drop: no per-send engagement column, but the
        // dispatch audit row still gets the PROVIDER'S time and verdict, which
        // is the pair app/actions/system-health.ts:534 documents as unwritten.
        const logged = await recordProviderEventOnLog(svc, {
          providerMessageId: sgId,
          providerEvent: kind,
          providerStatus: DELIVERY_EVENT[kind],
          at: eventAt,
          brokerageId: eventBrokerageId,
        })
        if (logged.refusal) console.error("[sendgrid-events] provider log stamp refused:", logged.refusal)
      }

      if (trackingType && trackContact) {
        await svc.from("email_tracking").insert({
          contact_id: trackContact.id,
          brokerage_id: trackContact.brokerage_id ?? null,
          event_type: trackingType,
          // THE ATTRIBUTION LEG. app/api/cron/bundle-attribution-rollup/route.ts
          // walks outcomes.email.message_id → email_sends.id →
          // email_tracking.email_send_id, and this column was NULL on every row
          // ever written, so that leg counted zero opens for every dispatch it
          // has ever measured. Null stays honest when the send recorded no
          // provider id — a partial correlation, never a guessed one.
          email_send_id: fanout?.emailSendId ?? null,
          url: kind === "click" ? (String(ev?.url ?? "") || null) : null,
          user_agent: String(ev?.useragent ?? "") || null,
          metadata: { sg_message_id: sgId || null, sg_event_id: String(ev?.sg_event_id ?? "") || null },
          event_at: eventAt,
        })

        // BEHAVIOURAL EVENT LOG — email_open (3 pts) / email_click (10 pts) in the
        // scored vocabulary (lib/lead-scoring/behavioral-events). This is the lane
        // the old agent-session-gated tracker could never serve: a webhook holds no
        // session, so opens and clicks previously never reached the canonical
        // scorer's behavioural 30%. Identity is trackContact — resolved above from
        // the provider event's recipient, unambiguous-tenant rule applied — never
        // from the request body. The recorder logs refused writes as not-recorded.
        if ((kind === "open" || kind === "click") && trackContact.brokerage_id) {
          const { recordBehavioralEvent } = await import("@/lib/lead-scoring/record-behavioral-event")
          await recordBehavioralEvent({
            brokerageId: trackContact.brokerage_id,
            contactId: trackContact.id,
            eventType: kind === "open" ? "email_open" : "email_click",
            eventData: {
              sg_message_id: sgId || null,
              url: kind === "click" ? (String(ev?.url ?? "") || null) : null,
            },
            occurredAt: ev?.timestamp ? new Date(Number(ev.timestamp) * 1000).toISOString() : undefined,
          })
        }
      }

      // Fallback: the recipient's most recent outbound email within 72h.
      // 'read' never downgrades to 'delivered'; terminal failures always win.
      if (!matched) {
        const since = new Date(Date.now() - 72 * 3_600_000).toISOString()
        // Same rule for the recency fallback: contact ids collected across tenants were
        // fed straight into a messages UPDATE, so a status write could land on another
        // tenant's row. Only correlate within a known brokerage.
        let contactQuery = svc.from("contacts").select("id, brokerage_id").ilike("email", email)
        if (eventBrokerageId) contactQuery = contactQuery.eq("brokerage_id", eventBrokerageId)
        const { data: contacts } = await contactQuery.limit(5)
        // Same one-distinct-tenant rule as the engagement stream above, and the
        // same survivor — lib/kernel/unambiguous-tenant.ts. limit(5) rather than
        // limit(2) because this arm wants EVERY id in the tenant, not one.
        const fallbackMatch = resolveUnambiguousTenant(
          (contacts ?? []) as Array<{ id: string; brokerage_id: string | null }>,
        )
        const ids = fallbackMatch.ok ? fallbackMatch.rows.map((c) => c.id) : []
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

/**
 * app/api/webhooks/lob-events/route.ts
 *
 * LOB EVENT WEBHOOK — the truth channel for the DIRECT MAIL lane.
 *
 * lob_order_id was already stored on direct_mail_campaigns by five different writers,
 * and nothing ever read Lob's tracking. So the OS knew Lob had ACCEPTED an order and
 * called that "sent" — while a piece that was re-routed, or returned to sender, or
 * whose PDF failed to render, stayed "sent" forever. Direct mail is the most
 * expensive touch this platform makes and the one a broker is most likely to be asked
 * about ("did the neighbourhood actually get my postcard?").
 *
 * A physical piece takes days, so the in-flight events matter as much as the terminal
 * ones: created → rendered_pdf → in_transit → in_local_area → processed_for_delivery.
 * Only processed_for_delivery is confirmation; returned_to_sender and deleted are
 * contradictions. re_routed is in-flight, not failure — the USPS forwarded it.
 *
 * Auth: shared secret (?secret= / x-webhook-secret) against LOB_WEBHOOK_SECRET —
 * unset = 404, the same never-silently-open pattern as sendgrid-events. Always ACKs
 * 200 so Lob does not retry-storm.
 */

import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { ingestProviderTruth } from "@/lib/outcomes/reconciliation-ledger"
import { TRUTH_SOURCES } from "@/lib/outcomes/reconciliation"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** The campaign status a terminal Lob event implies. In-flight events leave it be —
 *  a campaign flipping between statuses as a piece crosses the country is noise. */
function campaignStatusFor(eventType: string): string | null {
  const spec = TRUTH_SOURCES.direct_mail
  if (spec.confirms.includes(eventType)) return "delivered"
  if (spec.contradicts.includes(eventType)) return "failed"
  return null
}

export async function POST(request: NextRequest) {
  const secret = process.env.LOB_WEBHOOK_SECRET
  if (!secret) return NextResponse.json({ error: "not found" }, { status: 404 })
  const given = request.nextUrl.searchParams.get("secret") ?? request.headers.get("x-webhook-secret")
  if (given !== secret) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  let body: any
  try { body = await request.json() } catch {
    return NextResponse.json({ ok: true, ignored: "unparseable body" })
  }

  // Lob's envelope: { event_type: { id: "postcard.processed_for_delivery" },
  //                   body: { id: "psc_...", ... }, date_created }
  const eventType: string =
    (typeof body?.event_type === "string" ? body.event_type : body?.event_type?.id) ?? ""
  const pieceId: string = body?.body?.id ?? body?.resource_id ?? ""
  const at: string = body?.date_created ?? new Date().toISOString()

  if (!eventType || !pieceId) {
    return NextResponse.json({ ok: true, ignored: "missing event_type or piece id" })
  }

  // 1. Reconcile. An unknown piece id no-ops — not ours to record.
  const recon = await ingestProviderTruth({
    channel: "direct_mail",
    providerRef: pieceId,
    truth: {
      status: eventType,
      at,
      detail: {
        expected_delivery_date: body?.body?.expected_delivery_date ?? null,
        tracking_events: Array.isArray(body?.body?.tracking_events)
          ? body.body.tracking_events.length : null,
      },
    },
  })

  // 2. Mirror a TERMINAL outcome onto the campaign the agent looks at.
  let campaignUpdated = false
  const status = campaignStatusFor(eventType)
  if (status) {
    try {
      const svc = createServiceClient()
      const { data } = await svc
        .from("direct_mail_campaigns")
        .update({ status })
        .eq("lob_order_id", pieceId)
        .select("id")
      campaignUpdated = ((data ?? []) as unknown[]).length > 0
    } catch {
      // Reconciliation already landed; a mirror failure must not un-ACK.
    }
  }

  return NextResponse.json({
    ok: true,
    pieceId,
    eventType,
    verdict: recon.verdict,
    escalated: recon.escalated,
    campaignUpdated,
  })
}

import { NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { ingestMetaLeadByRef } from "@/lib/ads/ad-lead-intake"

/**
 * app/api/webhooks/meta-leadgen/route.ts
 *
 * Meta Lead Ads webhook. A lead-form submission IS the prospect's opt-in, so each
 * inbound lead becomes a CONSENTED CONTACT (tcpa_consent=true) — not an
 * unconsented `leads` row — which is what unlocks avatar-video follow-up and
 * ad-audience membership downstream.
 *
 * GET  — Meta subscription verification (hub.challenge echo).
 * POST — leadgen change events. Meta sends a leadgen_id; the full field_data is
 *        fetched from the Graph API with the page token (resolveLeadFields). For
 *        non-Meta callers / tests, field_data may be posted inline.
 */
export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const url = new URL(request.url)
  const mode = url.searchParams.get("hub.mode")
  const token = url.searchParams.get("hub.verify_token")
  const challenge = url.searchParams.get("hub.challenge")
  if (mode === "subscribe" && token && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
    return new NextResponse(challenge ?? "", { status: 200 })
  }
  return new NextResponse("forbidden", { status: 403 })
}

export async function POST(request: Request) {
  let body: any
  try { body = await request.json() } catch { return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 }) }

  const svc = createServiceClient()
  const entries = Array.isArray(body?.entry) ? body.entry : []
  let ingested = 0
  let parked = 0

  for (const entry of entries) {
    const pageId = String(entry.id ?? "")
    for (const change of entry.changes ?? []) {
      if (change.field !== "leadgen") continue
      const v = change.value ?? {}
      const leadgenId = v.leadgen_id ? String(v.leadgen_id) : null
      const inlineFields = Array.isArray(v.field_data) ? v.field_data : null

      // ONE ingest path, shared with the reconciler (never drifts).
      const res = await ingestMetaLeadByRef(svc, {
        pageId,
        leadgenId,
        formId: v.form_id ? String(v.form_id) : null,
        inlineFields,
      })
      if (res.ok) { ingested++; continue }

      // INGRESS CONTINUITY: a PAID lead that couldn't land (page not mapped
      // yet, transient Graph failure, fields not available yet) is PARKED for
      // the daily reconciler — never lost behind this 200. Only a lead with a
      // leadgen_id (or captured fields) is replayable; 'rejected' (no
      // email/phone in the form) is a terminal fact, not a stuck flow.
      if (res.stage !== "rejected" && (leadgenId || inlineFields)) {
        const { parkIngressEvent } = await import("@/lib/kernel/ingress-continuity")
        const r = await parkIngressEvent(svc, {
          provider: "meta",
          eventKind: "meta_lead_received",
          externalRef: leadgenId ?? `inline:${pageId}:${v.form_id ?? "unknown"}`,
          payload: { pageId, leadgenId, formId: v.form_id ? String(v.form_id) : null, field_data: inlineFields ?? null, stage: res.stage },
        })
        if (r.parked) parked++
      }
    }
  }
  return NextResponse.json({ ok: true, ingested, parked })
}

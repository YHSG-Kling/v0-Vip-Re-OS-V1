import { NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { ingestMetaLeadByRef } from "@/lib/ads/ad-lead-intake"
import { metaSubscriptionHandshake, verifyMetaSignature } from "@/lib/meta/verify-signature"

/**
 * app/api/webhooks/meta-leadgen/route.ts
 *
 * Meta Lead Ads webhook. A lead-form submission IS the prospect's opt-in, so each
 * inbound lead becomes a CONSENTED CONTACT (tcpa_consent=true) — not an
 * unconsented `leads` row — which is what unlocks avatar-video follow-up and
 * ad-audience membership downstream.
 *
 * THAT IS EXACTLY WHY THE POST MUST BE VERIFIED. Until 2026-09-03 this handler
 * parsed `request.json()` from ANYONE and minted consented contacts from it —
 * an unauthenticated caller could fabricate TCPA consent for any phone number
 * and enrol it in outbound follow-up. Verification now runs through the ONE
 * Meta verifier (lib/meta/verify-signature.ts — X-Hub-Signature-256 over the
 * raw body, keyed by the App Secret; 503 when the secret is unset, 401 on a
 * mismatch; fail closed). The "non-Meta callers / tests may post field_data
 * inline" affordance survives only for a caller that signs with the App
 * Secret — a test must sign its fixture the way Meta would.
 *
 * GET  — Meta subscription verification (hub.challenge echo against the ONE
 *        verify token, META_WEBHOOK_VERIFY_TOKEN; fallbacks documented in the
 *        verifier).
 * POST — leadgen change events. Meta sends a leadgen_id; the full field_data is
 *        fetched from the Graph API with the page token (resolveLeadFields).
 */
export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  return metaSubscriptionHandshake(request)
}

export async function POST(request: Request) {
  // Raw body FIRST — the signature is over the exact bytes Meta sent.
  const rawBody = await request.text()
  const verdict = verifyMetaSignature(rawBody, request.headers.get("x-hub-signature-256"))
  if (!verdict.ok) return new NextResponse(verdict.reason, { status: verdict.status })

  let body: any
  try { body = JSON.parse(rawBody) } catch { return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 }) }

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

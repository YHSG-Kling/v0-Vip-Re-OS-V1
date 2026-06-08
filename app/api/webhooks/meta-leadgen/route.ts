import { NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { ingestConsentedAdLead } from "@/lib/ads/ad-lead-intake"

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

interface LeadField { name: string; values: string[] }

/** Resolve a leadgen_id to its submitted field_data via the Graph API. */
async function resolveLeadFields(leadgenId: string, pageToken: string): Promise<LeadField[]> {
  const res = await fetch(`https://graph.facebook.com/v19.0/${leadgenId}?access_token=${encodeURIComponent(pageToken)}`)
  if (!res.ok) throw new Error(`graph ${res.status}`)
  const json = (await res.json()) as { field_data?: LeadField[] }
  return json.field_data ?? []
}

function pick(fields: LeadField[], ...names: string[]): string | null {
  for (const n of names) {
    const f = fields.find((x) => x.name?.toLowerCase() === n)
    if (f?.values?.[0]) return f.values[0]
  }
  return null
}

export async function POST(request: Request) {
  let body: any
  try { body = await request.json() } catch { return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 }) }

  const svc = createServiceClient()
  const entries = Array.isArray(body?.entry) ? body.entry : []
  let ingested = 0

  for (const entry of entries) {
    const pageId = String(entry.id ?? "")
    for (const change of entry.changes ?? []) {
      if (change.field !== "leadgen") continue
      const v = change.value ?? {}
      // Map the Meta page → the brokerage that owns it.
      const { data: cred } = await svc.from("platform_credentials")
        .select("brokerage_id, access_token").eq("platform", "facebook").eq("account_id", pageId).maybeSingle()
      const c = cred as { brokerage_id?: string; access_token?: string } | null
      if (!c?.brokerage_id) continue

      // Inline field_data (tests) or fetch from Graph (production).
      let fields: LeadField[] = Array.isArray(v.field_data) ? v.field_data : []
      if (fields.length === 0 && v.leadgen_id && c.access_token) {
        try { fields = await resolveLeadFields(String(v.leadgen_id), c.access_token) } catch { continue }
      }
      if (fields.length === 0) continue

      const res = await ingestConsentedAdLead({
        brokerageId: c.brokerage_id,
        firstName:   pick(fields, "first_name", "full_name", "name"),
        lastName:    pick(fields, "last_name"),
        email:       pick(fields, "email"),
        phone:       pick(fields, "phone_number", "phone"),
        platform:    "facebook",
        formId:      v.form_id ? String(v.form_id) : null,
      }, svc)
      if (res.ok) ingested++
    }
  }
  return NextResponse.json({ ok: true, ingested })
}

// app/api/webhooks/exa/route.ts
// ─────────────────────────────────────────────────────────────────────────────
// EXA SEARCH MONITOR DELIVERIES (wave 151, lane 151D) — the signed webhook that turns a monitor's NEW
// results into the registered early-opportunity play (monitored deltas instead of repeated searches).
//
// AUTH: Exa-Signature (t=<seconds>,v1=<hex HMAC-SHA256 over `${t}.${rawBody}`>) verified by
// lib/providers/exa/monitors.ts verifyExaWebhookSignature against the monitor's SEALED secret
// (provider_monitors.webhook_secret_ciphertext, m969) or the EXA_WEBHOOK_SECRET fallback. No secret →
// 503; bad or stale (> 5 min) signature → 401 (fail closed — CLAUDE.md §4). The payload's monitor id
// only selects the secret; tenant and territory come from OUR registry row, never from the payload.
// A replay (same event id, 7 days) answers 200 replayed; an unregistered monitor 202 and nothing done.
//
// INGEST: the delivery's results walk lib/acquisition-plays/runner.ts → THE ONE RawData producer
// (lib/kernel/scraping.ts ingestRawSourceBatch) — no second raw-insert implementation, no provider call.
import { NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { handleExaWebhookDelivery } from "@/lib/providers/exa/monitors"

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  const rawBody = await request.text()
  const signatureHeader = request.headers.get("exa-signature")
  // The env fallback is a NAME — a monitor created by hand in the Exa dashboard; registered monitors verify with their sealed secret.
  const envSecret = process.env.EXA_WEBHOOK_SECRET ?? null
  if (!envSecret && !signatureHeader) {
    return NextResponse.json({ error: "unverifiable delivery: no Exa-Signature header and EXA_WEBHOOK_SECRET is unset" }, { status: 401 })
  }
  const supabase = createServiceClient()
  const r = await handleExaWebhookDelivery(supabase as never, { rawBody, signatureHeader, envSecret })
  return NextResponse.json(r.body, { status: r.status })
}

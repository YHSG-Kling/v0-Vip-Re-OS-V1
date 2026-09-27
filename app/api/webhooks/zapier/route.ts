import { type NextRequest, NextResponse } from "next/server"
import { createHmac, timingSafeEqual } from "crypto"
import { createServiceClient } from "@/lib/supabase/service"
import { recordLifecycleEvent } from "@/lib/events/lifecycle-event-core"

// ─────────────────────────────────────────────────────────────────────────────
// ZAPIER WEBHOOK HANDLER
// HMAC-SHA256 signature verified against ZAPIER_WEBHOOK_SECRET env var.
//
// THE TENANT COMES FROM THE CONNECTION RECORD, NOT THE BODY (lane 86F, §4).
// The header above used to say "brokerage identity is NEVER taken solely from
// the payload; the signature ensures authenticity" — but ZAPIER_WEBHOOK_SECRET is
// ONE platform-wide secret, so the signature proves only that the sender holds
// it, and the code then took `payload.brokerage_id` verbatim: any holder could
// write (and dispatch) events into ANY tenant — the IDOR shape. Now the request
// must ALSO present the brokerage's own key in `x-zapier-api-key`, which is
// resolved against global_settings.zapier_api_key (the per-brokerage Zapier
// credential tenants set in Settings) on the service client; THAT row's
// brokerage_id is the tenant. A body brokerage_id is optional and, when sent,
// must equal it. The event is written and dispatched through the server-only core
// (lib/events/lifecycle-event-core.ts) — the old cookie-client helper was refused
// by RLS on every webhook and nothing dispatched.
// ─────────────────────────────────────────────────────────────────────────────

/** The brokerage whose global_settings.zapier_api_key equals the presented key —
 *  exactly one, or none (an ambiguous key names no tenant). */
async function brokerageForZapierKey(svc: any, key: string): Promise<{ ok: true; brokerageId: string } | { ok: false; status: number; error: string }> {
  if (!key) return { ok: false, status: 401, error: "Missing x-zapier-api-key — the brokerage's Zapier key names the tenant" }
  const { data, error } = await svc.from("global_settings").select("brokerage_id").eq("zapier_api_key", key).limit(2)
  if (error) return { ok: false, status: 503, error: "Zapier key lookup refused" }
  const rows = (data ?? []) as Array<{ brokerage_id: string | null }>
  if (rows.length !== 1 || !rows[0].brokerage_id) return { ok: false, status: 403, error: "Unknown Zapier key" }
  return { ok: true, brokerageId: rows[0].brokerage_id }
}

/**
 * Verifies the Zapier HMAC-SHA256 signature.
 *
 * Zapier sends the signature as: X-Zapier-Signature: sha256=<hex>
 * We compute HMAC-SHA256(secret, rawBody) and compare with timing-safe equality.
 */
async function verifyZapierSignature(request: NextRequest, rawBody: string): Promise<boolean> {
  const secret = process.env.ZAPIER_WEBHOOK_SECRET
  if (!secret) {
    // If no secret is configured, log a warning and reject all requests.
    // This prevents unauthenticated access even when the env var is missing.
    console.warn("[zapier-webhook] ZAPIER_WEBHOOK_SECRET is not set — rejecting request")
    return false
  }

  const signatureHeader = request.headers.get("x-zapier-signature") ?? ""
  // Zapier format: "sha256=<hex digest>"
  const expectedPrefix = "sha256="
  if (!signatureHeader.startsWith(expectedPrefix)) return false

  const receivedHex = signatureHeader.slice(expectedPrefix.length)

  const computed = createHmac("sha256", secret).update(rawBody, "utf-8").digest("hex")

  try {
    // timingSafeEqual requires equal-length buffers
    return timingSafeEqual(Buffer.from(computed, "hex"), Buffer.from(receivedHex, "hex"))
  } catch {
    return false
  }
}

export async function POST(request: NextRequest) {
  // Read raw body first (before parsing JSON) so we can verify the signature
  const rawBody = await request.text()

  const isValid = await verifyZapierSignature(request, rawBody)
  if (!isValid) {
    return NextResponse.json({ error: "Invalid or missing webhook signature" }, { status: 401 })
  }

  try {
    const payload = JSON.parse(rawBody)

    if (!payload.event_type) {
      return NextResponse.json({ error: "Missing required field: event_type" }, { status: 400 })
    }

    const svc = createServiceClient()
    const tenant = await brokerageForZapierKey(svc, request.headers.get("x-zapier-api-key") ?? "")
    if (!tenant.ok) return NextResponse.json({ error: tenant.error }, { status: tenant.status })
    if (payload.brokerage_id && payload.brokerage_id !== tenant.brokerageId) {
      return NextResponse.json({ error: "brokerage_id does not match the Zapier key's brokerage" }, { status: 403 })
    }

    const r = await recordLifecycleEvent(svc, tenant.brokerageId, {
      // Proven inside the tenant by the core, or written as NULL.
      user_id: payload.user_id,
      event_type: payload.event_type,
      payload: payload.data || {},
      source: "webhook",
      dedupe_key: payload.dedupe_key || `zapier_${payload.event_type}_${Date.now()}`,
    })
    if (!r.ok) {
      console.error("[zapier-webhook] event not recorded:", r.error)
      return NextResponse.json({ error: "Event not recorded" }, { status: 500 })
    }

    return NextResponse.json({ success: true, message: r.deduped ? "Duplicate event ignored" : "Event processed" })
  } catch (error) {
    console.error("[zapier-webhook] Error processing payload:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

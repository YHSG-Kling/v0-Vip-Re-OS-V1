import { type NextRequest, NextResponse } from "next/server"
import { createHmac, timingSafeEqual } from "crypto"
import { logEventAndTrigger } from "@/lib/events"

// ─────────────────────────────────────────────────────────────────────────────
// ZAPIER WEBHOOK HANDLER
// HMAC-SHA256 signature verified against ZAPIER_WEBHOOK_SECRET env var.
// Payload must include brokerage_id and event_type — brokerage identity is
// NEVER taken solely from the payload; the signature ensures authenticity.
// ─────────────────────────────────────────────────────────────────────────────

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

    // brokerage_id and event_type are required structural fields
    if (!payload.brokerage_id || !payload.event_type) {
      return NextResponse.json(
        { error: "Missing required fields: brokerage_id, event_type" },
        { status: 400 }
      )
    }

    await logEventAndTrigger({
      brokerage_id: payload.brokerage_id,
      user_id: payload.user_id,
      event_type: payload.event_type,
      payload: payload.data || {},
      source: "webhook",
      dedupe_key: payload.dedupe_key || `zapier_${payload.event_type}_${Date.now()}`,
    })

    return NextResponse.json({ success: true, message: "Event processed" })
  } catch (error) {
    console.error("[zapier-webhook] Error processing payload:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

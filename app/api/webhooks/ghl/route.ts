import { type NextRequest, NextResponse } from "next/server"
import { createHmac, timingSafeEqual } from "crypto"
import { ghlIntegration } from "@/lib/ghl-integration"

/**
 * GHL webhook signature verification. GHL is configured to sign each request
 * with HMAC-SHA256 of the raw body using GHL_WEBHOOK_SECRET. The signature
 * is sent as X-GHL-Signature (hex digest, no prefix).
 *
 * If the env var is not set, the endpoint REJECTS all requests — this is a
 * defensive default so an unconfigured deploy can't be exploited by any
 * caller POSTing to handleIncomingMessage().
 */
function verifyGHLSignature(rawBody: string, signatureHeader: string | null): boolean {
  const secret = process.env.GHL_WEBHOOK_SECRET
  if (!secret) {
    console.warn("[ghl-webhook] GHL_WEBHOOK_SECRET not set — rejecting request")
    return false
  }
  if (!signatureHeader) return false

  const computed = createHmac("sha256", secret).update(rawBody, "utf-8").digest("hex")
  try {
    const a = Buffer.from(computed, "hex")
    const b = Buffer.from(signatureHeader, "hex")
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text()
    const signatureHeader = req.headers.get("x-ghl-signature")

    if (!verifyGHLSignature(rawBody, signatureHeader)) {
      return NextResponse.json({ error: "Invalid or missing webhook signature" }, { status: 401 })
    }

    const webhookData = JSON.parse(rawBody)
    const result = await ghlIntegration.handleIncomingMessage(webhookData)

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("[ghl-webhook] error:", error)
    return NextResponse.json({ error: "Webhook processing failed" }, { status: 500 })
  }
}

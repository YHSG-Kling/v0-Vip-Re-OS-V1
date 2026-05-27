import { type NextRequest, NextResponse } from "next/server"
import { createHmac, timingSafeEqual } from "crypto"

// =====================================================
// GOHIGHLEVEL WEBHOOK HANDLER
// Receives events from GoHighLevel CRM.
//
// HMAC-SHA256 of raw body, verified against GHL_WEBHOOK_SECRET. Sent as
// X-GHL-Signature (hex digest). Rejects if env var or signature is missing
// so an unconfigured deploy can't be exploited by arbitrary POSTs that fire
// internal kernel events.
//
// Uses the service client because there is no user session — the RLS-enforced
// server client would block the brokerage lookup and event insert.
// =====================================================

function verifyGoHighLevelSignature(rawBody: string, signatureHeader: string | null): boolean {
  const secret = process.env.GHL_WEBHOOK_SECRET
  if (!secret) {
    console.warn("[gohighlevel-webhook] GHL_WEBHOOK_SECRET not set — rejecting request")
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

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text()
    const signatureHeader = request.headers.get("x-ghl-signature")

    if (!verifyGoHighLevelSignature(rawBody, signatureHeader)) {
      return NextResponse.json({ error: "Invalid or missing webhook signature" }, { status: 401 })
    }

    // GHL is SYNC-OUT ONLY. The app pushes contact/detail updates OUT to GoHighLevel; it
    // does NOT ingest CRM events back IN (no CRM syncs into the app — product decision).
    // We still verify the signature above so an unconfigured deploy isn't an open endpoint,
    // then acknowledge with a no-op so GHL stops retrying. No internal events are fired.
    console.info("[gohighlevel-webhook] inbound event ignored — GHL is one-way OUT only")
    return NextResponse.json({ success: true, message: "Ignored — GHL is sync-out only" }, { status: 200 })
  } catch (error) {
    console.error("[v0] Error processing GHL webhook:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

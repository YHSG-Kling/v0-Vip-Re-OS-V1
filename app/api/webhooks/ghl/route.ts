import { type NextRequest, NextResponse } from "next/server"
import { ghlIntegration } from "@/lib/ghl-integration"

export async function POST(req: NextRequest) {
  try {
    const webhookData = await req.json()

    // Verify webhook signature (if GHL provides one)
    const signature = req.headers.get("x-ghl-signature")
    if (signature && !verifyGHLSignature(signature, webhookData)) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 })
    }

    // Handle incoming message
    const result = await ghlIntegration.handleIncomingMessage(webhookData)

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("[v0] GHL webhook error:", error)
    return NextResponse.json({ error: "Webhook processing failed" }, { status: 500 })
  }
}

function verifyGHLSignature(signature: string, data: any): boolean {
  // Implement GHL signature verification
  // This would use HMAC SHA256 with your GHL webhook secret
  return true // Placeholder
}

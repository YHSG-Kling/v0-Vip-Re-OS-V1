import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { generateQRCode, trackMagnetEvent } from "@/lib/kernel/lead-magnets"

// POST /api/lead-magnets/qr/[magnetId]
// Input contract: { brokerageId, agentId, label, targetUrl }
// Output contract: GenerateQRCodeOutput
// Auth: required
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ magnetId: string }> }
) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
    }

    const { magnetId } = await params
    const body = await req.json()
    const { brokerageId, agentId, label, targetUrl } = body

    if (!brokerageId) return NextResponse.json({ success: false, error: "brokerageId required" }, { status: 400 })
    if (!agentId)     return NextResponse.json({ success: false, error: "agentId required" }, { status: 400 })
    if (!targetUrl)   return NextResponse.json({ success: false, error: "targetUrl required" }, { status: 400 })

    const result = await generateQRCode({
      magnetId,
      brokerageId,
      agentId,
      label: label ?? `Lead Magnet QR - ${magnetId}`,
      targetUrl,
    })

    if (!result.success) {
      return NextResponse.json(result, { status: 422 })
    }

    return NextResponse.json(result, { status: 201 })
  } catch (err) {
    console.error("[API] /api/lead-magnets/qr/[magnetId]:", err)
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    )
  }
}

// GET /api/lead-magnets/qr/[magnetId]
// Returns the QR code record for a given magnet
// Also fires a qr_scan tracking event if ?track=1 is passed (used by QR redirect pages)
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ magnetId: string }> }
) {
  try {
    const { magnetId } = await params
    const { searchParams } = new URL(req.url)
    const brokerageId = searchParams.get("brokerageId") ?? ""
    const track = searchParams.get("track") === "1"

    if (!brokerageId) {
      return NextResponse.json({ success: false, error: "brokerageId required" }, { status: 400 })
    }

    if (track && brokerageId) {
      const ipAddress = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined
      const userAgent = req.headers.get("user-agent") ?? undefined
      trackMagnetEvent({
        magnetId,
        brokerageId,
        eventType: "qr_scan",
        ipAddress,
        userAgent,
      }).catch(() => {})
    }

    const { createServiceClient } = await import("@/lib/supabase/service")
    const supabase = createServiceClient()

    const { data: qr, error } = await supabase
      .from("qr_codes")
      .select("id, slug, target_url, scan_count, label, is_active")
      .eq("brokerage_id", brokerageId)
      .eq("purpose", "lead_magnet")
      .ilike("target_url", `%${magnetId}%`)
      .eq("is_active", true)
      .maybeSingle()

    if (error || !qr) {
      return NextResponse.json({ success: false, error: "QR code not found" }, { status: 404 })
    }

    return NextResponse.json({ success: true, qr })
  } catch (err) {
    console.error("[API] GET /api/lead-magnets/qr/[magnetId]:", err)
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    )
  }
}

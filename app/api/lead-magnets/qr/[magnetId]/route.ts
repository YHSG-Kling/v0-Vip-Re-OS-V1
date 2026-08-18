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

    // LOOK THE CODE UP BY ITS KEY, NOT BY A SUBSTRING OF ITS URL.
    // This searched `target_url ILIKE %magnetId%`, and a lead-magnet QR's URL
    // carries the code's own SLUG, never the magnet id — so the match could not
    // succeed and this endpoint answered "QR code not found" for every magnet
    // that had one. The mint path keys the row `lead_magnet:<magnetId>`
    // (lib/marketing/tracked-qr.ts), which is exact, indexed by the same label
    // uniqueness the minter relies on, and immune to the URL being re-pointed.
    const { data: qr, error } = await supabase
      .from("qr_codes")
      .select("id, slug, target_url, scan_count, label, is_active")
      .eq("brokerage_id", brokerageId)
      .eq("label", `lead_magnet:${magnetId}`)
      .maybeSingle()

    // A refused read is not "there is no code" — supabase-js resolves a failed
    // query, so reporting both as 404 would hide an outage as an empty result.
    if (error) {
      console.error("[API] GET /api/lead-magnets/qr:", error.message)
      return NextResponse.json(
        { success: false, error: "Could not look up the QR code for this lead magnet." },
        { status: 500 },
      )
    }
    if (!qr) {
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

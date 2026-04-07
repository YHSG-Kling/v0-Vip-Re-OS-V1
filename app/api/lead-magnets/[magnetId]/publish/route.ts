import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { publishLeadMagnet } from "@/lib/kernel/lead-magnets"

// POST /api/lead-magnets/[magnetId]/publish
// Input contract: channels[], baseUrl (derived from request)
// Output contract: PublishLeadMagnetOutput
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
    if (!magnetId) {
      return NextResponse.json({ success: false, error: "magnetId is required" }, { status: 400 })
    }

    const body = await req.json()
    const { brokerageId, channels } = body

    if (!brokerageId) {
      return NextResponse.json({ success: false, error: "brokerageId is required" }, { status: 400 })
    }
    if (!channels?.length) {
      return NextResponse.json({ success: false, error: "At least one channel required" }, { status: 400 })
    }

    const host = req.headers.get("host") ?? "localhost:3000"
    const proto = req.headers.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https")
    const baseUrl = `${proto}://${host}`

    const result = await publishLeadMagnet({
      magnetId,
      brokerageId,
      channels,
      actorUserId: user.id,
      baseUrl,
    })

    if (!result.success) {
      return NextResponse.json(result, { status: 422 })
    }

    return NextResponse.json(result)
  } catch (err) {
    console.error("[API] /api/lead-magnets/[magnetId]/publish:", err)
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    )
  }
}

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { sendFeedbackRequestToAttendee } from "@/app/actions/open-house-automation"

export async function POST(req: NextRequest) {
  try {
    const { attendeeId } = await req.json()

    if (!attendeeId || typeof attendeeId !== "string") {
      return NextResponse.json({ error: "attendeeId is required" }, { status: 400 })
    }

    // Auth gate — must be signed in
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const result = await sendFeedbackRequestToAttendee(attendeeId)

    if (!result.success) {
      return NextResponse.json({ error: result.error ?? "Failed to send" }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err: any) {
    console.error("[api/open-house/request-feedback]", err?.message)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

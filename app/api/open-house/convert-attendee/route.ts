import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { completeOpenHouseCheckInAction } from "@/app/actions/open-house-kernel"

export async function POST(req: NextRequest) {
  try {
    const payload = await req.json()
    const { attendeeId } = payload

    if (!attendeeId || typeof attendeeId !== "string") {
      return NextResponse.json({ error: "attendeeId is required" }, { status: 400 })
    }

    const supabase = await createClient()

    // Auth gate
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { data: userRow } = await supabase
      .from("users")
      .select("brokerage_id, role")
      .eq("id", user.id)
      .single()

    if (!userRow?.brokerage_id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Fetch attendee row
    const { data: attendee, error: attendeeErr } = await supabase
      .from("open_house_attendees")
      .select("id, open_house_id, contact_id, first_name, last_name, email, phone, brokerage_id, property_interest_level")
      .eq("id", attendeeId)
      .maybeSingle()

    if (attendeeErr || !attendee) {
      return NextResponse.json({ error: "Attendee not found" }, { status: 404 })
    }

    // Already has a contact — nothing to do
    if (attendee.contact_id) {
      return NextResponse.json({ success: true, contactId: attendee.contact_id })
    }

    if (!attendee.email) {
      return NextResponse.json({ error: "Attendee has no email — cannot convert" }, { status: 400 })
    }

    // Use kernel flow to resolve or create contact and update attendee
    const checkInResult = await completeOpenHouseCheckInAction({
      brokerage_id: userRow.brokerage_id,
      agent_id: user.id,
      open_house_id: attendee.open_house_id,
      first_name: attendee.first_name ?? "",
      last_name: attendee.last_name ?? undefined,
      email: attendee.email,
      phone: attendee.phone ?? undefined,
      check_in_method: "manual",
      interest_level: attendee.property_interest_level ?? 3,
    })

    if (!checkInResult.success || !checkInResult.contact_id) {
      console.error("[convert-attendee] Check-in failed:", checkInResult.error)
      return NextResponse.json({ error: checkInResult.error || "Check-in failed" }, { status: 500 })
    }

    const contactId = checkInResult.contact_id

    // Update the attendee record with the resolved contact ID (in case kernel didn't already do it)
    await supabase
      .from("open_house_attendees")
      .update({ contact_id: contactId })
      .eq("id", attendeeId)
      .catch(() => {}) // Already updated by kernel, this is just a safety measure

    return NextResponse.json({
      success: true,
      contactId,
      attendeeId,
      nextActionId: checkInResult.next_action_id,
    })
  } catch (err: any) {
    console.error("[api/open-house/convert-attendee]", err?.message)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}


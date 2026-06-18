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
    // open_house_attendees real columns: event_id (not open_house_id), a single
    // `name` (no first/last split), interest_level text enum (not numeric).
    const { data: attendee, error: attendeeErr } = await supabase
      .from("open_house_attendees")
      .select("id, event_id, contact_id, name, email, phone, brokerage_id, interest_level")
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

    // open_house_attendees stores a single `name`; split for the kernel's
    // first/last contract (the kernel re-joins them anyway).
    const nameParts = (attendee.name ?? "").trim().split(/\s+/)
    // interest_level is the text enum hot|warm|cold|no_interest; the kernel
    // expects the 1-5 numeric scale (it maps back to text internally).
    const interestNumeric =
      attendee.interest_level === "hot" ? 5
      : attendee.interest_level === "warm" ? 3
      : attendee.interest_level === "cold" ? 2
      : attendee.interest_level === "no_interest" ? 1
      : 3

    // Use kernel flow to resolve or create contact and update attendee
    const checkInResult = await completeOpenHouseCheckInAction({
      brokerage_id: userRow.brokerage_id,
      agent_id: user.id,
      open_house_id: attendee.event_id,
      first_name: nameParts[0] ?? "",
      last_name: nameParts.slice(1).join(" ") || undefined,
      email: attendee.email,
      phone: attendee.phone ?? undefined,
      check_in_method: "manual",
      interest_level: interestNumeric,
    })

    if (!checkInResult.success || !checkInResult.contact_id) {
      console.error("[convert-attendee] Check-in failed:", checkInResult.error)
      return NextResponse.json({ error: checkInResult.error || "Check-in failed" }, { status: 500 })
    }

    const contactId = checkInResult.contact_id

    // Update the attendee record with the resolved contact ID (in case kernel didn't already do it)
    void supabase
      .from("open_house_attendees")
      .update({ contact_id: contactId })
      .eq("id", attendeeId)

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


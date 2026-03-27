import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function POST(req: NextRequest) {
  try {
    const { attendeeId } = await req.json()

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
      .select("id, event_id, contact_id, first_name, last_name, email, phone, brokerage_id")
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

    // Check for an existing contact with this email in this brokerage
    const { data: existing } = await supabase
      .from("contacts")
      .select("id")
      .eq("brokerage_id", userRow.brokerage_id)
      .eq("email", attendee.email)
      .maybeSingle()

    let contactId: string

    if (existing?.id) {
      contactId = existing.id
    } else {
      // Create a new contact
      const { data: newContact, error: createErr } = await supabase
        .from("contacts")
        .insert({
          brokerage_id:  userRow.brokerage_id,
          agent_id:      user.id,
          first_name:    attendee.first_name ?? "",
          last_name:     attendee.last_name ?? "",
          email:         attendee.email,
          contact_type:  "buyer",
          source:        "open_house",
          status:        "active",
        })
        .select("id")
        .single()

      if (createErr || !newContact) {
        console.error("[convert-attendee] contact create error:", createErr?.message)
        return NextResponse.json({ error: "Failed to create contact" }, { status: 500 })
      }

      contactId = newContact.id
    }

    // Back-link the attendee row to the new/existing contact
    await supabase
      .from("open_house_attendees")
      .update({ contact_id: contactId })
      .eq("id", attendeeId)

    return NextResponse.json({ success: true, contactId })
  } catch (err: any) {
    console.error("[api/open-house/convert-attendee]", err?.message)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

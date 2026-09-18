import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { getLessonFeed } from "@/app/actions/portal-education"

export async function GET(
  // Deliberately unread — every input is the route param below plus the session gate.
  _request: Request,
  { params }: { params: Promise<{ contactId: string }> }
) {
  try {
    const { contactId } = await params
    const supabase = await createClient()

    // Verify contact exists
    const { data: contact, error: contactError } = await supabase
      .from("contacts")
      .select("id")
      .eq("id", contactId)
      .single()

    if (contactError || !contact) {
      return NextResponse.json(
        { error: "Contact not found" },
        { status: 404 }
      )
    }

    // Get lesson feed
    const feed = await getLessonFeed(contactId)

    return NextResponse.json(feed)
  } catch (error) {
    console.error("[PortalEducation] Error fetching lesson feed:", error)
    return NextResponse.json(
      { error: "Failed to fetch lesson feed" },
      { status: 500 }
    )
  }
}

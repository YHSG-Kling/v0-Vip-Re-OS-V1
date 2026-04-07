import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"

export async function POST(req: NextRequest) {
  // Auth gate
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  let body: { contactId: string; channel?: "email" | "direct_mail" }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const { contactId, channel = "email" } = body
  if (!contactId) return NextResponse.json({ error: "contactId is required" }, { status: 400 })

  const service = createServiceClient()

  // Fetch contact + linked lead id
  const { data: contact, error: contactErr } = await service
    .from("contacts")
    .select("id, brokerage_id, email, lead_id, call_stop_flag, dnc_status, email_opt_out, mailing_address, address")
    .eq("id", contactId)
    .maybeSingle()

  if (contactErr || !contact) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 })
  }

  // TCPA / DNC guard
  if (contact.dnc_status) {
    return NextResponse.json({ error: "Contact is on Do Not Contact list" }, { status: 403 })
  }
  if (channel === "email" && contact.email_opt_out) {
    return NextResponse.json({ error: "Contact has opted out of email" }, { status: 403 })
  }
  if (channel === "direct_mail") {
    const addr = contact.mailing_address || contact.address
    if (!addr) return NextResponse.json({ error: "No mailing address on file" }, { status: 400 })
  }

  // If the contact has a linked lead, use the standard engagement action
  if (contact.lead_id) {
    const { initiateAIISAEngagement } = await import("@/app/actions/ai-isa/initiate-engagement")
    const result = await initiateAIISAEngagement(contact.lead_id, { forceChannel: channel })
    return NextResponse.json(result ?? { success: true })
  }

  // Contact without a linked lead — dispatch directly via kernel communications
  const { assembleEmail } = await import("@/lib/kernel/communications/assemble-email")
  const { dispatchEmail } = await import("@/lib/providers/dispatch")

  if (channel === "email") {
    if (!contact.email) return NextResponse.json({ error: "No email on contact" }, { status: 400 })

    const emailPayload = await assembleEmail({
      brokerageId: contact.brokerage_id,
      contactId: contact.id,
      templateKey: "isa_followup",
    })

    await dispatchEmail({
      to: contact.email,
      subject: emailPayload.subject,
      html: emailPayload.html,
      brokerageId: contact.brokerage_id,
    })

    return NextResponse.json({ success: true })
  }

  // direct_mail — log the request as an activity for fulfillment
  await service.from("activities").insert({
    brokerage_id: contact.brokerage_id,
    contact_id: contact.id,
    activity_type: "direct_mail_queued",
    title: "Direct mail piece queued",
    description: "Operator triggered direct mail from CRM contact record.",
    status: "pending",
    created_at: new Date().toISOString(),
  })

  return NextResponse.json({ success: true })
}

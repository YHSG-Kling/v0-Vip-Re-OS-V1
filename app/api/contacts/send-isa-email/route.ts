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

  // §4 — THE TENANT COMES FROM THE SESSION. This route authenticated the user
  // and then read the body-named contact on the SERVICE client with no tenant
  // predicate, taking `contact.brokerage_id` as the brokerage for every
  // downstream call: assembleEmail, resolveOutboundSender, dispatchEmail and the
  // direct_mail_queued activity. One contact UUID was therefore enough for any
  // signed-in user to make ANOTHER brokerage send a paid email or queue a mail
  // piece — billed to that brokerage, under its verified sender. Exactly the
  // IDOR shape §4 names, and it only stayed harmless because nothing addressed
  // this route yet. The caller's brokerage is resolved here and the contact read
  // is pinned to it.
  const { data: callerRow } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!callerRow?.brokerage_id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const callerBrokerageId = callerRow.brokerage_id as string

  const service = createServiceClient()

  // Fetch contact (the linked lead is resolved separately — leads point at
  // contacts via leads.contact_id; contacts has no lead_id column)
  const { data: contact, error: contactErr } = await service
    .from("contacts")
    .select("id, brokerage_id, email, call_stop_flag, dnc_status, email_opt_out, mailing_address, address")
    .eq("id", contactId)
    .eq("brokerage_id", callerBrokerageId)
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
  const { data: linkedLead } = await service
    .from("leads")
    .select("id")
    .eq("contact_id", contact.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (linkedLead?.id) {
    const { initiateAIISAEngagement } = await import("@/app/actions/ai-isa/initiate-engagement")
    const result = await initiateAIISAEngagement(linkedLead.id, { forceChannel: channel })
    return NextResponse.json(result ?? { success: true })
  }

  // Contact without a linked lead — dispatch directly via kernel communications
  const { assembleEmail } = await import("@/lib/kernel/communications/assemble-email")
  const { dispatchEmail } = await import("@/lib/providers/dispatch")

  if (channel === "email") {
    if (!contact.email) return NextResponse.json({ error: "No email on contact" }, { status: 400 })

    const isaBodyHtml = `<p>Hi there,</p><p>We wanted to follow up and see if we can help you with your real estate goals. Please let us know if you have any questions.</p>`
    const emailPayload = await assembleEmail({
      bodyHtml: isaBodyHtml,
      userId: user.id,
      brokerageId: contact.brokerage_id,
      contactId: contact.id,
    })

    // The from-address is never a placeholder. "noreply@example.com" both
    // fails SendGrid's verified-sender check and OVERRIDES the brokerage's own
    // configured sender, because sendEmail resolves params.from first.
    const { resolveOutboundSender, formatSender, NO_SENDER_ERROR } =
      await import("@/lib/providers/outbound-sender")
    const sender = await resolveOutboundSender(service, contact.brokerage_id)
    if (!sender) {
      return NextResponse.json({ success: false, error: NO_SENDER_ERROR }, { status: 422 })
    }

    await dispatchEmail({
      from: formatSender(sender),
      to: contact.email,
      subject: "Following up on your real estate inquiry",
      html: emailPayload.html,
      brokerageId: contact.brokerage_id,
      contactId: contact.id,
    })

    return NextResponse.json({ success: true })
  }

  // direct_mail — log the request as an activity for fulfillment. THIS ROW IS
  // THE QUEUE: nothing else records that a mail piece was asked for, so a lost
  // row is a piece that is never fulfilled while the caller is told "success".
  const { error: directMailActivityError } = await service.from("activities").insert({
    brokerage_id: contact.brokerage_id,
    contact_id: contact.id,
    activity_type: "direct_mail_queued",
    title: "Direct mail piece queued",
    description: "Operator triggered direct mail from CRM contact record.",
    status: "pending",
    created_at: new Date().toISOString(),
  })
  if (directMailActivityError) {
    console.error("[send-isa-email] direct_mail_queued activity REJECTED — nothing was queued for fulfillment:", directMailActivityError.message)
  }

  return NextResponse.json({ success: true })
}

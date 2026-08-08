import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { KernelEvent } from "@/lib/kernel/events"
import { persistContactConsent } from "@/lib/kernel/compliance/require-contact-consent"
import { queueContactEnrichment } from "@/lib/enrichment/contact-enrichment-core"

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const {
      eventId,
      firstName,
      lastName,
      email,
      phone,
      workingWithAgent,
      hearAboutUs,
      tcpaConsent,
      tcpaConsentText,
      tcpaConsentSource,
    }: {
      eventId: string
      firstName: string
      lastName: string
      email: string
      phone?: string
      workingWithAgent: boolean
      hearAboutUs?: string
      tcpaConsent?: boolean
      tcpaConsentText?: string
      tcpaConsentSource?: string
    } = body

    if (!eventId || !firstName || !lastName || !email) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 })
    }

    if (!tcpaConsent) {
      return NextResponse.json({ error: "TCPA consent is required" }, { status: 400 })
    }

    const ip        = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null
    const userAgent = req.headers.get("user-agent") ?? null

    const supabase = createServiceClient()

    // Load event to get listing + brokerage + agent context. Address pulled
    // for the personalized instant-greeting message at the end of this flow.
    const { data: event, error: eventErr } = await supabase
      .from("open_house_events")
      .select("id, listing_id, brokerage_id, agent_id, qr_code_id, listings(address)")
      .eq("id", eventId)
      .single()

    if (eventErr || !event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 })
    }
    const listingAddress = ((event as { listings?: { address?: string } | null }).listings ?? null)?.address ?? null

    // 1. Upsert contact by email (Layer 2 dedup pattern)
    const { data: existingContact } = await supabase
      .from("contacts")
      .select("id")
      .eq("email", email)
      .eq("brokerage_id", event.brokerage_id)
      .maybeSingle()

    let contactId: string

    if (existingContact) {
      contactId = existingContact.id
      // Update with any new info
      await supabase
        .from("contacts")
        .update({
          first_name: firstName,
          last_name: lastName,
          phone: phone ?? undefined,
          updated_at: new Date().toISOString(),
        })
        .eq("id", contactId)
    } else {
      const now = new Date().toISOString()
      const { data: newContact, error: contactErr } = await supabase
        .from("contacts")
        .insert({
          brokerage_id: event.brokerage_id,
          agent_id: event.agent_id,
          first_name: firstName,
          last_name: lastName,
          email,
          phone: phone ?? null,
          source: "open_house",
          status: "new",
          tcpa_consent: true,
          tcpa_consent_at: now,
          tcpa_consent_date: now,
          tcpa_consent_text: tcpaConsentText ?? null,
          tcpa_consent_source: tcpaConsentSource ?? "/open-house/sign-in",
          tcpa_consent_ip: ip,
          isa_reengage_allowed: false,
        })
        .select("id")
        .single()

      if (contactErr || !newContact) {
        return NextResponse.json({ error: "Failed to create contact" }, { status: 500 })
      }
      contactId = newContact.id

      // Persist consent audit event
      await persistContactConsent({
        brokerageId: event.brokerage_id,
        agentId: event.agent_id,
        contactId,
        consentText: tcpaConsentText ?? "Consent given at open house sign-in",
        consentSource: tcpaConsentSource ?? "/open-house/sign-in",
        consented: true,
        ipAddress: ip,
        userAgent: userAgent,
      }).catch(() => {})

      // ENRICH AS SOON AS THE CONTACT COMES IN (owner's ruling). Only on the
      // CREATE branch — a returning attendee already went through this. This
      // public route emits no kernel event, so nothing else would have queued
      // it. Voided: a sign-in must never fail because of enrichment.
      void queueContactEnrichment({
        contactId,
        brokerageId: event.brokerage_id,
        triggerType: "open_house",
        supabase,
      }).catch(() => {})
    }

    // 2. INSERT open_house_attendees
    const { data: attendee, error: attendeeErr } = await supabase
      .from("open_house_attendees")
      .insert({
        event_id: eventId,
        contact_id: contactId,
        brokerage_id: event.brokerage_id,
        check_in_time: new Date().toISOString(),
        working_with_agent: workingWithAgent,
        notes: hearAboutUs ? `Heard about us via: ${hearAboutUs}` : null,
        ai_lead_score: 0,
      })
      .select("id")
      .single()

    if (attendeeErr) {
      // If duplicate check-in, return success silently
      if (attendeeErr.code === "23505") {
        return NextResponse.json({ success: true, duplicate: true })
      }
      return NextResponse.json({ error: "Failed to record attendance" }, { status: 500 })
    }

    // 3. UPSERT open_house_rsvp_tracking
    await supabase
      .from("open_house_rsvp_tracking")
      .upsert(
        {
          event_id: eventId,
          contact_id: contactId,
          rsvp_status: "attended",
          source: "qr_code",
          rsvp_updated_at: new Date().toISOString(),
        },
        { onConflict: "event_id,contact_id" }
      )

    // 4. UPDATE qr_codes scan_count + lead_count
    if (event.qr_code_id) {
      await supabase.rpc("increment_qr_counts", { qr_id: event.qr_code_id })
        .then(async () => {
          // Fallback if RPC not available
        })
        .then(() => {}, async () => {
          const { data: qr } = await supabase
            .from("qr_codes")
            .select("scan_count, lead_count")
            .eq("id", event.qr_code_id!)
            .single()
          if (qr) {
            await supabase
              .from("qr_codes")
              .update({
                scan_count: (qr.scan_count ?? 0) + 1,
                lead_count: (qr.lead_count ?? 0) + 1,
              })
              .eq("id", event.qr_code_id!)
          }
        })
    }

    // 5. Direct lifecycle_events insert
    await supabase.from("lifecycle_events").insert({
      brokerage_id: event.brokerage_id,
      entity_type: "listing_stage_machine",
      entity_id: event.listing_id,
      event_type: "listing.open_house.attendee_captured",
      actor_user_id: event.agent_id,
      metadata: {
        attendee_id: attendee.id,
        contact_id: contactId,
        event_id: eventId,
        working_with_agent: workingWithAgent,
        hear_about_us: hearAboutUs ?? null,
      },
    })

    // 6. processKernelEvent
    await processKernelEvent({
      event: KernelEvent.OPEN_HOUSE_ATTENDEE_CAPTURED,
      brokerageId: event.brokerage_id,
      entityType: "listing_stage_machine",
      entityId: event.listing_id,
    }).catch(() => {})

    // 7. Open House Concierge Mobile — fire personalized 90-second auto-text
    // (or email when no phone). evaluateOutbound runs internally; failures
    // are logged but do NOT block the successful check-in response.
    let greetingResult: { sent: boolean; channel?: "sms" | "email"; reason?: string } = { sent: false }
    try {
      const { sendInstantOpenHouseGreeting } = await import("@/lib/open-house/instant-greeting")
      const r = await sendInstantOpenHouseGreeting({
        attendeeId:     attendee.id,
        contactId,
        eventId,
        brokerageId:    event.brokerage_id,
        agentId:        event.agent_id,
        firstName,
        phone:          phone ?? null,
        email,
        listingAddress,
      })
      if (r.success) {
        greetingResult = { sent: true, channel: r.channel }
      } else {
        greetingResult = { sent: false, reason: r.reason ?? r.error }
      }
    } catch (err) {
      console.error("[open-house/attend] instant greeting threw:", err)
    }

    return NextResponse.json({
      success: true,
      attendeeId: attendee.id,
      instantGreeting: greetingResult,
    })
  } catch (err) {
    console.error("[open-house/attend]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

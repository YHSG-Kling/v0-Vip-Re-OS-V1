import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { checkPublicRateLimit } from "@/lib/security/public-rate-limit"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { KernelEvent } from "@/lib/kernel/events"
// THE ONE resolver (§6) — same one app/api/forms/submit/route.ts uses, now
// shared rather than a second Accept-Language parser at this door.
import { resolveCapturedLanguage } from "@/lib/contact-pipeline/contact-capture"
// 102D — PROVENANCE (wave 101C still-open): the attendee typed their own identity at the kiosk.
// Source `kiosk`, purpose self_service, no actor (a public sign-in has no session). ONE pure writer
// (lib/lead-pipeline/enrichment-column-map.ts stampFieldProvenance); persisted on the returning
// branch through THE persistence door (lib/enrichment/field-provenance-store.ts).
import { stampFieldProvenance, withFieldProvenance } from "@/lib/lead-pipeline/enrichment-column-map"

const KIOSK_PROVENANCE = { source: "kiosk", capability: "open_house.kiosk_signin", purpose: "self_service" as const, matchConfidence: "self_reported", actor: null }

/** The consent wording the kiosk shows beside its box (app/open-house/[eventId]/signin/sign-in-kiosk.tsx TCPA_CONSENT_TEXT), verbatim —
 *  the C8 record hashes it. A change to the label is a new version here. */
const KIOSK_CONSENT_TEXT = (brokerageName: string) =>
  `By checking this box, you agree to receive calls, texts, emails, and direct mail from ${brokerageName} and its agents regarding your real estate needs. Consent is not a condition of purchase. You may unsubscribe or opt out at any time.`
const KIOSK_CONSENT_VERSION = "open_house_kiosk:v1"

export async function POST(req: NextRequest) {
  // PUBLIC-WRITE THROTTLE (lane 138F readiness audit, P1): unauthenticated
  // attendee capture. Generous ceiling — a sign-in kiosk posts every attendee
  // from ONE address. Idiom: app/api/track/visitor/route.ts.
  const rateIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown"
  const rateVerdict = checkPublicRateLimit("open-house-attend", rateIp, { limit: 60, windowMs: 10 * 60_000 })
  if (!rateVerdict.allowed) {
    return NextResponse.json({ error: "Too many sign-ins from this connection — try again shortly." }, { status: 429, headers: { "Retry-After": String(rateVerdict.retryAfterSeconds) } })
  }
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

    // The consumer-consent requirement is enforced below, after the event read: a BROKER OPEN's visitors are agents and are
    // asked none (wave 147, lane 147Z). Every consumer path still refuses before its first write.

    const ip        = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null
    const userAgent = req.headers.get("user-agent") ?? null

    // TIER 3 OF resolveContactLanguage (lib/video/multilingual-reel.ts) — the
    // intake-time locale, captured at first touch before any preferred_language
    // setting or transcribed call can exist. This sign-in form has no locale
    // field of its own, so Accept-Language is the only signal — same contract
    // as every other captureContact()-routed door (CaptureContactParams.language).
    const capturedLanguage = resolveCapturedLanguage(null, req.headers.get("accept-language"))

    const supabase = createServiceClient()

    // Load event to get listing + brokerage + agent context. Address pulled
    // for the personalized instant-greeting message at the end of this flow.
    const { data: event, error: eventErr } = await supabase
      .from("open_house_events")
      .select("id, listing_id, brokerage_id, agent_id, qr_code_id, event_type, listings(address)")
      .eq("id", eventId)
      .single()

    if (eventErr || !event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 })
    }
    const listingAddress = ((event as { listings?: { address?: string } | null }).listings ?? null)?.address ?? null

    // 0. A BROKER OPEN (wave 147, lane 147Z — the producer half lane 147F found missing: app/actions/open-house.ts createOpenHouse
    //    eventType "broker_open"). Its sign-ins are cooperating AGENTS previewing the listing for their buyers — not consumers:
    //    the visit is recorded (the attendee row + the capture event the listing's reporting reads), and NO consumer contact,
    //    consumer consent, enrichment spend or consumer greeting is created for a professional colleague.
    if ((event as { event_type?: string | null }).event_type === "broker_open") {
      const { data: agentVisit, error: agentVisitErr } = await supabase.from("open_house_attendees").insert({
        event_id: eventId, brokerage_id: event.brokerage_id, name: `${firstName} ${lastName}`.trim(), email, phone: phone ?? null,
        check_in_time: new Date().toISOString(), working_with_agent: true, tcpa_consent: false,
        notes: `Broker open — cooperating agent${hearAboutUs ? ` (heard via ${hearAboutUs})` : ""}`,
      }).select("id").single()
      if (agentVisitErr) {
        if (agentVisitErr.code === "23505") return NextResponse.json({ success: true, duplicate: true, brokerOpen: true })
        return NextResponse.json({ error: "Failed to record attendance" }, { status: 500 })
      }
      await sentinelWrite(supabase, import("@/lib/kernel/emit").then((k) => k.emitKernelEvent({
        brokerageId: event.brokerage_id, entityType: "listing_stage_machine", entityId: event.listing_id, event: "listing.open_house.attendee_captured",
        actorUserId: event.agent_id, metadata: { attendee_id: (agentVisit as { id: string }).id, event_id: eventId, broker_open: true },
      }).then(k.asWriteResult)), { table: "lifecycle_events", flow: "lifecycle_events_echo", reason: "lifecycle_events audit echo of a broker-open visit already recorded on open_house_attendees" })
      return NextResponse.json({ success: true, attendeeId: (agentVisit as { id: string }).id, brokerOpen: true })
    }

    if (!tcpaConsent) {
      return NextResponse.json({ error: "TCPA consent is required" }, { status: 400 })
    }

    // 1. THE CONSENTED SIGN-IN → CONTACT (contract C8 — wave 147, lane 147Z; lane 147A Outside-lane 3 + lane 147F Outside-lane 3).
    // TOMBSTONE (orphan doctrine §1.1): the exact-email match, the returning-attendee identity refresh, the contact insert with its
    // own tcpa_* stamp, the route's own persistContactConsent call (no scope, no wording hash) and its own enrichment-queue call
    // that stood here were a SECOND upsert of a consented person. Merged onto THE ONE survivor — lib/contact-pipeline/
    // contact-capture.ts:818 captureConsentedContact → captureContact (fuzzy dedupe on email / phone, the assignment precedence
    // with the event's agent as the owner hint, the welcome, the enrichment queue, person identity) → completeConsentedIntake (the
    // consent record with the wording hash + version, purposes and channels, anchored to the contact; a same-person open lead
    // closed onto it; the kernel event; the AI ISA desk told). Preserved door semantics: contact_type buyer (the visit is to a
    // for-sale listing — the owner precedent below), the kiosk provenance stamp, the intake-time language, a NEW kiosk contact
    // keeps isa_reengage_allowed = false (the event's agent follows up, not the ISA re-engagement loop), and everything after this
    // step (the attendee row, RSVP tracking, QR counters, the OPEN_HOUSE_ATTENDEE_CAPTURED fan-out with contactId / eventId, the
    // instant greeting and linkOpenHouseCheckInIdentity inside it) is unchanged.
    // THE WORDING IS THE DOOR'S: the kiosk renders KIOSK_CONSENT_TEXT(brokerage name) beside the box (sign-in-kiosk.tsx). The
    // server renders the same template from the event's own brokerage; the body's copy is evidence of a match, never the record.
    const { data: brk, error: brkErr } = await supabase.from("brokerages").select("name").eq("id", event.brokerage_id).maybeSingle()
    if (brkErr) console.error("[open-house/attend] brokerage name read refused — the consent wording names 'our brokerage':", brkErr.message)
    const doorText = KIOSK_CONSENT_TEXT(((brk as { name?: string | null } | null)?.name ?? "").trim() || "our brokerage")
    const { captureConsentedContact } = await import("@/lib/contact-pipeline/contact-capture")
    const intake = await captureConsentedContact({
      brokerageId: event.brokerage_id,
      ownerAgentId: event.agent_id ?? null,
      source: "open_house",
      first_name: firstName, last_name: lastName, email, phone: phone ?? null,
      // OWNER PRECEDENT (app/actions/seller-open-house.ts convertAttendeeToContact, lib/kernel/open-house.ts
      // resolveOrCreateOpenHouseContact): an open-house attendee is touring a specific FOR-SALE listing — a buyer-side
      // contact by the nature of the visit, which routes the welcome to shopping_agent (owner ruling 2026-09-10, wave 51).
      contact_type: "buyer",
      preferred_channel: phone ? "phone" : "email",
      // TIER 3 OF resolveContactLanguage — the ONE resolver's own doc (CaptureContactParams.language).
      language: capturedLanguage,
      enrichmentProfile: withFieldProvenance({}, stampFieldProvenance(["first_name", "last_name", "email", ...(phone ? ["phone"] : [])], KIOSK_PROVENANCE)),
      consents: [{ family: "phone", given: true, text: doorText, textVersion: KIOSK_CONSENT_VERSION, purposes: ["event_followup"] }],
      intake: {
        channel: "open_house", sourceUrl: tcpaConsentSource ?? "/open-house/sign-in",
        evidence: { event_id: eventId, ip, user_agent: userAgent, kiosk_text_matched: typeof tcpaConsentText === "string" && tcpaConsentText.trim() === doorText },
        formOwner: { table: "open_house_events", id: eventId },
      },
    })
    if (!intake.ok || !intake.contactId) {
      return NextResponse.json({ error: intake.reason ?? "Failed to record the sign-in" }, { status: intake.refused === "not_identifiable" ? 400 : intake.refused === "cross_tenant_form" ? 403 : 500 })
    }
    for (const w of intake.warnings) console.warn(`[open-house/attend] ${w}`)
    const contactId: string = intake.contactId
    if (intake.action === "created" && !intake.replay) {
      const { data: held, error: holdErr } = await supabase.from("contacts").update({ isa_reengage_allowed: false }).eq("id", contactId).eq("brokerage_id", event.brokerage_id).select("id")
      if (holdErr || !Array.isArray(held) || held.length !== 1) console.error(`[open-house/attend] isa_reengage_allowed not held false for ${contactId}: ${holdErr?.message ?? "matched no row"}`)
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
    //
    // brokerage_id from the EVENT record — the same source the contact insert
    // and the attendee insert above already use, and the record-resolved tenant
    // the worked example at app/actions/open-house.ts:481-498 argues for. There
    // is no caller identity to fall back on here anyway: this is a public,
    // unauthenticated sign-in route on the service client, so the event row is
    // the ONLY thing that knows which brokerage the walk-in belongs to.
    //
    // Omitting it wrote a NULL-tenant row under a
    // `brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id()`
    // policy — world-readable and world-writable — and made the attendee, whose
    // sibling insert 20 lines up IS stamped, invisible to any tracking reader
    // that narrows by brokerage.
    const { error: rsvpErr } = await supabase
      .from("open_house_rsvp_tracking")
      .upsert(
        {
          event_id: eventId,
          contact_id: contactId,
          brokerage_id: event.brokerage_id,
          rsvp_status: "attended",
          source: "qr_code",
          rsvp_updated_at: new Date().toISOString(),
        },
        { onConflict: "event_id,contact_id" }
      )

    // Non-fatal: the attendee row above is the load-bearing record of the
    // check-in and it landed. Logged rather than swallowed — supabase-js
    // RESOLVES a refused write, so the previous bare `await` could not tell a
    // "permission denied" from a success.
    if (rsvpErr) {
      console.error("[open-house/attend] rsvp tracking upsert failed:", rsvpErr.message)
    }

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
            await sentinelWrite(supabase, supabase
              .from("qr_codes")
              .update({
                scan_count: (qr.scan_count ?? 0) + 1,
                lead_count: (qr.lead_count ?? 0) + 1,
              })
              .eq("id", event.qr_code_id!), { table: "qr_codes", flow: "qr_codes_write", reason: "QR scan/lead counters (reporting)" })
          }
        })
    }

    // 5. Direct lifecycle_events insert
    await sentinelWrite(supabase, import("@/lib/kernel/emit").then((k) => k.emitKernelEvent({
      brokerageId: event.brokerage_id,
      entityType: "listing_stage_machine",
      entityId: event.listing_id,
      event: "listing.open_house.attendee_captured",
      actorUserId: event.agent_id,
      metadata: {
        attendee_id: attendee.id,
        contact_id: contactId,
        event_id: eventId,
        working_with_agent: workingWithAgent,
        hear_about_us: hearAboutUs ?? null,
      },
    }).then(k.asWriteResult)), { table: "lifecycle_events", flow: "lifecycle_events_echo", reason: "lifecycle_events audit echo of a change the caller already made; a lost row is ledgered (service client) or logged (user client), never silently dropped" })

    // 6. processKernelEvent
    // contactId + metadata.eventId are carried so lib/kernel/event-reactor.ts's
    // OPEN_HOUSE_ATTENDEE_CAPTURED handler can hand this contact to
    // deliverConversionWelcome (owner ruling 2026-09-10, wave 51) — previously
    // omitted, so that reader had no way to reach the contact this same request
    // just created or resolved.
    await processKernelEvent({
      event: KernelEvent.OPEN_HOUSE_ATTENDEE_CAPTURED,
      brokerageId: event.brokerage_id,
      entityType: "listing_stage_machine",
      entityId: event.listing_id,
      contactId,
      metadata: { contactId, eventId, attendeeId: attendee.id },
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
        // Wave 102 — half of the person key (lib/kernel/person-identity.ts); the sign-in already requires it.
        lastName,
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

/**
 * lib/ai-isa/customer-context-tools.ts
 *
 * Lane 73B, item 1 — "Free/cheap tools first: every persona gets the free
 * internal tools (contact/lead context, calendar/showing booking, listing
 * lookup from our own DB — reuse existing agent tools in app/api/internal/
 * ai-chat's agentTools; do not duplicate them — import/export the shared
 * registry)."
 *
 * app/api/internal/ai-chat/route.ts's `agentTools` is a STAFF-authenticated
 * write surface: `schedule_follow_up` takes an arbitrary `contact_id` from the
 * model, `lookup_contact` free-text-searches the WHOLE brokerage book. Handing
 * either unmodified to an anonymous widget visitor or an unauthenticated
 * portal contact would be an IDOR — a stranger's name would return another
 * client's phone/email (CLAUDE.md §4: tenant/identity from the SESSION, and
 * that includes never letting a caller search or write ANOTHER person's row).
 * That is the missing half this file builds, NOT a duplicate of agentTools:
 * the SAME write shape (an `activities` row: contact_id/agent_id/brokerage_id/
 * activity_type/title/notes/status, exactly what schedule_follow_up already
 * inserts), reused via `writeFollowUpActivity` below, but with the caller's
 * OWN contactId/leadId LOCKED from `ctx` — never a model-suppliable argument —
 * and a new READ-ONLY "my own context" tool no staff equivalent needed,
 * because staff's `lookup_contact` already searches broadly by design.
 *
 * Every tool here is FREE (no vendor spend, no meterVendorSpend call) — they
 * exist so a conversation can do useful CRM work (get its own context, offer
 * a showing, browse the brokerage's own live listings) before it ever reaches
 * for a paid BatchData/RentCast tool.
 */

import { tool } from "ai"
import { z } from "zod"
import { createServiceClient } from "@/lib/supabase/service"
import { sentinelWrite } from "@/lib/kernel/write-sentinel"
// Lane 91C — the one recency window for a buyer listing pull (pure constant).
import { BUYER_LISTING_RECENCY_DAYS } from "@/lib/property-alerts/alert-cadence"
import { QUALIFICATION_FOLLOW_UP_MENU, QUALIFICATION_GOALS, parseFollowUpPreference } from "@/lib/ai-isa/qualification-playbook"
import {
  writeFollowUpActivity, scheduleFollowUp, notifyAssignedAgent, publishQualificationSignal,
} from "@/lib/ai-isa/qualification-signals"
// Re-exported so app/api/internal/ai-chat/route.ts's existing import keeps
// working — the implementation lives in qualification-signals.ts (§6, the
// ONE writer both the staff tool and every customer-safe tool below share).
export { writeFollowUpActivity }
import { buildNewCatalogueTools, buildGetListingDetailsTool, loadEnabledCapabilities, isCapabilityEnabled, type CustomerCapabilityContext } from "@/lib/ai-isa/capability-catalogue"
import { buildLookupPropertyFactsTool, buildSearchOffmarketOpportunitiesTool } from "@/lib/ai-isa/property-lookup-tools"

export interface CustomerContextToolsContext {
  brokerageId: string
  /** contacts.id — when known, get_my_context/request_showing operate on THIS
   *  row only, never a model-supplied id. */
  contactId?: string | null
  /** leads.id — used when no contactId exists yet (a pre-conversion lead
   *  thread, e.g. the ISA inbound-email handler). */
  leadId?: string | null
  agentId?: string | null
  /** lib/ai-isa/persona-tool-policy.ts's ToolPersona — when the caller has
   *  already resolved one (every surface does, before buildQualificationPrompt),
   *  passed through so the wave-75 capability catalogue's per-capability
   *  persona allowlist can gate send_newsletter/send_market_report/
   *  send_explainer_video/book_listing_appointment the SAME way persona-tool-
   *  policy.ts already gates BatchData/RentCast tools. Omitted = no persona-based
   *  narrowing (only the settings toggle + identity gate apply). */
  persona?: import("@/lib/ai-isa/persona-tool-policy").ToolPersona | null
}

// TOMBSTONE (lane 75B) — writeFollowUpActivity's implementation moved to
// lib/ai-isa/qualification-signals.ts:29 (re-exported above so this module's
// own callers and app/api/internal/ai-chat/route.ts's import both still
// resolve) — the missing half lib/ai-isa/capability-catalogue.ts needed to
// reuse the SAME writer without an import cycle back into this file.

/**
 * get_my_context — READ ONLY, bound to ctx.contactId/leadId (never a
 * model-supplied id, so it can never become a free-text search of another
 * person's record). Returns the caller's own name/stage/persona + their last
 * few logged activities, so the model can ground its replies without a paid
 * lookup.
 */
function buildGetMyContextTool(ctx: CustomerContextToolsContext) {
  return tool({
    description: "Look up YOUR OWN contact/lead profile and recent activity — name, stage, and the last few logged interactions. Use this before asking the person to repeat information already on file.",
    inputSchema: z.object({}),
    execute: async () => {
      const svc = createServiceClient()
      if (ctx.contactId) {
        const { data: contact, error } = await svc
          .from("contacts")
          .select("id, first_name, last_name, contact_type, contact_persona, buyer_stage, status, last_contacted_at")
          .eq("id", ctx.contactId)
          .eq("brokerage_id", ctx.brokerageId)
          .maybeSingle()
        if (error || !contact) return { success: false, error: error?.message ?? "Contact not found" }
        const { data: activities } = await svc
          .from("activities")
          .select("activity_type, title, status, scheduled_at, completed_at")
          .eq("contact_id", ctx.contactId)
          .order("created_at", { ascending: false })
          .limit(5)
        return {
          success: true,
          kind: "contact" as const,
          name: `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim() || "(no name on file)",
          contactType: contact.contact_type,
          persona: contact.contact_persona,
          buyerStage: contact.buyer_stage,
          status: contact.status,
          lastContactedAt: contact.last_contacted_at,
          recentActivity: activities ?? [],
        }
      }
      if (ctx.leadId) {
        const { data: lead, error } = await svc
          .from("leads")
          .select("id, first_name, last_name, lead_stage, lead_score, lifecycle_state")
          .eq("id", ctx.leadId)
          .eq("brokerage_id", ctx.brokerageId)
          .maybeSingle()
        if (error || !lead) return { success: false, error: error?.message ?? "Lead not found" }
        return {
          success: true,
          kind: "lead" as const,
          name: `${lead.first_name ?? ""} ${lead.last_name ?? ""}`.trim() || "(no name on file)",
          leadStage: lead.lead_stage,
          leadScore: lead.lead_score,
          lifecycleState: lead.lifecycle_state,
          recentActivity: [],
        }
      }
      return { success: false, error: "No contact or lead is linked to this conversation yet" }
    },
  })
}

/**
 * request_showing — calendar/showing booking. contact_id is LOCKED from ctx
 * (never a model argument, unlike staff's schedule_follow_up) — an anonymous
 * or pre-capture conversation with neither contactId nor leadId simply has no
 * tool to call (buildCustomerContextTools omits it entirely, see below).
 */
function buildRequestShowingTool(ctx: CustomerContextToolsContext & { contactId: string }) {
  return tool({
    description: "Request a showing, call, or meeting for YOURSELF. For a showing of one of OUR listings, pass its listing_id: when the brokerage takes live bookings you get REAL open times from the agent's calendar — offer two or three, then call again with the slot_start they pick and it is booked on the calendar. Otherwise (or for a call/meeting) it logs the request and notifies your agent, who confirms a specific time — say so; never claim a time is confirmed unless this tool returned mode 'booked'.",
    inputSchema: z.object({
      meeting_type: z.enum(["call", "meeting", "showing"]).describe("What kind of meeting was requested"),
      preferred_window: z.string().nullable().describe("Free-text time preference if mentioned, or null"),
      notes: z.string().describe("Any details given (property of interest, etc.)"),
      listing_id: z.string().nullable().optional().describe("For a showing of one of OUR listings: the id returned by search_our_listings/get_listing_details. Otherwise null"),
      slot_start: z.string().nullable().optional().describe("ONLY after this tool returned open times: the exact startTime the person picked. Otherwise null"),
    }),
    execute: async ({ meeting_type, preferred_window, notes, listing_id, slot_start }: { meeting_type: "call" | "meeting" | "showing"; preferred_window: string | null; notes: string; listing_id?: string | null; slot_start?: string | null }) => {
      // LANE 86D — CALENDAR-AWARE SHOWINGS on the ONE self-booking engine
      // (lib/kernel/self-book.ts — the portal's "book a tour" survivor: the
      // listing agent's live free/busy ∪ scheduled showings, opt-in per
      // brokerage, the NAR-settlement BBA gate, slot re-verified at booking).
      // Competitors book showings inside the conversation (lane86D notes);
      // this tool only ever logged a request with a placeholder "now" time.
      // Falls through to the request path below whenever live booking is not
      // available — never a promise the calendar did not make.
      let bookingNote: string | null = null
      if (meeting_type === "showing" && listing_id) {
        const live = await tryLiveShowingBooking(ctx, listing_id, slot_start ?? null)
        if (live.kind !== "fallback") return live.result
        bookingNote = live.reason
      }
      const result = await requestShowingFallback(ctx, meeting_type, preferred_window, [bookingNote ? `Live booking unavailable: ${bookingNote}` : null, notes].filter(Boolean).join("\n"))
      return result.success ? { ...result, mode: "requested" as const } : result
    },
  })
}

type LiveShowingAttempt =
  | { kind: "slots" | "booked" | "slot_gone"; result: Record<string, unknown> }
  | { kind: "fallback"; reason: string }

/** Lane 86D — the live half of request_showing. Tenant-pinned: the listing
 *  must be THIS brokerage's (a model-supplied id for another tenant's listing
 *  must not even read its agent's availability). Contact is ctx-locked. */
async function tryLiveShowingBooking(
  ctx: CustomerContextToolsContext & { contactId: string },
  listingId: string,
  slotStart: string | null,
): Promise<LiveShowingAttempt> {
  const svc = createServiceClient()
  const { data: listing, error: listingError } = await svc.from("listings")
    .select("id, brokerage_id").eq("id", listingId).eq("brokerage_id", ctx.brokerageId).maybeSingle()
  if (listingError) return { kind: "fallback", reason: `listing read refused (${listingError.message})` }
  if (!listing) return { kind: "fallback", reason: "that listing is not one of ours" }
  const { loadBookableSlots, bookShowingSlot } = await import("@/lib/kernel/self-book")
  if (!slotStart) {
    const avail = await loadBookableSlots(svc, listingId)
    if (!avail.enabled || avail.slots.length === 0) return { kind: "fallback", reason: avail.reason ?? "no open times in the booking window" }
    return {
      kind: "slots",
      result: {
        success: true, mode: "choose_slot",
        slots: avail.slots.slice(0, 6).map((s) => ({ startTime: s.startTime, endTime: s.endTime })),
        instruction: "Offer two or three of these times in plain words. When they pick one, call request_showing again with the same listing_id and slot_start set to that startTime.",
      },
    }
  }
  const booked = await bookShowingSlot(svc, { listingId, contactId: ctx.contactId, slotStartIso: slotStart, via: "ai_agent" })
  if (booked.ok) return { kind: "booked", result: { success: true, mode: "booked", showingId: booked.showingId, slotStart } }
  if (booked.errorCode === "slot_gone") {
    const again = await loadBookableSlots(svc, listingId)
    return { kind: "slot_gone", result: { success: false, mode: "choose_slot", error: booked.error, slots: again.slots.slice(0, 6).map((s) => ({ startTime: s.startTime, endTime: s.endTime })) } }
  }
  // not_enabled / bba_required / not_found / insert refused → the agent handles it.
  return { kind: "fallback", reason: booked.error ?? booked.errorCode ?? "booking refused" }
}

/** The pre-86D request path, unchanged: an activity for the agent to confirm + the bell. */
async function requestShowingFallback(
  ctx: CustomerContextToolsContext & { contactId: string },
  meeting_type: "call" | "meeting" | "showing",
  preferred_window: string | null,
  notes: string,
): Promise<{ success: true; meetingType: string; activityId: string } | { success: false; error: string }> {
  const activityType = meeting_type === "call" ? "call" : meeting_type === "showing" ? "showing" : "meeting"
  const result = await writeFollowUpActivity({
    brokerageId: ctx.brokerageId,
    agentId: ctx.agentId ?? null,
    contactId: ctx.contactId,
    activityType,
    // No date resolved yet — the agent confirms a real time; this timestamp is a
    // placeholder "now" so the row sorts into the near-term queue, same posture as
    // lib/ai-isa/tools.ts's request_appointment (which logs intent, not a time).
    scheduledAt: new Date().toISOString(),
    notes: [preferred_window ? `Preferred: ${preferred_window}` : null, notes].filter(Boolean).join("\n"),
    title: `Showing/meeting requested: ${meeting_type}`,
  })
  if (!result.success) return { success: false, error: result.error }
  if (ctx.agentId) {
    const svc = createServiceClient()
    const { data: agent } = await svc.from("agents").select("user_id").eq("id", ctx.agentId).maybeSingle()
    if (agent?.user_id) {
      await sentinelWrite(svc, svc.from("notifications").insert({
        user_id: agent.user_id,
        brokerage_id: ctx.brokerageId,
        type: "appointment_request",
        title: "A client requested a showing/meeting via AI chat",
        body: `${meeting_type}${preferred_window ? ` (${preferred_window})` : ""}`,
        priority: "high",
        entity_type: "contact",
        entity_id: ctx.contactId,
      }), { table: "notifications", flow: "customer_context_tools_notify", brokerageId: ctx.brokerageId, reason: "in-app notification — a lost row is a missed bell, never the business write it follows" })
    }
  }
  return { success: true, meetingType: meeting_type, activityId: result.activityId }
}

/**
 * search_our_listings — free listing lookup from OUR OWN `listings` table
 * (never a paid vendor call), scoped to the brokerage and active/coming-soon/
 * pending statuses. Every persona gets this — it costs the platform nothing.
 */
function buildSearchOurListingsTool(ctx: CustomerContextToolsContext) {
  return tool({
    description: "Search this brokerage's OWN active listings by city/state/zip/price range/beds/baths. Free — always try this before a paid property-data tool.",
    inputSchema: z.object({
      city: z.string().nullable().describe("City, or null"),
      state: z.string().nullable().describe("Two-letter state code, or null"),
      zip: z.string().nullable().describe("ZIP code, or null"),
      min_price: z.number().nullable().describe("Minimum list price, or null"),
      max_price: z.number().nullable().describe("Maximum list price, or null"),
      min_beds: z.number().nullable().describe("Minimum bedrooms, or null"),
    }),
    execute: async (args: { city: string | null; state: string | null; zip: string | null; min_price: number | null; max_price: number | null; min_beds: number | null }) => {
      const svc = createServiceClient()
      let q = svc
        .from("listings")
        .select("id, address, city, state, zip, list_price, bedrooms, bathrooms, property_type, status")
        .eq("brokerage_id", ctx.brokerageId)
        .in("status", ["active", "coming_soon", "pending"])
        .limit(10)
      if (args.city) q = q.ilike("city", `%${args.city}%`)
      if (args.state) q = q.eq("state", args.state.toUpperCase())
      if (args.zip) q = q.eq("zip", args.zip)
      if (args.min_price !== null) q = q.gte("list_price", args.min_price)
      if (args.max_price !== null) q = q.lte("list_price", args.max_price)
      if (args.min_beds !== null) q = q.gte("bedrooms", args.min_beds)
      const { data, error } = await q
      if (error) return { success: false, error: error.message }
      return { success: true, listings: data ?? [] }
    },
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// FOLLOW-UP ACTIONS (lane 74B) — owner verbatim: "they can setup followup
// whether calling them again when they are ready, sending a list of
// properties that they just told us their criteria for, setting up a time to
// look up their property value and give them a call back to discuss or did
// they want to setup an appt for an agent to come out to discuss/no
// obligation, etc." These are the ACTION half of
// lib/ai-isa/qualification-playbook.ts's follow-up menu — every one FREE (no
// vendor spend beyond schedule_home_value_review's AVM chain, which is
// RentCast-first and skips BatchData when the platform tier says off),
// contactId/leadId-LOCKED from `ctx` exactly like request_showing above
// (never a model-suppliable id), every write via `sentinelWrite`, and every
// action PUBLISHES the existing kernel manager-signal bus (lib/kernel/
// manager-signals.ts) so the ISA/agent loops pick it up autonomously — the
// signal types are registered in lib/kernel/signal-registry.ts's
// SIGNAL_REGISTRY with a real SIGNAL_HANDLERS consumer, never fire-and-lost.
//
// activities.contact_id is NOT NULL (scripts/schema-snapshot.ts) — a
// pre-conversion lead thread (leadId, no contactId yet) cannot get an
// `activities` row, so the callback/appointment actions fall back to
// `leads.next_followup_at`/`next_followup_reason` (the lead-stage
// equivalent, already writer-and-reader-live — lib/ai-isa's own nurture
// cron reads it) rather than silently doing nothing for the majority of ISA
// email conversations, which run lead-only until qualification.
// ─────────────────────────────────────────────────────────────────────────────

// TOMBSTONE (lane 75B) — scheduleFollowUp / notifyAssignedAgent /
// publishQualificationSignal moved to lib/ai-isa/qualification-signals.ts
// (imported above), for the same import-cycle reason as writeFollowUpActivity.

/**
 * schedule_callback — "call them again when they're ready." PERSONA-SCOPED
 * (wave 75, owner verbatim): "if a person says to call back again, that lead
 * has not been qualified yet and the ai isa needs to call them back."
 *
 *   • LEAD (no contactId yet): SUPERSEDED wave 91 (owner: "If the lead needs a
 *     callback, that is a positive intent so that lead gets converted." · "no
 *     sms or calls" to a lead). The lead CONVERTS first
 *     (callback-task.ts::convertLeadOnCallbackIntent → the existing converters)
 *     and the callback lands on the assigned agent's contact via the CONTACT
 *     branch. The wave-75 "AI ISA dials the lead itself" branch is gone.
 *   • CONTACT (already qualified/converted): unchanged — the agent-side
 *     follow-up (an `activities` row, the agent notified, a gated
 *     confirmation signal).
 *
 * TOMBSTONE: before this fix, a LEAD's callback ask only deferred nurture
 * (`leads.next_followup_at`/`next_followup_reason` — read ONLY by the
 * reactivation enroller's "don't nag before this date" check, never by
 * anything that actually PLACES a call) and published a manager signal whose
 * handler (lib/kernel/manager-signals.ts `proposeQualificationConfirmation`)
 * no-ops for a lead-stage thread ("no contact linked yet"). The promise "I'll
 * have someone call you back" produced a note and nothing behind it — the
 * exact defect wave 55's ruling on the RECEPTION brain already fixed for
 * VOICE callbacks (lib/ai-isa/callback-task.ts), just never reached this
 * TEXT/EMAIL-side follow-up tool. This wires the SAME survivor in, rather
 * than building a second one.
 */
export function buildScheduleCallbackTool(ctx: CustomerContextToolsContext) {
  return tool({
    description: "Schedule a callback for when THEY say they're ready — not now, but later. Use when the person is interested but wants to be called back rather than continue right now.",
    inputSchema: z.object({
      when_iso: z.string().nullable().describe("The callback time as an ISO 8601 timestamp, if you can resolve one from what they said, else null"),
      when_description: z.string().describe("The person's own words for when — e.g. \"next week\", \"after I talk to my spouse\""),
      notes: z.string().describe("Why they want a callback / what to follow up on"),
    }),
    execute: async ({ when_iso, when_description, notes }: { when_iso: string | null; when_description: string; notes: string }) => {
      const isoIsUsable = !!when_iso && !Number.isNaN(Date.parse(when_iso))

      // ── LEAD, NOT YET QUALIFIED — CONVERT FIRST (wave 91, lane 91B) ──────────────
      // Owner, verbatim (2026-09-30): "If the lead needs a callback, that is a positive intent so
      // that lead gets converted." and "Leads usually are non consenting so no sms or calls allowed
      // only email and direct mail." The wave-75 branch that sat here had the AI ISA DIAL THE LEAD
      // (createCallbackTask keyed to the lead → the executor cron) — the call the second ruling
      // forbids. TOMBSTONE: that branch is replaced by the ONE conversion hop
      // (lib/ai-isa/callback-task.ts::convertLeadOnCallbackIntent → the existing
      // convertSellerLeadOnIntent / convertBuyerLeadOnIntent); the callback then lands on the
      // assigned agent's CONTACT through the contact branch below — the same writer
      // schedule_home_value_review already uses (lane 90C). A refused conversion is returned,
      // never turned into a call to the lead.
      if (ctx.leadId && !ctx.contactId) {
        const svc = createServiceClient()
        const { convertLeadOnCallbackIntent } = await import("@/lib/ai-isa/callback-task")
        const converted = await convertLeadOnCallbackIntent(svc, { brokerageId: ctx.brokerageId, leadId: ctx.leadId })
        if (!converted.ok || !converted.contactId) {
          await scheduleFollowUp(ctx, {
            activityType: "call",
            scheduledAt: isoIsUsable ? (when_iso as string) : new Date().toISOString(),
            notes: [`They said: ${when_description}`, notes, `(callback is positive intent but the conversion was refused: ${converted.error ?? "unknown"} — a person must convert and call)`].filter(Boolean).join("\n"),
            title: "Callback requested — conversion refused",
          })
          return { success: false, error: `the lead could not be converted before its callback (${converted.error ?? "unknown"}) — recorded for a person; a lead is never called` }
        }
        ctx.contactId = converted.contactId
        if (!ctx.agentId) ctx.agentId = converted.agentId ?? null
      }

      // ── CONTACT (already qualified/converted) — unchanged: the agent-side follow-up ──
      const scheduledAt = isoIsUsable ? (when_iso as string) : new Date().toISOString()
      const result = await scheduleFollowUp(ctx, {
        activityType: "call",
        scheduledAt,
        notes: [`They said: ${when_description}`, notes].filter(Boolean).join("\n"),
        title: "Callback requested via AI qualification",
      })
      if (!result.success) return { success: false, error: result.error }
      await notifyAssignedAgent(ctx, {
        type: "qualification_callback_requested",
        title: "Client asked for a callback",
        body: `${when_description}${notes ? ` — ${notes}` : ""}`,
        entityType: "contact",
        entityId: ctx.contactId as string,
      })
      await publishQualificationSignal({
        brokerageId: ctx.brokerageId,
        toManager: "shopping_agent",
        signalType: "qualification_call_requested",
        message: `AI qualification scheduled a callback: ${when_description}`,
        contactId: ctx.contactId ?? null,
        leadId: null,
      })
      return { success: true, scheduledVia: result.via }
    },
  })
}

/** send_matching_listings — "sending a list of properties that they just
 *  told us their criteria for." Own DB FIRST (free), RentCast active
 *  listings NEXT (via the existing eligibility resolver — searchRentcastSaleListings
 *  itself gates through lib/property/rentcast-eligibility.ts), then
 *  enrolls/creates a property_alerts row (the existing listing-alert table —
 *  lib/buyer-search/conversation-criteria.ts's shape) so it keeps sending. */
export function buildSendMatchingListingsTool(ctx: CustomerContextToolsContext) {
  return tool({
    description: "Send the properties matching the buyer/renter/investor criteria they just described, and keep sending as new matches come in. Use once they've given you at least an area or a price range. Set listing_type to 'rent' for a renter (monthly rent budget) — our own listings first, then RentCast sale or RENTAL listings.",
    inputSchema: z.object({
      listing_type: z.enum(["sale", "rent"]).nullable().describe("'rent' for a renter, else 'sale' (default)"),
      city: z.string().nullable(),
      state: z.string().nullable().describe("Two-letter state code, or null"),
      zip: z.string().nullable(),
      min_price: z.number().nullable().describe("Min list price, or min MONTHLY rent when listing_type is rent"),
      max_price: z.number().nullable().describe("Max list price, or max MONTHLY rent when listing_type is rent"),
      min_beds: z.number().nullable(),
      min_baths: z.number().nullable(),
      property_type: z.string().nullable().describe("e.g. Single Family, Condo, Townhouse — or null"),
      buyer_words: z.string().nullable().optional().describe("The buyer's OWN sentence(s) stating what they want, copied verbatim (e.g. '3 bed under 450 in Frisco, need a yard') — the criteria parser fills anything the fields above left null. Or null."),
    }),
    execute: async (rawArgs: {
      listing_type?: "sale" | "rent" | null
      city: string | null; state: string | null; zip: string | null
      min_price: number | null; max_price: number | null; min_beds: number | null; min_baths: number | null
      property_type: string | null
      buyer_words?: string | null
    }) => {
      const svc = createServiceClient()
      // LANE 91C — THE ONE NL CRITERIA PARSER (lib/buyer-search/parse-buyer-
      // criteria.ts). The model's structured fields STAND; the parser fills
      // only what they left null, from the buyer's literal words — a city off
      // the model's radar, a ZIP, the "need a yard" feature that has no field
      // above. Features ride into the standing alert's must_have_features.
      // Its spend books to THIS tenant (ctx.brokerageId, bound by the surface).
      const args = { ...rawArgs }
      let parsedFeatures: string[] = []
      let criteriaNotes: string[] = []
      let criteriaGapsOpen: string[] = []
      if (rawArgs.buyer_words && rawArgs.buyer_words.trim().length >= 5) {
        const { parseBuyerCriteria } = await import("@/lib/buyer-search/parse-buyer-criteria")
        const parsed = await parseBuyerCriteria(rawArgs.buyer_words, { brokerageId: ctx.brokerageId })
        const c = parsed.criteria
        if (!args.city && !args.zip && c.cities?.length) args.city = c.cities[0]
        if (!args.zip && !args.city && c.zipCodes?.length) args.zip = c.zipCodes[0]
        if (!args.state && c.state) args.state = c.state
        if (args.min_price == null && args.max_price == null) { args.min_price = c.minPrice ?? null; args.max_price = c.maxPrice ?? null }
        if (args.min_beds == null && c.minBeds != null) args.min_beds = c.minBeds
        if (args.min_baths == null && c.minBaths != null) args.min_baths = c.minBaths
        if (!args.property_type && c.propertyTypes?.length) args.property_type = c.propertyTypes[0]
        if (!args.listing_type && c.listingType === "rent") args.listing_type = "rent"
        parsedFeatures = c.features ?? []
        criteriaNotes = parsed.notes
        criteriaGapsOpen = parsed.gaps
      }
      // RentCast searches a city only WITH a state. A city the buyer named
      // without one takes the tenant's own state (the rule alert-engine.ts
      // resolveAlertSearchState applies to saved searches) — read with its
      // error, never guessed.
      if (args.city && !args.state && !args.zip) {
        const { data: tenant, error: tenantError } = await svc.from("brokerages").select("state").eq("id", ctx.brokerageId).maybeSingle()
        if (tenantError) console.error(`[send_matching_listings] brokerage state read refused (brokerage ${ctx.brokerageId}): ${tenantError.message}`)
        args.state = (tenant as { state?: string | null } | null)?.state ?? null
      }
      const forRent = args.listing_type === "rent"
      const listings: Array<Record<string, unknown>> = []

      // 1. Own DB — free, always tried first. The live `listings` table is
      // FOR-SALE inventory (status/property_type CHECKs carry no rental
      // spelling — scripts/check-vocabularies.ts), so a rental search goes
      // straight to RentCast's rental endpoint rather than matching our
      // for-sale rows against a monthly-rent budget (blind spot published in
      // the lane notes: no own-DB rental inventory exists to search).
      if (!forRent) {
        let ownQuery = svc.from("listings")
          .select("id, address, city, state, zip, list_price, bedrooms, bathrooms, property_type, status")
          .eq("brokerage_id", ctx.brokerageId).in("status", ["active", "coming_soon", "pending"]).limit(10)
        if (args.city) ownQuery = ownQuery.ilike("city", `%${args.city}%`)
        if (args.state) ownQuery = ownQuery.eq("state", args.state.toUpperCase())
        if (args.zip) ownQuery = ownQuery.eq("zip", args.zip)
        if (args.min_price !== null) ownQuery = ownQuery.gte("list_price", args.min_price)
        if (args.max_price !== null) ownQuery = ownQuery.lte("list_price", args.max_price)
        if (args.min_beds !== null) ownQuery = ownQuery.gte("bedrooms", args.min_beds)
        // THE ERROR IS READ (§3) — a refused read of our own board is not "we
        // have nothing"; RentCast still runs below and the refusal is reported.
        const { data: ownListings, error: ownError } = await ownQuery
        if (ownError) console.error(`[send_matching_listings] own listings read refused (brokerage ${ctx.brokerageId}): ${ownError.message}`)
        for (const l of ownListings ?? []) listings.push({ ...l, source: "our_listings" })
      }

      // 2. RentCast active listings — only when our own inventory is thin, and
      // only when this brokerage is eligible (both readers gate through the
      // SAME resolveRentcastEligibility every AVM/comp reader uses). Rental
      // mode uses the RENTAL endpoint (searchRentcastRentalListings — the
      // reader wave 66 corrected to the same range syntax as the sale reader).
      //
      // LANE 91C: recency-windowed (owner, wave 91: "we should only pull more
      // recent data" — BUYER_LISTING_RECENCY_DAYS → RentCast `daysOld`), and
      // only with a searchable AREA (a ZIP, or a city with its state): an
      // area-less RentCast call is a paid national sweep scored against a
      // buyer who named no place. Never BatchData — this is the buyer listing
      // path (scripts/buyer-nl-search-simulator.ts holds that).
      let rentcastSkipped: string | null = null
      if (listings.length < 10 && !(args.zip || (args.city && args.state))) {
        rentcastSkipped = "No city+state or ZIP yet — ask where they are looking before pulling listings."
      } else if (listings.length < 10) {
        const { searchRentcastSaleListings, searchRentcastRentalListings } = await import("@/lib/property/rentcast")
        const search = forRent ? searchRentcastRentalListings : searchRentcastSaleListings
        const rc = await search({
          brokerageId: ctx.brokerageId,
          contactId: ctx.contactId ?? null,
          filters: {
            city: args.city ?? undefined,
            state: args.state ?? undefined,
            zipCode: args.zip ?? undefined,
            bedroomsMin: args.min_beds ?? undefined,
            bathroomsMin: args.min_baths ?? undefined,
            priceMin: args.min_price ?? undefined,
            priceMax: args.max_price ?? undefined,
            propertyType: args.property_type ?? undefined,
            limit: 10 - listings.length,
            listedWithinDays: BUYER_LISTING_RECENCY_DAYS,
          },
        })
        if (rc.success) {
          for (const l of rc.listings) listings.push({ ...l, source: forRent ? "rentcast_rental" : "rentcast" })
        }
      }

      // 3. Enroll/create the existing listing-alert record so it keeps
      // sending — contact-only (property_alerts.contact_id is NOT NULL).
      //
      // LANE 90C — THE LEAD BRANCH USED TO END THE LOOP. A lead-only thread got
      // today's list and "no standing alert until they convert" — but nothing
      // converted it, so the tool's own promise ("keep sending as new matches
      // come in") was never kept for the majority of ISA threads, which run
      // lead-only until qualification. Buyer criteria ARE positive intent: the
      // inbound-reply classifier already routes the same words to
      // convertBuyerLeadOnIntent(reason:"criteria_request") (lib/ai-isa/
      // inbound-intent-classifier.ts) — the ONE canonical hop (acceptAIISAHandoff
      // → consented → assigned → contact, property_preferences captured, the
      // Shopping Agent owns the buyer from here). Same survivor, never a second
      // converter; the alert below then enrolls the CONTACT it became. A refused
      // conversion (representation, lead gone) is REPORTED — the lead stays in
      // the ISA's own nurture plan (advanceLeadActionPlans), which is the loop
      // that continues for an unconverted lead.
      let conversion: { ok: boolean; contactId?: string; error?: string; alreadyConverted?: boolean } | null = null
      if (!ctx.contactId && ctx.leadId) {
        const { convertBuyerLeadOnIntent } = await import("@/lib/ai-isa/convert-buyer-lead-on-intent")
        const converted = await convertBuyerLeadOnIntent({
          brokerageId: ctx.brokerageId,
          leadId: ctx.leadId,
          reason: "criteria_request",
          criteria: {
            minPrice: args.min_price, maxPrice: args.max_price,
            minBeds: args.min_beds, minBaths: args.min_baths,
            cities: args.city ? [args.city] : [], zipCodes: args.zip ? [args.zip] : [],
            propertyTypes: args.property_type ? [args.property_type] : [],
          },
        })
        conversion = { ok: converted.success && !!converted.contactId, contactId: converted.contactId, error: converted.error, alreadyConverted: converted.alreadyConverted }
        // The rest of this turn (and the alert below) operates on the contact
        // the lead became — the same ctx mutation the platform bundle uses.
        if (conversion.ok) ctx.contactId = converted.contactId ?? null
      }
      //
      // RENTERS ARE ENROLLED TOO (lane 77C, blind spot closed). This used to
      // skip a renter (`!forRent`) because property_alerts could not say which
      // market a row meant, and lib/property-alerts/idx-alert-search.ts would
      // have re-run a MONTHLY budget against for-sale list prices every sweep.
      // m657 (supabase/migrations/m657-property-alerts-listing-type.sql —
      // WRITTEN, NOT APPLIED until the integrator flips its header) adds
      // property_alerts.listing_type (sale|rent, default sale), and the sweep
      // now routes a 'rent' row to RentCast's rental endpoint only. The
      // spelling comes from ONE constant (PROPERTY_ALERT_LISTING_TYPES,
      // lib/property-alerts/alert-matcher.ts), never a second literal here.
      //
      // THE INSERT'S ERROR IS READ (§3). Until m657 is applied, naming
      // `listing_type` on this insert is a PGRST204 — the WHOLE row is refused,
      // not "most of it" — and supabase-js resolves that refusal. Dropping the
      // error here would report `alertEnrolled: false` with no trace of why, so
      // the refusal is logged with the column it names.
      let alertId: string | null = null
      if (ctx.contactId) {
        const listingType = forRent ? "rent" : "sale"
        const marker = `[AI_QUALIFICATION:${[listingType, args.city, args.state, args.zip, args.min_price, args.max_price, args.min_beds].join(":")}]`
        const { data: existing } = await svc.from("property_alerts").select("id")
          .eq("contact_id", ctx.contactId).ilike("alert_name", `%${marker}%`).limit(1).maybeSingle()
        if (existing) {
          alertId = existing.id
        } else {
          const { data: created, error: enrollError } = await svc.from("property_alerts").insert({
            brokerage_id: ctx.brokerageId,
            contact_id: ctx.contactId,
            agent_user_id: null,
            alert_name: `AI-qualified ${listingType === "rent" ? "rental" : "buyer"} criteria ${marker}`,
            // property_alerts.source CHECK vocabulary (scripts/check-vocabularies.ts):
            // the AI agent captured these criteria in a text conversation.
            source: "text_conversation",
            // property_alerts.listing_type (m657) — PROPERTY_ALERT_LISTING_TYPES.
            listing_type: listingType,
            is_active: true,
            min_price: args.min_price, max_price: args.max_price,
            bedrooms_min: args.min_beds, bathrooms_min: args.min_baths,
            property_types: args.property_type ? [args.property_type] : [],
            cities: args.city ? [args.city] : [],
            zip_codes: args.zip ? [args.zip] : [],
            must_have_features: parsedFeatures, keywords: null,
            new_listings_only: true, include_coming_soon: true, include_price_reductions: true,
            price_reduction_min_percent: 2, frequency: "daily",
            delivery_channels: ["email", "in_app"], max_results_per_alert: 10,
          }).select("id").maybeSingle()
          if (enrollError) {
            console.error(`[send_matching_listings] property_alerts enrollment refused for contact ${ctx.contactId} (brokerage ${ctx.brokerageId}, listing_type ${listingType}): ${enrollError.message}`)
          }
          alertId = created?.id ?? null
        }
      }

      await publishQualificationSignal({
        brokerageId: ctx.brokerageId,
        toManager: "shopping_agent",
        signalType: "qualification_criteria_captured",
        message: `AI qualification captured buyer criteria (${listings.length} matches sent now)`,
        contactId: ctx.contactId ?? null,
        leadId: ctx.leadId ?? null,
        payload: { criteria: args, matchCount: listings.length, alertId },
      })

      return {
        success: true,
        listings: listings.slice(0, 10),
        alertEnrolled: !!alertId,
        // Lane 91C — what the criteria parser could not turn into a filter
        // (school quality, …) and which concrete criteria are still missing,
        // so the reply asks the next question instead of guessing.
        ...(criteriaNotes.length ? { criteriaNotes } : {}),
        ...(criteriaGapsOpen.length ? { stillNeed: criteriaGapsOpen } : {}),
        ...(rentcastSkipped ? { listingFeedSkipped: rentcastSkipped } : {}),
        recencyWindowDays: rentcastSkipped ? null : BUYER_LISTING_RECENCY_DAYS,
        // Honest: the model is told when the standing alert could NOT be set up
        // (a refused conversion), so it never promises "I'll keep sending".
        ...(conversion ? { convertedToContact: conversion.ok, conversionError: conversion.ok ? null : (conversion.error ?? "conversion refused") } : {}),
      }
    },
  })
}

/** schedule_home_value_review — "setting up a time to look up their
 *  property value and give them a call back to discuss." Runs the AVM
 *  chain (lib/avm/provider-chain.ts) — RentCast first; BatchData only when
 *  the chain reaches it AND the platform BatchData tool tier is not "off" —
 *  then books a callback the same way schedule_callback does. */
export function buildScheduleHomeValueReviewTool(ctx: CustomerContextToolsContext) {
  return tool({
    description: "For someone selling: record the property address, look up an estimated value, and schedule a callback to discuss it. Use when they mention selling or ask what their home is worth.",
    inputSchema: z.object({
      property_address: z.string().describe("The address of the property they're selling"),
      zip_code: z.string().nullable(),
      preferred_callback_window: z.string().describe("Their own words for when to call back"),
    }),
    execute: async ({ property_address, zip_code, preferred_callback_window }: { property_address: string; zip_code: string | null; preferred_callback_window: string }) => {
      const svc = createServiceClient()

      // LANE 90C — THE LEAD BRANCH USED TO END THE LOOP. For a lead-only thread
      // this tool wrote leads.next_followup_at (read ONLY by the nurture
      // enroller's "don't nag before this date" check — nothing places a call)
      // and notified an agent the lead does not have. The promised "callback to
      // discuss the value" never happened, and by ruling the AI never speaks the
      // number, so nobody did. Asking what the home is worth IS positive intent:
      // the inbound-reply classifier routes the same words to
      // convertSellerLeadOnIntent(reason:"cma_request") — the canonical hop that
      // converts, assigns an agent, and PROPOSES the draft CMA on the contact so
      // the agent has the value teed up for the call. The callback below then
      // lands as the assigned agent's `activities` row (writeFollowUpActivity)
      // instead of a dead lead column. Same survivor, never a second converter.
      let conversionError: string | null = null
      if (!ctx.contactId && ctx.leadId) {
        const { convertSellerLeadOnIntent } = await import("@/lib/ai-isa/convert-seller-lead-on-intent")
        const converted = await convertSellerLeadOnIntent({
          brokerageId: ctx.brokerageId,
          leadId: ctx.leadId,
          reason: "cma_request",
          propertyData: { address: property_address, zip: zip_code ?? undefined },
        })
        if (converted.success && converted.contactId) {
          ctx.contactId = converted.contactId
          if (!ctx.agentId) {
            const { data: c, error: cErr } = await svc.from("contacts").select("agent_id").eq("id", converted.contactId).eq("brokerage_id", ctx.brokerageId).maybeSingle()
            if (cErr) console.error(`[schedule_home_value_review] contact agent read refused: ${cErr.message}`)
            ctx.agentId = (c as { agent_id?: string | null } | null)?.agent_id ?? null
          }
        } else {
          conversionError = converted.error ?? "conversion refused"
          console.error(`[schedule_home_value_review] lead ${ctx.leadId} NOT converted on cma_request: ${conversionError}`)
        }
      }

      // Record the address they gave us — contacts.address / leads.address,
      // the SAME column every other seller-facing reader already treats as
      // "the property they own" (no new column).
      if (ctx.contactId) {
        await sentinelWrite(svc, svc.from("contacts").update({ address: property_address }).eq("id", ctx.contactId).eq("brokerage_id", ctx.brokerageId),
          { table: "contacts", flow: "qualification_home_value", brokerageId: ctx.brokerageId })
      } else if (ctx.leadId) {
        await sentinelWrite(svc, svc.from("leads").update({ address: property_address }).eq("id", ctx.leadId).eq("brokerage_id", ctx.brokerageId),
          { table: "leads", flow: "qualification_home_value", brokerageId: ctx.brokerageId })
      }

      // NEVER RUN OR SPEAK A VALUE HERE. Owner ruling (wave 75 verbatim):
      // "never give the person a value over the conversation since that is
      // what the agent will speak about once they talk." This tool used to
      // call lib/avm/provider-chain.ts::getCurrentAvm and return/notify a
      // dollar figure — REMOVED. The address is recorded and the callback is
      // booked; the value is prepared by the AGENT ahead of the call (when
      // the callback is escalated to an on-site visit, book_listing_
      // appointment's calendar_events row is what the listing-presentation-
      // prep cron — app/api/cron/listing-presentation-prep/route.ts — picks
      // up to run the REAL CMA for the agent's own prep, never spoken by the
      // AI). Positive control: scripts/qualification-playbook-simulator.ts
      // asserts a fixture literal `$` figure never reaches this tool's return.
      const result = await scheduleFollowUp(ctx, {
        activityType: "call",
        scheduledAt: new Date().toISOString(),
        notes: [
          `Property: ${property_address}`,
          "Value prepared by agent ahead of the call — never quoted by the AI.",
          `Preferred callback: ${preferred_callback_window}`,
        ].join("\n"),
        title: "Home value review — callback to discuss",
      })
      if (!result.success) return { success: false, error: result.error }

      await notifyAssignedAgent(ctx, {
        type: "qualification_home_value_requested",
        title: "Client wants a home value review",
        body: `${property_address} — prepare the valuation ahead of the callback (never quoted by the AI).`,
        entityType: ctx.contactId ? "contact" : "lead",
        entityId: (ctx.contactId ?? ctx.leadId) as string,
      })
      await publishQualificationSignal({
        brokerageId: ctx.brokerageId,
        toManager: "listing_concierge",
        signalType: "qualification_valuation_handoff",
        message: `AI qualification recorded a home-value address and booked a discuss-it callback (${property_address})`,
        contactId: ctx.contactId ?? null,
        leadId: ctx.leadId ?? null,
        payload: { propertyAddress: property_address },
      })

      return {
        success: true,
        callbackScheduled: true,
        // Honest: when the callback could only land on the lead column (no
        // agent to call), the model is told so rather than promising a call.
        callbackOwner: ctx.contactId && ctx.agentId ? ("agent" as const) : ("nurture_only" as const),
        ...(conversionError ? { conversionError } : {}),
        note: "The agent will prepare and discuss the value on the call — never state a number here.",
      }
    },
  })
}

// NOTE (wave 75 integration): lane 75B's capability catalogue lists
// book_listing_appointment as a brand-toggleable capability; the CALENDAR-BACKED
// implementation below (lane 75C) is the survivor and the catalogue's earliest-slot
// stand-in is tombstoned in lib/ai-isa/capability-catalogue.ts. The brand disable
// list (brokerage_settings.settings.ai_agent_capabilities.disabled) is honoured at
// the registration site in buildCustomerFreeTools.
/**
 * find_listing_appointment_slots / book_listing_appointment (wave 75C) —
 * "did they want to setup an appt for an agent to come out to discuss/no
 * obligation." Owner ruling: "the no obligation meeting should be marked as
 * a listing appointment so that the workflow creates the follow up until the
 * appt which should be at least a week out. since this is an appt for an
 * agent, the calendar should be hooked up so that the ai agent can find a
 * time and day that works for the person and set up the appt right then and
 * the agent just confirms it."
 *
 * TOMBSTONE (§1.1): buildBookAgentAppointmentTool (an activities/leads row
 * with a "now" placeholder timestamp — no calendar, no real time) is RETIRED.
 * Survivor: lib/ai-isa/listing-appointment.ts (findAgentAppointmentSlots +
 * bookListingAppointment), driven through these two tools:
 *   1. find_listing_appointment_slots — reads the assigned agent's connected
 *      calendar and offers real slots ≥ 7 days out (fails closed to a
 *      callback offer — never invents a slot).
 *   2. book_listing_appointment — books the person's chosen slot as a
 *      TENTATIVE hold; the agent confirms it from the existing action-queue
 *      rail (app/actions/portal-stream.ts::dispositionPortalEventAction), and
 *      confirmation is what fires the auto calendar emails + portal push +
 *      reminder cadence, per lib/ai-isa/listing-appointment.ts's own header.
 *
 * A LEAD caller (ctx.leadId, no ctx.contactId yet) is a positive-intent
 * signal — lane 75A's canonical hop converts it to a contact FIRST (never a
 * second converter): convertSellerLeadOnIntent(reason:"positive_reply"), no
 * `appointment` param, so it does ONLY the conversion + welcome, never its
 * own (pre-calendar) booking path — this tool then books the REAL,
 * calendar-backed appointment on the resulting contact.
 *
 * Never surfaces an AVM/home value in the result (owner ruling, wave 75:
 * "never give the person a value over the conversation") — this tool never
 * reads or returns one.
 */
export function buildFindListingAppointmentSlotsTool(ctx: CustomerContextToolsContext) {
  return tool({
    description: "Find real, available times for an agent's no-obligation listing appointment — at least a week out. Call this BEFORE book_listing_appointment; offer 2-3 of the returned times to the person in plain language and let them pick.",
    inputSchema: z.object({
      preferred_days: z.array(z.string()).nullable().describe("Weekday names they mentioned (e.g. [\"tuesday\",\"thursday\"]), or null"),
      preferred_window: z.enum(["morning", "afternoon", "evening"]).nullable().describe("Time-of-day preference, or null"),
    }),
    execute: async ({ preferred_days, preferred_window }: { preferred_days: string[] | null; preferred_window: "morning" | "afternoon" | "evening" | null }) => {
      // LANE 90C — a LEAD with no agent used to dead-end here ("No agent is
      // assigned yet — offer a callback instead"): the person asked for an agent
      // to come out and got a maybe-callback. Wanting the appointment IS the
      // positive_reply intent the booking tool below already converts on — do
      // the same canonical hop HERE, so Engine 2 assigns the agent whose
      // calendar the slots come from. ctx is updated for the rest of the turn.
      if (!ctx.agentId && !ctx.contactId && ctx.leadId) {
        const { convertSellerLeadOnIntent } = await import("@/lib/ai-isa/convert-seller-lead-on-intent")
        const converted = await convertSellerLeadOnIntent({ brokerageId: ctx.brokerageId, leadId: ctx.leadId, reason: "positive_reply" })
        if (converted.success && converted.contactId) {
          ctx.contactId = converted.contactId
          const svc = createServiceClient()
          const { data: c, error: cErr } = await svc.from("contacts").select("agent_id").eq("id", converted.contactId).eq("brokerage_id", ctx.brokerageId).maybeSingle()
          if (cErr) console.error(`[find_listing_appointment_slots] contact agent read refused: ${cErr.message}`)
          ctx.agentId = (c as { agent_id?: string | null } | null)?.agent_id ?? null
        } else {
          console.error(`[find_listing_appointment_slots] lead ${ctx.leadId} NOT converted on positive_reply: ${converted.error ?? "refused"}`)
        }
      }
      if (!ctx.agentId) return { success: false, error: "No agent is assigned yet — offer a callback instead." }
      const { findAgentAppointmentSlots } = await import("@/lib/ai-isa/listing-appointment")
      const result = await findAgentAppointmentSlots({
        brokerageId: ctx.brokerageId,
        agentId: ctx.agentId,
        preferredDays: preferred_days ?? undefined,
        preferredWindows: preferred_window ? [preferred_window] : undefined,
      })
      if (!result.success) {
        // FAIL CLOSED — never invent slots. Log a callback so the person is
        // still followed up on even though we couldn't offer a live time.
        await scheduleFollowUp(ctx, {
          activityType: "call",
          scheduledAt: new Date().toISOString(),
          notes: `Wanted a listing appointment but the agent's calendar isn't connected — call to set a time. (${result.reason})`,
          title: "Listing appointment — calendar unavailable, callback needed",
        }).catch(() => null)
        return { success: false, offerCallback: true, message: result.message }
      }
      return {
        success: true,
        slots: result.slots.map((s) => ({ start: s.startTime, end: s.endTime })),
        minDaysOut: result.minDaysOut,
      }
    },
  })
}

export function buildBookListingAppointmentTool(ctx: CustomerContextToolsContext) {
  return tool({
    description: "Book the no-obligation listing appointment on the SLOT the person chose from find_listing_appointment_slots. Nothing required of them — it's just a conversation. Do not call this before find_listing_appointment_slots has offered real times.",
    inputSchema: z.object({
      slot_start_iso: z.string().describe("The exact start time (ISO 8601) the person picked from the offered slots"),
      slot_end_iso: z.string().describe("The matching end time (ISO 8601) from the same offered slot"),
      property_address: z.string().describe("The address the agent is visiting to discuss"),
      notes: z.string().describe("What they want to discuss"),
    }),
    execute: async ({ slot_start_iso, slot_end_iso, property_address, notes }: { slot_start_iso: string; slot_end_iso: string; property_address: string; notes: string }) => {
      if (!ctx.agentId) return { success: false, error: "No agent is assigned yet — offer a callback instead." }

      // A LEAD converts to a CONTACT first — the canonical hop (lane 75A's
      // survivor), never a second converter. Positive intent to book an
      // appointment is exactly the "positive_reply" signal that path expects;
      // `reason:"appointment_request"` is deliberately NOT used here — that
      // reason's OWN internal booking path pre-dates the calendar-backed flow
      // this tool drives, so passing no `appointment` keeps it to
      // conversion + welcome only.
      let contactId = ctx.contactId ?? null
      if (!contactId && ctx.leadId) {
        const { convertSellerLeadOnIntent } = await import("@/lib/ai-isa/convert-seller-lead-on-intent")
        const converted = await convertSellerLeadOnIntent({
          brokerageId: ctx.brokerageId,
          leadId: ctx.leadId,
          reason: "positive_reply",
          propertyData: { address: property_address },
        })
        if (!converted.success || !converted.contactId) {
          return { success: false, error: converted.error ?? "Could not convert this lead before booking." }
        }
        contactId = converted.contactId
      }
      if (!contactId) return { success: false, error: "No contact or lead is linked to this conversation yet" }

      const { bookListingAppointment } = await import("@/lib/ai-isa/listing-appointment")
      const result = await bookListingAppointment({
        brokerageId: ctx.brokerageId,
        contactId,
        agentId: ctx.agentId,
        slot: { startTime: slot_start_iso, endTime: slot_end_iso },
        propertyAddress: property_address,
        notes,
      })
      if (!result.success) return { success: false, error: result.error }
      return {
        success: true,
        calendarEventId: result.calendarEventId,
        startAt: result.startAt,
        pendingAgentConfirmation: true,
      }
    },
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// record_qualification (lane 74B) — writes persona/criteria/address/timeline
// as the model learns them, to the columns that EXIST (scripts/schema-
// snapshot.ts): contacts.contact_persona / leads.persona (m589 vocabulary),
// contacts.timeline / leads.timeline (the live bucket CHECK — CLAUDE.md §5:
// never 30/60/90), contacts.lender_status / leads.lender_status (financing),
// contacts.property_type / leads.property_type, contacts.address /
// leads.address (a stated SELLER property — never invented), contact_type /
// lead_type ONLY for the buy/sell/both values that vocabulary actually
// admits (invest/rent/relocate are PERSONA/home_owner_status facts, not
// contact_type values — m593's own ruling, persona-tool-policy.ts §header),
// and property_preferences (buyer criteria — the SAME inferred_*/
// preferred_price_* columns lib/buyer-search/buyer-criteria.ts already
// reads, contact-only since property_preferences.contact_id has no lead
// twin). Every write via sentinelWrite; qualification_summary (present on
// BOTH tables) gets one appended line — the lightweight "history" trace.
// ─────────────────────────────────────────────────────────────────────────────

const RECORD_QUALIFICATION_PERSONAS = [
  "divorce", "downsize", "expired", "first_time", "foreclosure", "fsbo",
  "investor", "luxury", "military", "other", "probate", "relocated", "senior", "upsize",
] as const
const RECORD_QUALIFICATION_TIMELINES = [
  "immediate", "1-3_months", "3-6_months", "6-12_months", "12+_months", "researching",
] as const
const RECORD_QUALIFICATION_FINANCING = ["cash", "pre_approved", "needs_pre_approval", "unknown"] as const
// Lane 76A — the seller's SITUATION (what a listing agent asks before the
// appointment). No live column carries condition / reason / listing status
// (scripts/schema-snapshot.ts: contacts & leads have neither), so they land in
// qualification_summary — the appended one-line trace — EXCEPT listing_status
// 'fsbo' / 'expired', which ARE contact_persona/leads.persona CHECK values
// (m589) and are written there (one vocabulary, §6 — never a second spelling).
const RECORD_QUALIFICATION_CONDITION = ["move_in_ready", "needs_minor_updates", "needs_major_work", "unknown"] as const
const RECORD_QUALIFICATION_LISTING_STATUS = ["not_listed", "fsbo", "expired", "listed_with_agent", "unknown"] as const

export function buildRecordQualificationTool(ctx: CustomerContextToolsContext) {
  return tool({
    description: "Record what you've learned about this person's qualification — call this as soon as you learn ANY of: their intent (buy/sell/both/invest/rent/relocate), persona, the property they're selling, their seller situation (reason for moving, condition, whether it's listed/FSBO/expired, whether they also need to buy), buyer/renter criteria (incl. move-in date and pets for a renter), timeline, or financing status. Safe to call multiple times as more comes up.",
    inputSchema: z.object({
      intent: z.enum(["buy", "sell", "both", "invest", "rent", "relocate"]).nullable(),
      persona: z.enum(RECORD_QUALIFICATION_PERSONAS).nullable(),
      seller_property_address: z.string().nullable(),
      seller_situation: z.object({
        reason_for_move: z.string().nullable().describe("In their own words, or null"),
        condition: z.enum(RECORD_QUALIFICATION_CONDITION).nullable(),
        listing_status: z.enum(RECORD_QUALIFICATION_LISTING_STATUS).nullable(),
        needs_to_buy_next: z.boolean().nullable(),
      }).nullable(),
      buyer_criteria: z.object({
        city: z.string().nullable(), state: z.string().nullable(),
        min_price: z.number().nullable(), max_price: z.number().nullable(),
        min_beds: z.number().nullable(), min_baths: z.number().nullable(),
        property_type: z.string().nullable(),
        must_haves: z.array(z.string()).nullable().describe("Must-have features in their words, or null"),
        move_in_date: z.string().nullable().describe("Renter: desired move-in (their words), or null"),
        pets: z.string().nullable().describe("Renter: pets, or null"),
      }).nullable(),
      timeline: z.enum(RECORD_QUALIFICATION_TIMELINES).nullable(),
      financing_status: z.enum(RECORD_QUALIFICATION_FINANCING).nullable(),
      // Lane 77A — goals 8/9 (representation, follow-up preference). No live
      // column on contacts/leads carries either (scripts/schema-snapshot.ts),
      // so both land in the qualification_summary trace — a published blind
      // spot, never a silently dropped answer.
      already_represented: z.boolean().nullable().describe("Are they already working with an agent? null if not asked yet"),
      follow_up_preference: z.string().nullable().describe("Best way and time for the agent to follow up, in their words — or null"),
    }),
    execute: async (args: {
      intent: "buy" | "sell" | "both" | "invest" | "rent" | "relocate" | null
      persona: (typeof RECORD_QUALIFICATION_PERSONAS)[number] | null
      seller_property_address: string | null
      seller_situation: { reason_for_move: string | null; condition: (typeof RECORD_QUALIFICATION_CONDITION)[number] | null; listing_status: (typeof RECORD_QUALIFICATION_LISTING_STATUS)[number] | null; needs_to_buy_next: boolean | null } | null
      buyer_criteria: { city: string | null; state: string | null; min_price: number | null; max_price: number | null; min_beds: number | null; min_baths: number | null; property_type: string | null; must_haves?: string[] | null; move_in_date?: string | null; pets?: string | null } | null
      timeline: (typeof RECORD_QUALIFICATION_TIMELINES)[number] | null
      financing_status: (typeof RECORD_QUALIFICATION_FINANCING)[number] | null
      already_represented?: boolean | null
      follow_up_preference?: string | null
    }) => {
      if (!ctx.contactId && !ctx.leadId) return { success: false, error: "No contact or lead is linked to this conversation yet" }
      args = filterRecordableArgs(args)
      const svc = createServiceClient()
      const table = ctx.contactId ? "contacts" : "leads"
      const id = (ctx.contactId ?? ctx.leadId) as string
      const personaColumn = ctx.contactId ? "contact_persona" : "persona"
      const typeColumn = ctx.contactId ? "contact_type" : "lead_type"

      const patch: Record<string, unknown> = {}
      const summaryBits: string[] = []
      if (args.intent === "buy" || args.intent === "sell" || args.intent === "both") {
        patch[typeColumn] = args.intent
        summaryBits.push(`intent: ${args.intent}`)
      } else if (args.intent) {
        summaryBits.push(`intent: ${args.intent}`) // invest/rent/relocate carried in the summary + persona below
      }
      if (args.persona) { patch[personaColumn] = args.persona; summaryBits.push(`persona: ${args.persona}`) }
      if (args.intent === "relocate" && !args.persona) patch[personaColumn] = "relocated"
      if (args.intent === "invest" && !args.persona) patch[personaColumn] = "investor"
      if (args.intent === "rent") patch.home_owner_status = "renter"
      if (args.seller_property_address) { patch.address = args.seller_property_address; summaryBits.push(`selling: ${args.seller_property_address}`) }
      if (args.seller_situation) {
        const s = args.seller_situation
        if (s.reason_for_move) summaryBits.push(`reason: ${s.reason_for_move.slice(0, 160)}`)
        if (s.condition && s.condition !== "unknown") summaryBits.push(`condition: ${s.condition}`)
        if (s.listing_status && s.listing_status !== "unknown") {
          summaryBits.push(`listing status: ${s.listing_status}`)
          // fsbo / expired ARE persona vocabulary — write the real column, never a second spelling.
          if ((s.listing_status === "fsbo" || s.listing_status === "expired") && !args.persona) patch[personaColumn] = s.listing_status
        }
        if (s.needs_to_buy_next === true) {
          summaryBits.push("also needs to buy next")
          if (args.intent === "sell" || (!args.intent && ctx.contactId)) patch[typeColumn] = "both" // the live 'both' value — a move-up seller is both
        }
      }
      if (args.buyer_criteria?.property_type) patch.property_type = args.buyer_criteria.property_type
      if (args.buyer_criteria?.must_haves?.length) summaryBits.push(`must-haves: ${args.buyer_criteria.must_haves.slice(0, 6).join(", ").slice(0, 160)}`)
      if (args.buyer_criteria?.move_in_date) summaryBits.push(`move-in: ${args.buyer_criteria.move_in_date.slice(0, 60)}`)
      if (args.buyer_criteria?.pets) summaryBits.push(`pets: ${args.buyer_criteria.pets.slice(0, 60)}`)
      if (args.timeline) { patch.timeline = args.timeline; summaryBits.push(`timeline: ${args.timeline}`) }
      if (args.financing_status) { patch.lender_status = args.financing_status; summaryBits.push(`financing: ${args.financing_status}`) }
      // REPRESENTATION (lane 78D, blind spot 9 — decided, not deferred): no live
      // column on contacts/leads carries "already working with another agent"
      // (scripts/schema-snapshot.ts), and no reader asks for one today — the
      // outbound compliance gate (lib/kernel/communication-compliance.ts) and
      // the lead-assignment rules key on OUR representation, consent and DNC,
      // not on a rival agency. So the qualification_summary line
      // `already represented by an agent: yes|no` IS the vocabulary for this
      // fact until a reader exists (NAR Art. 16 solicitation suppression is the
      // named candidate; that reader would justify a m66x column, and the
      // column must land BEFORE this writer names it — PGRST204 refuses the
      // whole patch otherwise, CLAUDE.md §3).
      // Wave 98 (98C): THE READER NOW EXISTS — lib/ai-isa/lead-action-plan.ts::deadEndsFromLeadSources
      // parses the newest line of this exact spelling into the canonical dead end
      // `already_represented` (ALWAYS terminal for outreach). Keep the wording byte-identical.
      if (args.already_represented === true || args.already_represented === false) summaryBits.push(`already represented by an agent: ${args.already_represented ? "yes" : "no"}`)
      // FOLLOW-UP PREFERENCE (lane 78D, blind spot 9) — ALREADY EXISTED, REUSED:
      // `preferred_channel` ('phone'|'email'|'sms', lib/contact-pipeline/
      // contact-capture.ts's contract, on BOTH contacts and leads) and
      // `preferred_contact_time` (contacts only; read by app/actions/
      // ai-calendar-management.ts). The free-text answer is parsed onto those
      // columns where it names a channel/time, and the verbatim line still
      // lands in the summary so nothing the customer said is dropped.
      if (args.follow_up_preference) {
        summaryBits.push(`follow-up preference: ${args.follow_up_preference.slice(0, 120)}`)
        const pref = parseFollowUpPreference(args.follow_up_preference)
        if (pref.channel) patch.preferred_channel = pref.channel
        if (pref.time && ctx.contactId) patch.preferred_contact_time = pref.time
      }

      let wrote = false
      // Lane 76A — a summary-only learning (reason for the move, condition,
      // must-haves) has no typed column; it must still land, so the trace is
      // written whenever there is anything to say, not only beside a column patch.
      if (Object.keys(patch).length > 0 || summaryBits.length > 0) {
        if (summaryBits.length > 0) {
          const { data: current } = await svc.from(table).select("qualification_summary").eq("id", id).maybeSingle()
          const prior = (current as { qualification_summary?: string | null } | null)?.qualification_summary ?? ""
          patch.qualification_summary = [prior, `[AI qualification] ${summaryBits.join(", ")}`].filter(Boolean).join("\n").slice(-2000)
        }
        wrote = await sentinelWrite(
          svc, svc.from(table).update(patch).eq("id", id).eq("brokerage_id", ctx.brokerageId),
          { table, flow: "record_qualification", brokerageId: ctx.brokerageId },
        )
      }

      // Buyer criteria → property_preferences (contact-only — no lead twin).
      let wroteCriteria = false
      if (ctx.contactId && args.buyer_criteria) {
        const c = args.buyer_criteria
        const { data: existingPref } = await svc.from("property_preferences").select("id").eq("contact_id", ctx.contactId).maybeSingle()
        const prefPatch: Record<string, unknown> = {
          contact_id: ctx.contactId, brokerage_id: ctx.brokerageId, agent_id: ctx.agentId ?? null,
          preferred_price_min: c.min_price, preferred_price_max: c.max_price,
          inferred_beds_min: c.min_beds, inferred_baths_min: c.min_baths,
          inferred_cities: c.city ? [c.city] : undefined,
          inferred_property_types: c.property_type ? [c.property_type] : undefined,
          last_calculated_at: new Date().toISOString(),
        }
        wroteCriteria = existingPref
          ? await sentinelWrite(svc, svc.from("property_preferences").update(prefPatch).eq("id", existingPref.id),
              { table: "property_preferences", flow: "record_qualification", brokerageId: ctx.brokerageId })
          : await sentinelWrite(svc, svc.from("property_preferences").insert(prefPatch),
              { table: "property_preferences", flow: "record_qualification", brokerageId: ctx.brokerageId })
      }

      // CONVERSATION → MEMORY, NOW (wave 98, lane 98B). What the person just stated (timeline,
      // channel, price, reason for moving) goes into the contact's facts ledger immediately via
      // recordMemoryFact (lib/kernel/conversation-memory.ts recordConversationFacts) — a restated
      // value refreshes its review window today, a changed one supersedes the old one today.
      // Contacts only: the spine lives on contacts.metadata (a pre-conversion lead has none).
      let factsRecorded = 0
      if (ctx.contactId) {
        const { factsFromQualification, recordConversationFacts } = await import("@/lib/kernel/conversation-memory")
        const facts = factsFromQualification({
          timeline: args.timeline ?? null,
          preferredChannel: typeof patch.preferred_channel === "string" ? patch.preferred_channel : null,
          minPrice: args.buyer_criteria?.min_price ?? null,
          maxPrice: args.buyer_criteria?.max_price ?? null,
          reasonForMove: args.seller_situation?.reason_for_move ?? null,
        })
        const mem = await recordConversationFacts(ctx.contactId, ctx.brokerageId, facts, { client: svc, source: "conversation.record_qualification" })
        if (mem.error) console.error(`[record_qualification] memory facts not recorded for contact ${ctx.contactId}: ${mem.error}`)
        factsRecorded = mem.recorded
      }

      return { success: wrote || wroteCriteria || factsRecorded > 0, recorded: summaryBits, criteriaRecorded: wroteCriteria }
    },
  })
}

/**
 * The bundle every customer-facing surface spreads alongside its persona-
 * scoped BatchData/RentCast tools. `request_showing`, `schedule_callback`,
 * `schedule_home_value_review`, `find_listing_appointment_slots`,
 * `book_listing_appointment`, `send_newsletter`, `send_market_report` and
 * `send_explainer_video` are omitted entirely (never registered, never merely
 * gated inside `execute`) when there is no contactId AND no leadId — a
 * conversation with neither cannot be followed up under an identity it does
 * not have yet.
 * `send_matching_listings` and `record_qualification` register whenever
 * EITHER id is known (both degrade gracefully with no contactId — see their
 * own headers).
 *
 * Lane 75B — ASYNC now (was sync): the four NEW catalogue capabilities
 * (lib/ai-isa/capability-catalogue.ts) are additionally gated by the
 * brokerage's `ai_agent_capabilities` settings toggle (brokerage_settings.
 * settings — app/dashboard/settings/assistant/capabilities-panel.tsx), which
 * this function reads once per call (loadEnabledCapabilities has its own
 * short TTL cache, same posture as brand-playbook-context.ts).
 */
export async function buildCustomerFreeTools(ctx: CustomerContextToolsContext): Promise<Record<string, unknown>> {
  const enabledCapabilities = await loadEnabledCapabilities(ctx.brokerageId)
  const disabled = enabledCapabilities.disabled

  // TOMBSTONE (lane 77A, CLAUDE.md §1.3): lane 76A's `ctx.persona === "vendor"`
  // branch (a disjoint vendor-safe bundle) is GONE — "vendors are not contact
  // type, they are user type" (owner, wave 77). A vendor SEAT never reaches
  // this customer bundle at all; its tools are built by
  // lib/ai-isa/user-type-tools.ts::buildUserTypeSeatTools under the ONE seat
  // table in lib/ai-isa/user-type-tool-policy.ts, and mounted by
  // app/api/internal/ai-chat/route.ts (the surface the vendor/lender/title
  // portals actually render). A CONTACT row typed 'vendor' is a CRM record
  // about a business relationship and resolves to the `sphere` persona.

  const out: Record<string, unknown> = {
    get_my_context: buildGetMyContextTool(ctx),
    search_our_listings: buildSearchOurListingsTool(ctx),
  }
  // Lane 76A — "is the house on Oak Street still available?" needs no identity
  // (own-DB read, public listing fields only), same posture as search_our_listings.
  if (!disabled.includes("get_listing_details")) {
    out.get_listing_details = buildGetListingDetailsTool(ctx as CustomerCapabilityContext)
  }
  // Lane 79B — a property's FACTS by address through the cheapest-first rail
  // (lib/ai-isa/property-lookup-rail.ts; never BatchData for a conversation,
  // never a value for a customer). Identity-optional like get_listing_details.
  if (!disabled.includes("lookup_property_facts")) {
    out.lookup_property_facts = buildLookupPropertyFactsTool(ctx as CustomerCapabilityContext)
  }
  if (ctx.contactId) {
    out.request_showing = buildRequestShowingTool({ ...ctx, contactId: ctx.contactId })
    // Lane 79B — the investor's OWN cached off-market matches (own-DB read,
    // redacted). Persona-gated by the catalogue (investor only) and keyed on
    // the contact row the conversation resolved to — never a model-supplied id.
    if (isCapabilityEnabled("search_offmarket_opportunities", ctx.persona, disabled)) {
      out.search_offmarket_opportunities = buildSearchOffmarketOpportunitiesTool({ ...(ctx as CustomerCapabilityContext), contactId: ctx.contactId })
    }
  }
  // The six CORE follow-up tools register on IDENTITY, not persona: "buyer" is
  // the unknown default and buy+sell ("both") is a live contact_type, so a
  // buyer-defaulted thread that turns out to be a move-up seller must still
  // reach schedule_home_value_review / book_listing_appointment (capability-
  // catalogue.ts CapabilityDefinition.personas documents the OFFER, the
  // playbook's PERSONA_QUESTION_GUIDE steers it).
  if (ctx.contactId || ctx.leadId) {
    out.schedule_callback = buildScheduleCallbackTool(ctx)
    out.schedule_home_value_review = buildScheduleHomeValueReviewTool(ctx)
    if (!disabled.includes("book_listing_appointment")) {
      out.find_listing_appointment_slots = buildFindListingAppointmentSlotsTool(ctx)
      out.book_listing_appointment = buildBookListingAppointmentTool(ctx)
    }
    out.send_matching_listings = buildSendMatchingListingsTool(ctx)
    out.record_qualification = buildRecordQualificationTool(ctx)
    Object.assign(out, await buildNewCatalogueTools(ctx as CustomerCapabilityContext, enabledCapabilities))
  }
  // ONE VOCABULARY (wave 74 integration): the playbook's follow-up menu names
  // tools by string, so a menu entry with no registered tool would be a
  // promise the model cannot keep. Only menu entries whose tool exists in this
  // registry are exposed; the rest are dropped here rather than discovered on
  // a live call. Identity-gated tools (no contactId/leadId) are legitimately
  // absent and are not an error.
  const registered = new Set(Object.keys(out))
  const offered = QUALIFICATION_FOLLOW_UP_MENU.filter((o) => registered.has(o.tool)).map((o) => o.tool)
  if (offered.length === 0 && (ctx.contactId || ctx.leadId)) {
    console.warn("[customer-context-tools] follow-up menu names no registered tool", { menu: QUALIFICATION_FOLLOW_UP_MENU.map((o) => o.tool) })
  }
  // ACTION LEDGER (wave 98, lane 98B): every COMMUNICATION / FINANCIAL tool call this bundle
  // mounts is claimed → run → settled on agent_action_ledger (lib/kernel/action-ledger.ts
  // ledgerToolExecutions). This assembler is where the tenant + the person are KNOWN, so it is the
  // tool-execution chokepoint for every customer-facing surface that spreads the bundle.
  const { ledgerToolExecutions } = await import("@/lib/kernel/action-ledger")
  const { riskClassForTool } = await import("@/lib/ai-isa/persona-tool-policy")
  return ledgerToolExecutions(out, {
    brokerageId: ctx.brokerageId,
    subject: ctx.contactId ? { type: "contact", id: ctx.contactId } : ctx.leadId ? { type: "lead", id: ctx.leadId } : { type: "conversation", id: null },
    riskClassOf: riskClassForTool,
    actor: { type: "manager", managerKey: "ai_isa" },
    surface: ctx.persona ? `customer_tools:${ctx.persona}` : "customer_tools",
  })
}

/** PURE, module-private — the goal keys `record_qualification` may write,
 *  derived from the playbook's QUALIFICATION_GOALS (never a hand-copied
 *  second list, §6). Maps tool argument names onto playbook goal keys. */
const RECORDABLE_QUALIFICATION_KEYS: ReadonlySet<string> = new Set(QUALIFICATION_GOALS.map((g) => g.key))
const RECORD_ARG_TO_GOAL: Record<string, string> = {
  intent: "intent", persona: "persona", seller_property_address: "seller_address",
  seller_situation: "seller_situation",
  buyer_criteria: "buyer_criteria", timeline: "timeline", financing_status: "financing_status",
  already_represented: "representation", follow_up_preference: "follow_up_preference",
}
/** Drops any argument whose playbook goal is not recordable — a goal removed
 *  from the playbook can never keep being written through this tool. */
function filterRecordableArgs<T extends Record<string, unknown>>(args: T): T {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args)) {
    const goal = RECORD_ARG_TO_GOAL[k]
    if (goal && RECORDABLE_QUALIFICATION_KEYS.has(goal)) out[k] = v
  }
  return out as T
}

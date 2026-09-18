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
import { publishManagerSignal } from "@/lib/kernel/manager-signals"
import { QUALIFICATION_FOLLOW_UP_MENU, QUALIFICATION_GOALS } from "@/lib/ai-isa/qualification-playbook"

export interface CustomerContextToolsContext {
  brokerageId: string
  /** contacts.id — when known, get_my_context/request_showing operate on THIS
   *  row only, never a model-supplied id. */
  contactId?: string | null
  /** leads.id — used when no contactId exists yet (a pre-conversion lead
   *  thread, e.g. the ISA inbound-email handler). */
  leadId?: string | null
  agentId?: string | null
}

/**
 * The SHARED write helper both the staff tool (app/api/internal/ai-chat's
 * schedule_follow_up, arbitrary contact_id) and this file's customer-safe
 * `request_showing` (LOCKED contact_id) call — one implementation, two
 * call sites, never two divergent inserts into `activities` (CLAUDE.md §6).
 */
export async function writeFollowUpActivity(params: {
  brokerageId: string
  agentId: string | null
  contactId: string
  activityType: "call" | "email" | "text" | "meeting" | "check_in" | "showing"
  scheduledAt: string
  notes?: string | null
  title: string
}): Promise<{ success: true; activityId: string; scheduledAt: string } | { success: false; error: string }> {
  const svc = createServiceClient()
  const { data, error } = await svc
    .from("activities")
    .insert({
      brokerage_id: params.brokerageId,
      agent_id: params.agentId,
      contact_id: params.contactId,
      activity_type: params.activityType,
      scheduled_at: params.scheduledAt,
      notes: params.notes ?? undefined,
      title: params.title,
      status: "scheduled",
    })
    .select("id, title, scheduled_at")
    .maybeSingle()
  if (error || !data) return { success: false, error: error?.message ?? "Insert failed" }
  return { success: true, activityId: data.id, scheduledAt: data.scheduled_at }
}

/**
 * get_my_context — READ ONLY, bound to ctx.contactId/leadId (never a
 * model-supplied id, so it can never become a free-text search of another
 * person's record). Returns the caller's own name/stage/persona + their last
 * few logged activities, so the model can ground its replies without a paid
 * lookup.
 */
export function buildGetMyContextTool(ctx: CustomerContextToolsContext) {
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
export function buildRequestShowingTool(ctx: CustomerContextToolsContext & { contactId: string }) {
  return tool({
    description: "Request a showing, call, or meeting for YOURSELF. Logs the request and notifies your agent — they will confirm a specific time. Use when the person asks to see a property, schedule a call, or meet.",
    inputSchema: z.object({
      meeting_type: z.enum(["call", "meeting", "showing"]).describe("What kind of meeting was requested"),
      preferred_window: z.string().nullable().describe("Free-text time preference if mentioned, or null"),
      notes: z.string().describe("Any details given (property of interest, etc.)"),
    }),
    execute: async ({ meeting_type, preferred_window, notes }: { meeting_type: "call" | "meeting" | "showing"; preferred_window: string | null; notes: string }) => {
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
          await svc.from("notifications").insert({
            user_id: agent.user_id,
            brokerage_id: ctx.brokerageId,
            type: "appointment_request",
            title: "A client requested a showing/meeting via AI chat",
            body: `${meeting_type}${preferred_window ? ` (${preferred_window})` : ""}`,
            priority: "high",
            entity_type: "contact",
            entity_id: ctx.contactId,
          }).then(undefined, () => {})
        }
      }
      return { success: true, meetingType: meeting_type, activityId: result.activityId }
    },
  })
}

/**
 * search_our_listings — free listing lookup from OUR OWN `listings` table
 * (never a paid vendor call), scoped to the brokerage and active/coming-soon/
 * pending statuses. Every persona gets this — it costs the platform nothing.
 */
export function buildSearchOurListingsTool(ctx: CustomerContextToolsContext) {
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

async function scheduleFollowUp(
  ctx: CustomerContextToolsContext,
  input: { activityType: "call" | "meeting" | "showing"; scheduledAt: string; notes: string; title: string },
): Promise<{ success: true; via: "activity" | "lead_followup"; activityId?: string } | { success: false; error: string }> {
  if (ctx.contactId) {
    const r = await writeFollowUpActivity({
      brokerageId: ctx.brokerageId,
      agentId: ctx.agentId ?? null,
      contactId: ctx.contactId,
      activityType: input.activityType,
      scheduledAt: input.scheduledAt,
      notes: input.notes,
      title: input.title,
    })
    if (!r.success) return { success: false, error: r.error }
    return { success: true, via: "activity", activityId: r.activityId }
  }
  if (ctx.leadId) {
    const svc = createServiceClient()
    const ok = await sentinelWrite(
      svc,
      svc.from("leads").update({
        next_followup_at: input.scheduledAt,
        next_followup_reason: `${input.title}${input.notes ? ` — ${input.notes}` : ""}`.slice(0, 500),
      }).eq("id", ctx.leadId).eq("brokerage_id", ctx.brokerageId),
      { table: "leads", flow: "qualification_followup", brokerageId: ctx.brokerageId },
    )
    return ok ? { success: true, via: "lead_followup" } : { success: false, error: "Lead follow-up write failed" }
  }
  return { success: false, error: "No contact or lead is linked to this conversation yet" }
}

/** Notifies the assigned agent (best-effort, never blocks the tool result) —
 *  same notifications-row shape buildRequestShowingTool already uses. */
async function notifyAssignedAgent(ctx: CustomerContextToolsContext, input: {
  type: string; title: string; body: string; entityType: "contact" | "lead"; entityId: string
}): Promise<void> {
  if (!ctx.agentId) return
  const svc = createServiceClient()
  const { data: agent } = await svc.from("agents").select("user_id").eq("id", ctx.agentId).maybeSingle()
  if (!agent?.user_id) return
  await svc.from("notifications").insert({
    user_id: agent.user_id,
    brokerage_id: ctx.brokerageId,
    type: input.type,
    title: input.title,
    body: input.body,
    priority: "medium",
    entity_type: input.entityType,
    entity_id: input.entityId,
  }).then(undefined, () => {})
}

/** Publishes a manager signal (best-effort — a failed publish never fails the
 *  tool call; the notification above + the durable write already carry the
 *  follow-up). fromManager is always "ai_isa" (every mounting surface here
 *  runs under the AI ISA's qualification job). */
async function publishQualificationSignal(input: {
  brokerageId: string; toManager: "shopping_agent" | "listing_concierge"
  signalType: string; message: string; contactId: string | null; leadId: string | null
  payload?: Record<string, unknown>
}): Promise<void> {
  try {
    await publishManagerSignal({
      brokerageId: input.brokerageId,
      fromManager: "ai_isa",
      toManager: input.toManager,
      signalType: input.signalType,
      message: input.message,
      entityType: input.contactId ? "contact" : input.leadId ? "lead" : null,
      entityId: input.contactId ?? input.leadId ?? null,
      contactId: input.contactId ?? null,
      payload: input.payload ?? {},
    })
  } catch (e) {
    console.error(`[customer-context-tools] publishQualificationSignal(${input.signalType}) failed:`, e)
  }
}

/** schedule_callback — "call them again when they're ready." */
export function buildScheduleCallbackTool(ctx: CustomerContextToolsContext) {
  return tool({
    description: "Schedule a callback for when THEY say they're ready — not now, but later. Use when the person is interested but wants to be called back rather than continue right now.",
    inputSchema: z.object({
      when_iso: z.string().nullable().describe("The callback time as an ISO 8601 timestamp, if you can resolve one from what they said, else null"),
      when_description: z.string().describe("The person's own words for when — e.g. \"next week\", \"after I talk to my spouse\""),
      notes: z.string().describe("Why they want a callback / what to follow up on"),
    }),
    execute: async ({ when_iso, when_description, notes }: { when_iso: string | null; when_description: string; notes: string }) => {
      const scheduledAt = when_iso && !Number.isNaN(Date.parse(when_iso)) ? when_iso : new Date().toISOString()
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
        entityType: ctx.contactId ? "contact" : "lead",
        entityId: (ctx.contactId ?? ctx.leadId) as string,
      })
      await publishQualificationSignal({
        brokerageId: ctx.brokerageId,
        toManager: "shopping_agent",
        signalType: "qualification_call_requested",
        message: `AI qualification scheduled a callback: ${when_description}`,
        contactId: ctx.contactId ?? null,
        leadId: ctx.leadId ?? null,
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
    description: "Send the properties matching the buyer/renter criteria they just described, and keep sending as new matches come in. Use once they've given you at least an area or a price range.",
    inputSchema: z.object({
      city: z.string().nullable(),
      state: z.string().nullable().describe("Two-letter state code, or null"),
      zip: z.string().nullable(),
      min_price: z.number().nullable(),
      max_price: z.number().nullable(),
      min_beds: z.number().nullable(),
      min_baths: z.number().nullable(),
      property_type: z.string().nullable().describe("e.g. Single Family, Condo, Townhouse — or null"),
    }),
    execute: async (args: {
      city: string | null; state: string | null; zip: string | null
      min_price: number | null; max_price: number | null; min_beds: number | null; min_baths: number | null
      property_type: string | null
    }) => {
      const svc = createServiceClient()

      // 1. Own DB — free, always tried first.
      let ownQuery = svc.from("listings")
        .select("id, address, city, state, zip, list_price, bedrooms, bathrooms, property_type, status")
        .eq("brokerage_id", ctx.brokerageId).in("status", ["active", "coming_soon", "pending"]).limit(10)
      if (args.city) ownQuery = ownQuery.ilike("city", `%${args.city}%`)
      if (args.state) ownQuery = ownQuery.eq("state", args.state.toUpperCase())
      if (args.zip) ownQuery = ownQuery.eq("zip", args.zip)
      if (args.min_price !== null) ownQuery = ownQuery.gte("list_price", args.min_price)
      if (args.max_price !== null) ownQuery = ownQuery.lte("list_price", args.max_price)
      if (args.min_beds !== null) ownQuery = ownQuery.gte("bedrooms", args.min_beds)
      const { data: ownListings } = await ownQuery
      const listings: Array<Record<string, unknown>> = (ownListings ?? []).map((l) => ({ ...l, source: "our_listings" }))

      // 2. RentCast active listings — only when our own inventory is thin, and
      // only when this brokerage is eligible (searchRentcastSaleListings gates
      // through the SAME resolveRentcastEligibility every AVM/comp reader uses).
      if (listings.length < 10) {
        const { searchRentcastSaleListings } = await import("@/lib/property/rentcast")
        const rc = await searchRentcastSaleListings({
          brokerageId: ctx.brokerageId,
          contactId: ctx.contactId ?? null,
          filters: {
            city: args.city ?? undefined,
            state: args.state ?? undefined,
            zipCode: args.zip ?? undefined,
            bedroomsMin: args.min_beds ?? undefined,
            bathroomsMin: args.min_baths ?? undefined,
            limit: 10 - listings.length,
          },
        })
        if (rc.success) {
          for (const l of rc.listings) listings.push({ ...l, source: "rentcast" })
        }
      }

      // 3. Enroll/create the existing listing-alert record so it keeps
      // sending — contact-only (property_alerts.contact_id is NOT NULL); a
      // lead-only thread still gets the listings above, just no standing
      // alert until they convert.
      let alertId: string | null = null
      if (ctx.contactId) {
        const marker = `[AI_QUALIFICATION:${[args.city, args.state, args.zip, args.min_price, args.max_price, args.min_beds].join(":")}]`
        const { data: existing } = await svc.from("property_alerts").select("id")
          .eq("contact_id", ctx.contactId).ilike("alert_name", `%${marker}%`).limit(1).maybeSingle()
        if (existing) {
          alertId = existing.id
        } else {
          const { data: created } = await svc.from("property_alerts").insert({
            brokerage_id: ctx.brokerageId,
            contact_id: ctx.contactId,
            agent_user_id: null,
            alert_name: `AI-qualified criteria ${marker}`,
            // property_alerts.source CHECK vocabulary (scripts/check-vocabularies.ts):
            // the AI agent captured these criteria in a text conversation.
            source: "text_conversation",
            is_active: true,
            min_price: args.min_price, max_price: args.max_price,
            bedrooms_min: args.min_beds, bathrooms_min: args.min_baths,
            property_types: args.property_type ? [args.property_type] : [],
            cities: args.city ? [args.city] : [],
            zip_codes: args.zip ? [args.zip] : [],
            must_have_features: [], keywords: null,
            new_listings_only: true, include_coming_soon: true, include_price_reductions: true,
            price_reduction_min_percent: 2, frequency: "daily",
            delivery_channels: ["email", "in_app"], max_results_per_alert: 10,
          }).select("id").maybeSingle()
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

      return { success: true, listings: listings.slice(0, 10), alertEnrolled: !!alertId }
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

      // AVM chain: RentCast first; BatchData only if the chain reaches it AND
      // the platform tier allows it (persona-tool-policy.ts's own cost tier —
      // reused, never a second budget knob, §6).
      const { getCurrentAvm } = await import("@/lib/avm/provider-chain")
      const { resolveEffectiveBatchDataToolTier } = await import("@/lib/ai-isa/persona-tool-policy")
      const tier = await resolveEffectiveBatchDataToolTier()
      const avm = await getCurrentAvm({
        address: property_address,
        zipCode: zip_code,
        brokerageId: ctx.brokerageId,
        usePaidProviders: true,
        skipProviders: tier === "off" ? ["batchdata"] : [],
      })

      const result = await scheduleFollowUp(ctx, {
        activityType: "call",
        scheduledAt: new Date().toISOString(),
        notes: [
          `Property: ${property_address}`,
          avm ? `Estimated value: $${avm.value.toLocaleString()} (${avm.source}, confidence ${Math.round(avm.confidence * 100)}%)` : "Estimated value: not available yet — the agent will confirm.",
          `Preferred callback: ${preferred_callback_window}`,
        ].join("\n"),
        title: "Home value review — callback to discuss",
      })
      if (!result.success) return { success: false, error: result.error }

      await notifyAssignedAgent(ctx, {
        type: "qualification_home_value_requested",
        title: "Client wants a home value review",
        body: `${property_address}${avm ? ` — est. $${avm.value.toLocaleString()}` : ""}`,
        entityType: ctx.contactId ? "contact" : "lead",
        entityId: (ctx.contactId ?? ctx.leadId) as string,
      })
      await publishQualificationSignal({
        brokerageId: ctx.brokerageId,
        toManager: "listing_concierge",
        signalType: "qualification_valuation_handoff",
        message: `AI qualification looked up a home value and booked a discuss-it callback (${property_address})`,
        contactId: ctx.contactId ?? null,
        leadId: ctx.leadId ?? null,
        payload: { propertyAddress: property_address, avmValue: avm?.value ?? null, avmSource: avm?.source ?? null },
      })

      return {
        success: true,
        estimatedValue: avm?.value ?? null,
        valueSource: avm?.source ?? null,
        confidence: avm?.confidence ?? null,
        callbackScheduled: true,
      }
    },
  })
}

/** book_agent_appointment — "did they want to setup an appt for an agent to
 *  come out to discuss/no obligation." Reuses the SAME follow-up writer as
 *  request_showing/schedule_callback — a different meeting_type, not a
 *  second insert shape (§6). */
export function buildBookAgentAppointmentTool(ctx: CustomerContextToolsContext) {
  return tool({
    description: "Book a NO-OBLIGATION in-person or video visit from the agent — nothing required of them. Use when they want an agent to come out and talk it through, rather than a phone callback.",
    inputSchema: z.object({
      preferred_window: z.string().nullable().describe("Free-text time preference, or null"),
      notes: z.string().describe("What they want to discuss"),
    }),
    execute: async ({ preferred_window, notes }: { preferred_window: string | null; notes: string }) => {
      const result = await scheduleFollowUp(ctx, {
        activityType: "meeting",
        scheduledAt: new Date().toISOString(),
        notes: [preferred_window ? `Preferred: ${preferred_window}` : null, `No-obligation visit — ${notes}`].filter(Boolean).join("\n"),
        title: "No-obligation agent visit requested",
      })
      if (!result.success) return { success: false, error: result.error }
      await notifyAssignedAgent(ctx, {
        type: "qualification_agent_visit_requested",
        title: "Client requested a no-obligation agent visit",
        body: `${notes}${preferred_window ? ` (${preferred_window})` : ""}`,
        entityType: ctx.contactId ? "contact" : "lead",
        entityId: (ctx.contactId ?? ctx.leadId) as string,
      })
      await publishQualificationSignal({
        brokerageId: ctx.brokerageId,
        toManager: "listing_concierge",
        signalType: "qualification_appointment_handoff",
        message: "AI qualification booked a no-obligation agent visit",
        contactId: ctx.contactId ?? null,
        leadId: ctx.leadId ?? null,
      })
      return { success: true, scheduledVia: result.via }
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

export function buildRecordQualificationTool(ctx: CustomerContextToolsContext) {
  return tool({
    description: "Record what you've learned about this person's qualification — call this as soon as you learn ANY of: their intent (buy/sell/both/invest/rent/relocate), persona, the property they're selling, buyer criteria, timeline, or financing status. Safe to call multiple times as more comes up.",
    inputSchema: z.object({
      intent: z.enum(["buy", "sell", "both", "invest", "rent", "relocate"]).nullable(),
      persona: z.enum(RECORD_QUALIFICATION_PERSONAS).nullable(),
      seller_property_address: z.string().nullable(),
      buyer_criteria: z.object({
        city: z.string().nullable(), state: z.string().nullable(),
        min_price: z.number().nullable(), max_price: z.number().nullable(),
        min_beds: z.number().nullable(), min_baths: z.number().nullable(),
        property_type: z.string().nullable(),
      }).nullable(),
      timeline: z.enum(RECORD_QUALIFICATION_TIMELINES).nullable(),
      financing_status: z.enum(RECORD_QUALIFICATION_FINANCING).nullable(),
    }),
    execute: async (args: {
      intent: "buy" | "sell" | "both" | "invest" | "rent" | "relocate" | null
      persona: (typeof RECORD_QUALIFICATION_PERSONAS)[number] | null
      seller_property_address: string | null
      buyer_criteria: { city: string | null; state: string | null; min_price: number | null; max_price: number | null; min_beds: number | null; min_baths: number | null; property_type: string | null } | null
      timeline: (typeof RECORD_QUALIFICATION_TIMELINES)[number] | null
      financing_status: (typeof RECORD_QUALIFICATION_FINANCING)[number] | null
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
      if (args.buyer_criteria?.property_type) patch.property_type = args.buyer_criteria.property_type
      if (args.timeline) { patch.timeline = args.timeline; summaryBits.push(`timeline: ${args.timeline}`) }
      if (args.financing_status) { patch.lender_status = args.financing_status; summaryBits.push(`financing: ${args.financing_status}`) }

      let wrote = false
      if (Object.keys(patch).length > 0) {
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

      return { success: wrote || wroteCriteria, recorded: summaryBits, criteriaRecorded: wroteCriteria }
    },
  })
}

/**
 * The bundle every customer-facing surface spreads alongside its persona-
 * scoped BatchData/RentCast tools. `request_showing`, `schedule_callback`,
 * `schedule_home_value_review` and `book_agent_appointment` are omitted
 * entirely (never registered, never merely gated inside `execute`) when
 * there is no contactId AND no leadId — a conversation with neither cannot
 * be followed up under an identity it does not have yet.
 * `send_matching_listings` and `record_qualification` register whenever
 * EITHER id is known (both degrade gracefully with no contactId — see their
 * own headers).
 */
export function buildCustomerFreeTools(ctx: CustomerContextToolsContext): Record<string, unknown> {
  const out: Record<string, unknown> = {
    get_my_context: buildGetMyContextTool(ctx),
    search_our_listings: buildSearchOurListingsTool(ctx),
  }
  if (ctx.contactId) {
    out.request_showing = buildRequestShowingTool({ ...ctx, contactId: ctx.contactId })
  }
  if (ctx.contactId || ctx.leadId) {
    out.schedule_callback = buildScheduleCallbackTool(ctx)
    out.schedule_home_value_review = buildScheduleHomeValueReviewTool(ctx)
    out.book_agent_appointment = buildBookAgentAppointmentTool(ctx)
    out.send_matching_listings = buildSendMatchingListingsTool(ctx)
    out.record_qualification = buildRecordQualificationTool(ctx)
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
  return out
}

/** PURE, module-private — the goal keys `record_qualification` may write,
 *  derived from the playbook's QUALIFICATION_GOALS (never a hand-copied
 *  second list, §6). Maps tool argument names onto playbook goal keys. */
const RECORDABLE_QUALIFICATION_KEYS: ReadonlySet<string> = new Set(QUALIFICATION_GOALS.map((g) => g.key))
const RECORD_ARG_TO_GOAL: Record<string, string> = {
  intent: "intent", persona: "persona", seller_property_address: "seller_address",
  buyer_criteria: "buyer_criteria", timeline: "timeline", financing_status: "financing_status",
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

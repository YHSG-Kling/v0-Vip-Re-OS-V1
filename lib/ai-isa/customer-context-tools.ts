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

/**
 * The bundle every customer-facing surface spreads alongside its persona-
 * scoped BatchData/RentCast tools. `request_showing` is omitted entirely
 * (never registered, never merely gated inside `execute`) when there is no
 * contactId — an anonymous pre-capture conversation cannot book a showing
 * under an identity it does not have yet.
 */
export function buildCustomerFreeTools(ctx: CustomerContextToolsContext): Record<string, unknown> {
  const out: Record<string, unknown> = {
    get_my_context: buildGetMyContextTool(ctx),
    search_our_listings: buildSearchOurListingsTool(ctx),
  }
  if (ctx.contactId) {
    out.request_showing = buildRequestShowingTool({ ...ctx, contactId: ctx.contactId })
  }
  return out
}

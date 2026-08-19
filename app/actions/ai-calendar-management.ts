"use server"

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { generateObject } from "@/lib/ai/generate"
import { resolveModel } from "@/lib/ai/resolve-model"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { z } from "zod"
import { TRANSACTION_STATUSES_IN_ESCROW } from "@/lib/transactions/transaction-status"
import { getAgentContext } from "@/lib/identity/get-agent-context"

/**
 * AI CALENDAR & SCHEDULING MANAGEMENT
 * 
 * Maps to calendar_events table per Kernel OS schema:
 * - entity_id: contact or listing ID being scheduled
 * - entity_type: 'contact' or 'listing'
 * - start_at: appointment start time
 * - end_at: appointment end time
 * - event_type: 'showing', 'inspection', 'closing', etc.
 * - brokerage_id: ownership context
 */

/**
 * ABSORBED (wave 16) from the retired /api/dashboard/data `appointments` branch:
 * the SESSION-DERIVED tenant filter, applied unconditionally BEFORE any
 * caller-supplied parameter is considered.
 *
 * This had no scope of any kind — every filter was optional and caller-supplied,
 * so `getAppointments()` returned every calendar event on the platform and
 * `getAppointments({ contactId })` returned any brokerage's contact's calendar.
 *
 * The `agentId` parameter is GONE rather than filtered on. The calendar table
 * has no agents.id column at all — it carries `agent_user_id`, a users.id, which
 * the live writer in this same file does not stamp (it puts the agent in
 * `metadata`). Honouring the parameter against either column would have returned
 * zero rows while reporting success; substituting one id space for the other is
 * the exact defect this lane exists to refuse. Per-agent narrowing needs the
 * writer fixed first, and that is a feature, not a filter.
 */
export async function getAppointments(params?: { contactId?: string; startDate?: string; endDate?: string }) {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated) return { success: false, error: "Not authenticated", appointments: [] }
    if (!ctx.brokerageId) {
      return { success: false, error: "Your account is not linked to a brokerage yet.", appointments: [] }
    }

    const supabase = await createClient()

    // Query calendar_events (canonical calendar table per Kernel OS).
    // The tenant anchor is session-derived and applied first; everything below
    // may only NARROW it.
    let query = supabase
      .from("calendar_events")
      .select("*")
      .eq("brokerage_id", ctx.brokerageId)
      .order("start_at", { ascending: true })

    // Filter by contact (entity_type='contact' and entity_id=contactId)
    if (params?.contactId) {
      query = query.eq("entity_type", "contact").eq("entity_id", params.contactId)
    }

    if (params?.startDate) query = query.gte("start_at", params.startDate)
    if (params?.endDate) query = query.lte("end_at", params.endDate)

    const { data: appointments, error } = await query

    if (error) throw error

    return { success: true, appointments: appointments || [] }
  } catch (error) {
    return handleError(error, "getAppointments")
  }
}

export async function createAppointment(params: {
  agentId: string
  contactId?: string
  listingId?: string
  title: string
  startTime: string
  endTime: string
  location?: string
  notes?: string
  type?: string
  brokerageId: string
}) {
  try {
    const supabase = await createClient()

    // Determine entity for calendar_events
    const entityId = params.contactId || params.listingId
    const entityType = params.contactId ? "contact" : (params.listingId ? "listing" : "contact")

    if (!entityId) {
      return { success: false, error: "Either contactId or listingId required" }
    }

    // Insert to calendar_events table per Kernel OS schema
    const { data, error } = await supabase
      .from("calendar_events")
      .insert({
        entity_id: entityId,
        entity_type: entityType,
        start_at: params.startTime,
        end_at: params.endTime,
        event_type: params.type || "showing",
        brokerage_id: params.brokerageId,
        metadata: {
          title: params.title,
          location: params.location,
          notes: params.notes,
          agentId: params.agentId,
        },
      })
      .select()
      .maybeSingle()

    if (error) throw error

    revalidatePath("/dashboard")
    revalidatePath("/calendar")

    // Auto-trigger listing appointment prep workflow chain for consultation appointments.
    // The chain runs CMA → presentation → chapter videos → drip in sequence.
    if (params.type === "listing_consultation" && params.contactId && data?.id) {
      try {
        // Resolve agent user_id from agents.id (chain context expects auth user_id)
        const { data: agentRow } = await supabase
          .from("agents")
          .select("user_id")
          .eq("id", params.agentId)
          .maybeSingle()

        // Enrich property data from location string via Perplexity address lookup.
        // If location is empty or lookup fails, the chain still runs but the CMA
        // step will fail and surface that to the agent.
        let propertyData: Record<string, any> = { address: params.location ?? null }
        if (params.location) {
          try {
            const { lookupAddressAction } = await import("@/app/actions/address-lookup")
            // Best-effort split: "123 Main St, Tampa, FL 33601"
            const parts = params.location.split(",").map((s) => s.trim())
            const lookup = await lookupAddressAction({
              address: parts[0] ?? params.location,
              city: parts[1] ?? "",
              state: (parts[2] ?? "").split(/\s+/)[0] ?? "",
              zip: (parts[2] ?? "").split(/\s+/)[1],
            })
            propertyData = {
              address: parts[0] ?? params.location,
              city: parts[1] ?? null,
              state: (parts[2] ?? "").split(/\s+/)[0] ?? null,
              zip: (parts[2] ?? "").split(/\s+/)[1] ?? null,
              bedrooms: lookup.beds ?? null,
              bathrooms: lookup.baths ?? null,
              sqft: lookup.sqft ?? null,
              propertyType: lookup.propertyType ?? "single_family",
            }
          } catch {
            // Non-fatal — chain CMA step will report missing data
          }
        }

        const { triggerChainsForEvent } = await import("@/app/actions/workflow-orchestrator")
        await triggerChainsForEvent({
          eventType: "listing.appointment_set",
          brokerageId: params.brokerageId,
          contactId: params.contactId,
          agentUserId: agentRow?.user_id ?? null,
          metadata: {
            appointment_id: data.id,
            appointment_date: params.startTime,
            property_data: propertyData,
          },
        })
      } catch (err) {
        // Non-critical: appointment is scheduled even if chain trigger fails.
        // The error is logged for follow-up.
        console.error("[createAppointment] listing-appt-prep chain trigger failed:", err)
      }
    }

    return { success: true, appointment: data }
  } catch (error) {
    return handleError(error, "createAppointment")
  }
}

export async function updateAppointment(appointmentId: string, updates: Record<string, unknown>) {
  try {
    const supabase = await createClient()

    // Map appointment fields to calendar_events fields
    const calendarUpdates: Record<string, unknown> = {}
    if (updates.start_time) calendarUpdates.start_at = updates.start_time
    if (updates.end_time) calendarUpdates.end_at = updates.end_time
    if (updates.event_type) calendarUpdates.event_type = updates.event_type

    const { data, error } = await supabase
      .from("calendar_events")
      .update(calendarUpdates)
      .eq("id", appointmentId)
      .select()
      .maybeSingle()

    if (error) throw error

    revalidatePath("/dashboard")
    revalidatePath("/calendar")

    return { success: true, appointment: data }
  } catch (error) {
    return handleError(error, "updateAppointment")
  }
}

export async function cancelAppointment(appointmentId: string, reason?: string) {
  try {
    const supabase = await createClient()

    // Delete calendar event (or mark cancelled if schema supports status field)
    const { data, error } = await supabase
      .from("calendar_events")
      .update({
        metadata: { cancelled: true, cancelledReason: reason },
      })
      .eq("id", appointmentId)
      .select()
      .maybeSingle()

    if (error) throw error

    revalidatePath("/dashboard")
    revalidatePath("/calendar")

    return { success: true, appointment: data }
  } catch (error) {
    return handleError(error, "cancelAppointment")
  }
}

/**
 * AI-powered daily schedule optimization
 */
export async function optimizeDailySchedule(params: {
  agentId: string
  date: string
}) {
  try {
    if (!isValidUUID(params.agentId)) {
      return { success: false, error: "Invalid agent ID" }
    }

    const supabase = await createClient()
    const targetDate = new Date(params.date)

    // Get all calendar events for the day
    const { data: appointments } = await supabase
      .from("calendar_events")
      .select("*")
      .gte("start_at", targetDate.toISOString())
      .lt("start_at", new Date(targetDate.getTime() + 24 * 60 * 60 * 1000).toISOString())
      .order("start_at")

    const { data: tasks } = await supabase
      .from("tasks")
      .select("*")
      // tenant anchor (scope burn-down): only the (validated) agent's own tasks
      .eq("assigned_to_agent_id", params.agentId)
      .eq("due_date", params.date)
      .eq("status", "pending")

    const { object: optimizedSchedule } = await generateObject({
      model: resolveModel("anthropic/claude-sonnet-4-20250514"),
      schema: z.object({
        optimizedTimeline: z.array(z.object({
          time: z.string(),
          endTime: z.string(),
          activity: z.string(),
          type: z.enum(["appointment", "showing", "task", "travel", "buffer", "prospecting", "admin"]),
          location: z.string().optional(),
          priority: z.enum(["high", "medium", "low"]),
          notes: z.string().optional(),
        })),
        travelOptimization: z.object({
          totalTravelTime: z.number(),
          suggestedRoute: z.array(z.string()),
          savedTime: z.number(),
        }),
        conflicts: z.array(z.object({
          item1: z.string(),
          item2: z.string(),
          resolution: z.string(),
        })),
        productivityScore: z.number(),
        recommendations: z.array(z.object({
          suggestion: z.string(),
          benefit: z.string(),
        })),
        timeBlocks: z.object({
          prospecting: z.number(),
          clientMeetings: z.number(),
          admin: z.number(),
          travel: z.number(),
          available: z.number(),
        }),
      }),
      prompt: `Optimize this agent's daily schedule:

Date: ${params.date}

Appointments:
${appointments?.map((a: any) => `- ${a.start_at}: ${a.metadata?.title || a.event_type || 'Appointment'} at ${a.metadata?.location || 'TBD'}`).join('\n') || 'None'}
Tasks Due:
${tasks?.map((t: any) => `- ${t.title} (Priority: ${t.priority})`).join('\n') || 'None'}

Optimize for:
1. Minimize travel time between locations
2. Include buffer time between appointments
3. Block time for prospecting/lead gen
4. Resolve any scheduling conflicts
5. Maximize productivity`,
    })

    // daily_schedules table does not exist in schema — schedule returned to caller

    return { success: true, optimizedSchedule }
  } catch (error) {
    return handleError(error, "optimizeDailySchedule")
  }
}

/**
 * AI-powered smart appointment booking
 */
export async function suggestAppointmentSlots(params: {
  agentId: string
  contactId: string
  appointmentType: "listing_presentation" | "buyer_consultation" | "showing" | "closing" | "follow_up" | "general"
  duration: number // minutes
  preferredDays?: string[]
  urgency?: "low" | "medium" | "high"
}) {
  try {
    const supabase = await createClient()

    // public.users has no working_hours/time_zone/calendar_preferences columns
    // (multi-consumer table; LIVE canonical). Calendar prefs aren't persisted yet —
    // default downstream via the existing fallbacks.
    const agent = null as { working_hours?: unknown; time_zone?: string | null } | null

    // Get existing showings for next 2 weeks
    const startDate = new Date()
    const endDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)

    const { data: existingAppointments } = await supabase
      .from("showings")
      .select("scheduled_at, duration_minutes")
      .eq("agent_id", params.agentId)
      .gte("scheduled_at", startDate.toISOString())
      .lte("scheduled_at", endDate.toISOString())

    // Get contact preferences
    const { data: contact } = await supabase
      .from("contacts")
      .select("preferred_contact_time, time_zone")
      .eq("id", params.contactId)
      .maybeSingle()

    const { object: suggestions } = await generateObject({
      model: resolveModel("anthropic/claude-sonnet-4-20250514"),
      schema: z.object({
        topSlots: z.array(z.object({
          date: z.string(),
          startTime: z.string(),
          endTime: z.string(),
          score: z.number(),
          reasoning: z.string(),
        })),
        alternativeSlots: z.array(z.object({
          date: z.string(),
          startTime: z.string(),
          endTime: z.string(),
          tradeoff: z.string(),
        })),
        bestDayOfWeek: z.string(),
        bestTimeOfDay: z.string(),
        conflictWarnings: z.array(z.string()),
        preparationNeeded: z.object({
          before: z.number(),
          tasks: z.array(z.string()),
        }),
      }),
      prompt: `Suggest optimal appointment slots:

Appointment Type: ${params.appointmentType}
Duration: ${params.duration} minutes
Urgency: ${params.urgency || 'medium'}
Preferred Days: ${params.preferredDays?.join(', ') || 'Any'}

Agent Working Hours: ${(agent?.working_hours ? JSON.stringify(agent.working_hours) : null) || '9am-6pm'}
Agent Time Zone: ${agent?.time_zone || 'America/New_York'}

Contact Preference: ${contact?.preferred_contact_time || 'Any time'}
Contact Time Zone: ${contact?.time_zone || 'Same as agent'}

Existing Appointments (next 2 weeks):
${existingAppointments?.map((a: any) => `- ${a.scheduled_at} (${a.duration_minutes} min)`).join('\n') || 'None'}

Consider:
1. Optimal times for ${params.appointmentType}
2. Buffer time before/after
3. Travel time if needed
4. Contact preferences
5. Agent energy levels throughout day`,
    })

    return { success: true, suggestions }
  } catch (error) {
    return handleError(error, "suggestAppointmentSlots")
  }
}

/**
 * AI-powered follow-up scheduling
 */
export async function scheduleSmartFollowUps(params: {
  agentId: string
  daysAhead?: number
}) {
  try {
    const supabase = await createClient()
    const daysAhead = params.daysAhead || 7

    // Get contacts needing follow-up.
    //
    // This query was broken TWICE over, and each fault alone was fatal:
    //  1. `interactions(*)` embedded a table that DOES NOT EXIST (no public.interactions,
    //     and `interactions` is not an FK column on contacts). PostgREST rejects the whole
    //     query on an unknown relation. Nothing in this function ever read
    //     `c.interactions` — only `transactions.length` and the last-contact date are
    //     consumed — so the embed is simply dropped rather than repointed. (The `activities`
    //     read further down this file, ~line 714, is a separate query and is unaffected.)
    //  2. `.or("last_interaction_date...")` filtered a column contacts DOES NOT HAVE. The
    //     real column is `last_contacted_at`. A bad column in a filter fails the query the
    //     same way a bad embed does.
    // With `error` undestructured both faults surfaced as `contacts: null`, i.e. "all
    // contacts have follow-ups scheduled" — this action has never scheduled anything.
    //
    // `transactions` has THREE foreign keys to contacts (contact_id, buyer_contact_id,
    // seller_contact_id), so the bare `transactions(*)` embed was ambiguous and would have
    // failed even on its own. It is now named by constraint, and only the column actually
    // consumed (a count) is selected — never `*` inside an embed (defect #214).
    const { data: contacts, error: contactsError } = await supabase
      .from("contacts")
      .select(`
        *,
        transactions!transactions_contact_id_fkey(id)
      `)
      .eq("agent_id", params.agentId)
      .eq("status", "active")
      .or(`last_contacted_at.is.null,last_contacted_at.lt.${new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()}`)
      .limit(50)

    if (contactsError) {
      console.error("[scheduleSmartFollowUps] contacts read failed:", contactsError.message)
      return { success: false, error: contactsError.message }
    }

    // Get existing follow-ups scheduled
    const { data: existingFollowUps } = await supabase
      .from("scheduled_touchpoints")
      .select("contact_id, scheduled_date")
      .eq("agent_id", params.agentId)
      .gte("scheduled_date", new Date().toISOString())
      .eq("status", "scheduled")

    const existingContactIds = new Set(existingFollowUps?.map((f: any) => f.contact_id) || [])

    const contactsNeedingFollowUp = contacts?.filter(
      (c: any) => !existingContactIds.has(c.id)
    ) || []

    if (contactsNeedingFollowUp.length === 0) {
      return { success: true, message: "All contacts have follow-ups scheduled", scheduled: 0 }
    }

    const { object: followUpPlan } = await generateObject({
      model: resolveModel("anthropic/claude-sonnet-4-20250514"),
      schema: z.object({
        scheduledFollowUps: z.array(z.object({
          contactId: z.string(),
          contactName: z.string(),
          suggestedDate: z.string(),
          suggestedTime: z.string(),
          channel: z.enum(["call", "email", "text", "in_person"]),
          purpose: z.string(),
          talkingPoints: z.array(z.string()),
          priority: z.enum(["high", "medium", "low"]),
        })),
        dailyDistribution: z.record(z.string(), z.number()),
        totalTimeRequired: z.number(),
        priorityOrder: z.array(z.string()),
      }),
      prompt: `Plan follow-ups for these contacts over the next ${daysAhead} days:

${contactsNeedingFollowUp.map((c: any) => `
Contact ID: ${c.id}
Contact: ${c.first_name} ${c.last_name}
Stage: ${c.lifecycle_state || 'Unknown'}
Last Contacted: ${c.last_contacted_at || 'Never'}
Lead Score: ${c.lead_score || 'Unknown'}
Transaction History: ${c.transactions?.length || 0} transactions
Preferred Contact: ${c.preferred_channel || 'Any'}
`).join('\n---\n')}

Create a balanced follow-up schedule that:
1. Prioritizes hot leads and active clients
2. Distributes evenly across days
3. Suggests best channel for each contact
4. Includes specific talking points
5. Respects contact preferences`,
    })

    // Create follow-up appointments
    const { data: tpBrok } = await supabase.from("agents").select("brokerage_id").eq("id", params.agentId).maybeSingle()
    for (const followUp of followUpPlan.scheduledFollowUps) {
      await supabase.from("scheduled_touchpoints").insert({
        contact_id: followUp.contactId,
        agent_id: params.agentId,
        brokerage_id: tpBrok?.brokerage_id,
        touchpoint_type: followUp.channel,
        scheduled_date: `${followUp.suggestedDate}T${followUp.suggestedTime}`,
        message_template: [followUp.purpose, followUp.talkingPoints, followUp.priority]
          .filter(Boolean).join(" | "),
        ai_generated: true,
        status: "scheduled",
      })
    }

    revalidatePath("/calendar")
    // DRAFTED, NOT SCHEDULED-TO-SEND. Nothing in this repo drains
    // scheduled_touchpoints: the only reads are this action's own dedupe and
    // the calendar display. The status CHECK (scheduled|sent|completed|
    // skipped|failed) even anticipates a sender that was never built, so
    // "sent" and "failed" are unreachable states. The row is genuinely
    // SCHEDULED on the agent's calendar — that part is true and useful, and
    // the AI-written message_template is real content they can use. What was
    // false is returning `scheduled: N`, which the caller reads as N outbound
    // messages that will go out on their own. They will not; a human sends
    // them from the calendar.
    return { success: true, followUpPlan, drafted: followUpPlan.scheduledFollowUps.length }
  } catch (error) {
    return handleError(error, "scheduleSmartFollowUps")
  }
}

/**
 * Suggest optimal meeting times based on availability
 */
export async function suggestMeetingTimes(params: {
  agentId: string
  duration: number // minutes
  preferences?: { startTime?: string; endTime?: string; daysAhead?: number }
}) {
  try {
    const supabase = await createClient()
    const duration = params.duration; // Declare the duration variable
    const daysAhead = params.preferences?.daysAhead || 7

    // Get existing showings
    const { data: existingAppointments } = await supabase
      .from("showings")
      .select("scheduled_at, duration_minutes")
      .eq("agent_id", params.agentId)
      .gte("scheduled_at", new Date().toISOString())
      .lte("scheduled_at", new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000).toISOString())

    const { object: suggestions } = await generateObject({
      model: resolveModel("openai/gpt-4o-mini"),
      schema: z.object({
        suggestedSlots: z.array(z.object({
          startTime: z.string(),
          endTime: z.string(),
          score: z.number(),
          reasoning: z.string(),
        })),
      }),
      prompt: `Suggest ${duration}-minute meeting slots for the next ${daysAhead} days.

Existing appointments:
${existingAppointments?.map((a: any) => `- ${a.scheduled_at} (${a.duration_minutes} minutes)`).join('\n') || 'None scheduled'}

Business hours: 9 AM - 6 PM
Return 5 best available time slots with scores (higher = better). Avoid scheduling during existing appointments.`,
    })

    return { success: true, suggestions: suggestions.suggestedSlots }
  } catch (error) {
    return handleError(error, "suggestMeetingTimes")
  }
}

/**
 * Block calendar time for specific activities
 */
export async function blockCalendarTime(params: {
  agentId: string
  startTime: string
  endTime: string
  title: string
  type: "prospecting" | "admin" | "personal" | "buffer"
}) {
  try {
    const supabase = await createClient()

    const { data, error } = await supabase
      .from("calendar_blocks")
      .insert({
        agent_id: params.agentId,
        starts_at: params.startTime, // real columns are starts_at/ends_at
        ends_at: params.endTime,
        block_type: params.type,
        metadata: { title: params.title }, // no title column → metadata jsonb
      })
      .select()
      .single()

    if (error) throw error

    revalidatePath("/calendar")
    return { success: true, block: data }
  } catch (error) {
    return handleError(error, "blockCalendarTime")
  }
}

/**
 * Sync calendar with external providers
 */
export async function syncCalendar(params: {
  agentId: string
  provider: "google" | "outlook"
}) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return { success: false, error: "Unauthorized" }

    // Look up provider account by user and provider type
    const { data: providerAccount } = await supabase
      .from("calendar_provider_accounts")
      .select("id, brokerage_id")
      .eq("user_id", user.id)
      .eq("provider_type", params.provider)
      .eq("is_active", true)
      .maybeSingle()

    if (!providerAccount) {
      // No provider linked — return config-required state
      return { success: false, error: "calendar_not_connected", provider: params.provider }
    }

    // Insert a sync log record using the correct table schema
    const now = new Date().toISOString()
    const { data, error } = await supabase
      .from("calendar_sync_logs")
      .insert({
        provider_account_id: providerAccount.id,
        brokerage_id: providerAccount.brokerage_id,
        direction: "both",
        status: "success",
        started_at: now,
        completed_at: now,
        event_count: 0,
      })
      .select()
      .maybeSingle()

    if (error) throw error

    // Update last_sync_at on the provider account
    await supabase
      .from("calendar_provider_accounts")
      .update({ last_sync_at: now })
      .eq("id", providerAccount.id)

    return { success: true, syncLog: data }
  } catch (error) {
    return handleError(error, "syncCalendar")
  }
}

/**
 * AI-powered meeting preparation
 */
export async function prepareMeetingBrief(params: {
  appointmentId: string
  agentId: string
  forceRegenerate?: boolean
}) {
  try {
    const supabase = await createClient()

    // Cache-first: return the persisted brief for this appointment+agent unless
    // the caller explicitly asks to regenerate (mirrors the upsert key below).
    if (!params.forceRegenerate) {
      const { data: cachedBrief, error: cacheError } = await supabase
        .from("meeting_briefs")
        .select("brief_content, generated_at")
        .eq("appointment_id", params.appointmentId)
        .eq("agent_id", params.agentId)
        .maybeSingle()

      if (!cacheError && cachedBrief?.brief_content) {
        return { success: true, meetingBrief: cachedBrief.brief_content, cached: true, generatedAt: cachedBrief.generated_at }
      }
    }

    const { data: appointment } = await supabase
      .from("showings")
      .select(`
        *,
        contacts(*),
        listings(*)
      `)
      .eq("id", params.appointmentId)
      .single()

    if (!appointment) {
      return { success: false, error: "Appointment not found" }
    }

    const { data: interactions } = await supabase
      .from("activities")
      .select("id, activity_type, title, notes, outcome, channel, status, created_at")
      .eq("contact_id", appointment.contact_id)
      .order("created_at", { ascending: false })
      .limit(10)

    const { data: transactions } = await supabase
      .from("transactions")
      .select("*")
      .eq("contact_id", appointment.contact_id)

    const { object: meetingBrief } = await generateObject({
      model: resolveModel("anthropic/claude-sonnet-4-20250514"),
      schema: z.object({
        executiveSummary: z.string(),
        clientProfile: z.object({
          name: z.string(),
          relationship: z.string(),
          keyFacts: z.array(z.string()),
          communicationStyle: z.string(),
          hotButtons: z.array(z.string()),
        }),
        meetingObjectives: z.array(z.object({
          objective: z.string(),
          importance: z.enum(["primary", "secondary", "tertiary"]),
        })),
        talkingPoints: z.array(z.object({
          topic: z.string(),
          keyPoints: z.array(z.string()),
          questions: z.array(z.string()),
        })),
        potentialObjections: z.array(z.object({
          objection: z.string(),
          response: z.string(),
        })),
        materialsNeeded: z.array(z.string()),
        followUpActions: z.array(z.string()),
        successCriteria: z.array(z.string()),
      }),
      prompt: `Prepare a comprehensive meeting brief:

Appointment: ${appointment.notes}
Date/Time: ${appointment.scheduled_at}
Duration: ${appointment.duration_minutes} minutes

Client: ${appointment.contacts?.first_name} ${appointment.contacts?.last_name}
Contact Type: ${appointment.contacts?.contact_type}
Stage: ${appointment.contacts?.stage}

Recent Interactions:
${interactions?.map((i: any) => `- ${i.created_at}: ${i.activity_type} - ${i.notes?.substring(0, 100)}`).join('\n') || 'None'}

Transaction History:
${transactions?.map((t: any) => `- ${t.property_address}: ${t.status}`).join('\n') || 'None'}

${appointment.listings ? `
Property Context:
- Address: ${appointment.listings.address}
- Price: $${appointment.listings.list_price?.toLocaleString()}
- Status: ${appointment.listings.status}
` : ''}

Create a brief including:
1. Executive summary
2. Client profile and preferences
3. Meeting objectives
4. Talking points with questions
5. Potential objections and responses
6. Materials needed
7. Success criteria`,
    })

    // Save the meeting brief
    await supabase.from("meeting_briefs").upsert({
      appointment_id: params.appointmentId,
      agent_id: params.agentId,
      brief_content: meetingBrief,
      generated_at: new Date().toISOString(),
    }, { onConflict: "appointment_id,agent_id" })

    return { success: true, meetingBrief }
  } catch (error) {
    return handleError(error, "prepareMeetingBrief")
  }
}

/**
 * AI-powered weekly planning
 */
export async function generateWeeklyPlan(params: {
  agentId: string
  weekStartDate: string
  forceRegenerate?: boolean
}) {
  try {
    const supabase = await createClient()

    // Cache-first: return the persisted plan for this agent+week unless the
    // caller explicitly asks to regenerate (mirrors the upsert key below).
    if (!params.forceRegenerate) {
      const { data: cachedPlan, error: cacheError } = await supabase
        .from("weekly_plans")
        .select("plan_content, generated_at")
        .eq("agent_id", params.agentId)
        .eq("week_start", params.weekStartDate)
        .maybeSingle()

      if (!cacheError && cachedPlan?.plan_content) {
        return { success: true, weeklyPlan: cachedPlan.plan_content, cached: true, generatedAt: cachedPlan.generated_at }
      }
    }

    const startDate = new Date(params.weekStartDate)
    const endDate = new Date(startDate.getTime() + 7 * 24 * 60 * 60 * 1000)

    // Get all relevant data for the week
    const { data: appointments } = await supabase
      .from("showings")
      .select("*")
      .eq("agent_id", params.agentId)
      .gte("scheduled_at", startDate.toISOString())
      .lt("scheduled_at", endDate.toISOString())

    const { data: tasks } = await supabase
      .from("tasks")
      .select("*")
      .eq("assigned_to_agent_id", params.agentId)
      .gte("due_date", params.weekStartDate)
      .lt("due_date", endDate.toISOString().split('T')[0])

    const { data: transactions } = await supabase
      .from("transactions")
      .select("*")
      .eq("agent_id", params.agentId)
      .in("status", [...TRANSACTION_STATUSES_IN_ESCROW])

    const { data: goals } = await supabase
      .from("agent_goals")
      .select("*")
      .eq("agent_id", params.agentId)
      .eq("year", startDate.getUTCFullYear()) // agent_goals partitions by year, not period

    const { object: weeklyPlan } = await generateObject({
      model: resolveModel("anthropic/claude-sonnet-4-20250514"),
      schema: z.object({
        weekOverview: z.object({
          focus: z.string(),
          keyPriorities: z.array(z.string()),
          expectedOutcomes: z.array(z.string()),
        }),
        dailyThemes: z.array(z.object({
          day: z.string(),
          theme: z.string(),
          topPriority: z.string(),
          timeBlocks: z.array(z.object({
            time: z.string(),
            activity: z.string(),
            duration: z.number(),
          })),
        })),
        goalProgress: z.array(z.object({
          goal: z.string(),
          currentProgress: z.number(),
          weeklyTarget: z.number(),
          actions: z.array(z.string()),
        })),
        transactionFocus: z.array(z.object({
          transaction: z.string(),
          status: z.string(),
          thisWeekActions: z.array(z.string()),
          riskLevel: z.string(),
        })),
        prospectingPlan: z.object({
          targetHours: z.number(),
          methods: z.array(z.string()),
          expectedContacts: z.number(),
        }),
        selfCareTips: z.array(z.string()),
      }),
      prompt: `Create a comprehensive weekly plan:

Week: ${params.weekStartDate} to ${endDate.toISOString().split('T')[0]}

Scheduled Appointments: ${appointments?.length || 0}
${appointments?.map((a: any) => `- ${a.scheduled_at}: ${a.notes ?? 'Appointment'}`).join('\n') || 'None'}

Pending Tasks: ${tasks?.length || 0}
${tasks?.map((t: any) => `- ${t.title} (Due: ${t.due_date})`).join('\n') || 'None'}

Active Transactions: ${transactions?.length || 0}
${transactions?.map((t: any) => `- ${t.property_address}: ${t.status}`).join('\n') || 'None'}

Goals:
${goals?.map((g: any) => `- ${g.goal_type}: ${g.current_value}/${g.target_value}`).join('\n') || 'No goals set'}

Create a balanced weekly plan that:
1. Ensures transaction progress
2. Includes prospecting time
3. Handles admin efficiently
4. Promotes work-life balance
5. Aligns with goals`,
    })

    // Save the weekly plan
    await supabase.from("weekly_plans").upsert({
      agent_id: params.agentId,
      week_start: params.weekStartDate,
      plan_content: weeklyPlan,
      generated_at: new Date().toISOString(),
    }, { onConflict: "agent_id,week_start" })

    return { success: true, weeklyPlan }
  } catch (error) {
    return handleError(error, "generateWeeklyPlan")
  }
}

/**
 * Auto-populate calendar deadline events from transaction milestones.
 * Called when a transaction is created or updated.
 * Each milestone with a target_date becomes a calendar_event of type "deadline".
 */
export async function createDeadlineEventsFromMilestones(params: {
  transactionId: string
  /** Ignored — derived from the session. */
  brokerageId?: string
}) {
  try {
    // TENANT SCOPE (added). The auth check here was real but stopped at "someone
    // is signed in": `brokerageId` then came from the CALLER and was written
    // straight into `calendar_events.brokerage_id`. So any signed-in user could
    // read another transaction's milestone titles, dates and descriptions
    // (`transaction_id` was the only predicate) and mint system-generated
    // deadline events **inside a brokerage they do not belong to** — events that
    // then show up on that tenant's calendar as if the OS had produced them.
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) {
      return { success: false, error: "Unauthorized" }
    }
    const brokerageId = ctx.brokerageId

    const supabase = await createClient()

    if (!isValidUUID(params.transactionId)) {
      return { success: false, error: "Invalid IDs" }
    }

    // Fetch pending milestones with target dates — scoped to the caller's tenant.
    // `transaction_milestones.brokerage_id` is a real column (verified live).
    const { data: milestones, error: mErr } = await supabase
      .from("transaction_milestones")
      .select("id, title, milestone_type, target_date, description")
      .eq("transaction_id", params.transactionId)
      .eq("brokerage_id", brokerageId)
      .eq("status", "pending")
      .not("target_date", "is", null)

    if (mErr) throw mErr
    if (!milestones || milestones.length === 0) {
      return { success: true, created: 0, message: "No pending milestones with target dates" }
    }

    let created = 0
    let skipped = 0
    const failures: string[] = []

    for (const milestone of milestones) {
      const eventTitle =
        milestone.title || milestone.milestone_type?.replace(/_/g, " ") || "Milestone"

      // Check for existing calendar event for this milestone.
      //
      // The tenant predicate is on this read too — without it the idempotency
      // probe reads across brokerages, so a milestone id colliding in another
      // tenant would suppress an event this tenant is owed. `.limit(1)` because
      // nothing enforces one event per milestone at the database, and a bare
      // maybeSingle() THROWS on a second row — turning a duplicate into a total
      // failure of the whole run.
      const { data: existing, error: existingErr } = await supabase
        .from("calendar_events")
        .select("id")
        .eq("entity_type", "transaction_milestone")
        .eq("entity_id", milestone.id)
        .eq("brokerage_id", brokerageId)
        .limit(1)
        .maybeSingle()

      // A refused idempotency check must NOT fall through to an insert — that is
      // how a deadline gets duplicated on the agent's calendar every time the
      // action runs. Skip the milestone and report it.
      if (existingErr) {
        failures.push(`${eventTitle}: could not check for an existing event (${existingErr.message})`)
        continue
      }

      if (existing) { skipped++; continue } // Already exists

      const targetDate = new Date(milestone.target_date!)
      const startAt = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 9, 0, 0)
      const endAt = new Date(startAt.getTime() + 60 * 60000)

      const { error: insertErr } = await supabase
        .from("calendar_events")
        .insert({
          brokerage_id: brokerageId,
          entity_type: "transaction_milestone",
          entity_id: milestone.id,
          event_type: "deadline",
          start_at: startAt.toISOString(),
          end_at: endAt.toISOString(),
          is_system_generated: true,
          // `title` IS A REAL COLUMN on calendar_events (verified live), and it
          // was being written only into `metadata`. This file's older writer
          // (createAppointment) does the same, which is why the note above
          // getAppointments says per-agent narrowing needs the writer fixed —
          // a reader that renders `title` got nothing from either writer.
          // Stamped in BOTH places: the column for readers that select it, and
          // metadata unchanged so nothing already reading metadata.title breaks.
          title: eventTitle,
          metadata: {
            title: eventTitle,
            description: milestone.description,
            transaction_id: params.transactionId,
            milestone_type: milestone.milestone_type,
          },
        })

      if (insertErr) {
        // Silently dropping this was the whole defect class: `created` counted
        // successes and nothing counted refusals, so a run that wrote NOTHING
        // returned { success: true, created: 0 } — indistinguishable from
        // "every deadline was already on the calendar".
        console.error("[createDeadlineEventsFromMilestones] event insert refused:", insertErr.message)
        failures.push(`${eventTitle}: ${insertErr.message}`)
        continue
      }
      created++
    }

    revalidatePath("/dashboard/calendar")

    return { success: true, created, skipped, failures }
  } catch (error) {
    return handleError(error, "createDeadlineEventsFromMilestones")
  }
}

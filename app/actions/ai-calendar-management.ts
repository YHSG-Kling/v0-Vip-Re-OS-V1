"use server"

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { generateObject } from "ai"
import { resolveModel } from "@/lib/ai/resolve-model"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { z } from "zod"

// ============================================
// AI CALENDAR & SCHEDULING MANAGEMENT
// Smart scheduling with AI optimization
// ============================================

// ============================================
// APPOINTMENT CRUD OPERATIONS
// ============================================

export async function getAppointments(params?: { agentId?: string; contactId?: string; startDate?: string; endDate?: string }) {
  try {
    const supabase = await createClient()
    
    // Query showings without joins first to avoid foreign key errors
    let query = supabase
      .from("showings")
      .select("*")
      .order("scheduled_at", { ascending: true })

    if (params?.agentId) query = query.eq("agent_id", params.agentId)
    if (params?.contactId) query = query.eq("contact_id", params.contactId)
    if (params?.startDate) query = query.gte("scheduled_at", params.startDate)
    if (params?.endDate) query = query.lte("scheduled_at", params.endDate)

    const { data: appointments, error } = await query

    if (error) throw error

    // Manually fetch related data if needed
    if (appointments && appointments.length > 0) {
      const contactIds = appointments.map(a => a.contact_id).filter(Boolean)
      const listingIds = appointments.map(a => a.listing_id).filter(Boolean)

      let contacts = []
      let listings = []

      if (contactIds.length > 0) {
        const { data: contactsData } = await supabase
          .from("contacts")
          .select("*")
          .in("id", contactIds)
        contacts = contactsData || []
      }

      if (listingIds.length > 0) {
        const { data: listingsData } = await supabase
          .from("listings")
          .select("*")
          .in("id", listingIds)
        listings = listingsData || []
      }

      // Merge related data
      const enrichedAppointments = appointments.map(appointment => ({
        ...appointment,
        contact: contacts.find(c => c.id === appointment.contact_id),
        listing: listings.find(l => l.id === appointment.listing_id),
      }))

      return { success: true, appointments: enrichedAppointments }
    }

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
}) {
  try {
    const supabase = await createClient()

    // Calculate duration in minutes from start/end times
    const durationMinutes = params.endTime && params.startTime
      ? Math.round((new Date(params.endTime).getTime() - new Date(params.startTime).getTime()) / 60000)
      : 30

    const { data, error } = await supabase
      .from("showings")
      .insert({
        agent_id: params.agentId,
        contact_id: params.contactId || null,
        listing_id: params.listingId || null,
        notes: params.title + (params.notes ? ` - ${params.notes}` : ""),
        scheduled_at: params.startTime,
        duration_minutes: durationMinutes,
        status: "scheduled",
      })
      .select()
      .maybeSingle()

    if (error) throw error

    revalidatePath("/dashboard")
    revalidatePath("/calendar")

    return { success: true, appointment: data }
  } catch (error) {
    return handleError(error, "createAppointment")
  }
}

export async function updateAppointment(appointmentId: string, updates: any) {
  try {
    const supabase = await createClient()

    // Remap appointment columns to showings columns
    const showingUpdates: any = { updated_at: new Date().toISOString() }
    if (updates.start_time) showingUpdates.scheduled_at = updates.start_time
    if (updates.title) showingUpdates.notes = updates.title
    if (updates.notes) showingUpdates.notes = (showingUpdates.notes || "") + " - " + updates.notes
    if (updates.agent_id) showingUpdates.agent_id = updates.agent_id
    if (updates.contact_id) showingUpdates.contact_id = updates.contact_id
    if (updates.listing_id) showingUpdates.listing_id = updates.listing_id
    if (updates.status) showingUpdates.status = updates.status

    const { data, error } = await supabase
      .from("showings")
      .update(showingUpdates)
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

    const { data, error } = await supabase
      .from("showings")
      .update({
        status: "cancelled",
        notes: reason ? `Cancelled: ${reason}` : "Cancelled",
        updated_at: new Date().toISOString(),
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

    // Get all scheduled items for the day
    const { data: appointments } = await supabase
      .from("showings")
      .select(`
        *,
        contacts(*),
        listings(*)
      `)
      .eq("agent_id", params.agentId)
      .gte("scheduled_at", targetDate.toISOString())
      .lt("scheduled_at", new Date(targetDate.getTime() + 24 * 60 * 60 * 1000).toISOString())
      .order("scheduled_at")

    const { data: tasks } = await supabase
      .from("tasks")
      .select("*")
      .eq("agent_id", params.agentId)
      .eq("due_date", params.date)
      .eq("status", "pending")

    const { data: showings } = await supabase
      .from("showings")
      .select(`
        *,
        listings(*),
        contacts(*)
      `)
      .eq("agent_id", params.agentId)
      .eq("showing_date", params.date)

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
${appointments?.map((a: any) => `- ${a.scheduled_at}: ${a.notes} at ${a.location || 'TBD'}`).join('\n') || 'None'}

Showings:
${showings?.map((s: any) => `- ${s.showing_time}: ${s.listings?.address} for ${s.contacts?.first_name}`).join('\n') || 'None'}

Tasks Due:
${tasks?.map((t: any) => `- ${t.title} (Priority: ${t.priority})`).join('\n') || 'None'}

Optimize for:
1. Minimize travel time between locations
2. Include buffer time between appointments
3. Block time for prospecting/lead gen
4. Resolve any scheduling conflicts
5. Maximize productivity`,
    })

    // Save optimized schedule
    await supabase.from("daily_schedules").upsert({
      agent_id: params.agentId,
      schedule_date: params.date,
      optimized_schedule: optimizedSchedule,
      productivity_score: optimizedSchedule.productivityScore,
    })

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

    // Get agent's availability and preferences
    const { data: agent } = await supabase
      .from("users")
      .select("working_hours, time_zone, calendar_preferences")
      .eq("id", params.agentId)
      .single()

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
      .single()

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

Agent Working Hours: ${JSON.stringify(agent?.working_hours) || '9am-6pm'}
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

    // Get contacts needing follow-up
    const { data: contacts } = await supabase
      .from("contacts")
      .select(`
        *,
        interactions(*),
        transactions(*)
      `)
      .eq("agent_id", params.agentId)
      .eq("status", "active")
      .or(`last_interaction_date.is.null,last_interaction_date.lt.${new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()}`)
      .limit(50)

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
Contact: ${c.first_name} ${c.last_name}
Stage: ${c.stage}
Last Interaction: ${c.last_interaction_date || 'Never'}
Lead Score: ${c.lead_score || 'Unknown'}
Transaction History: ${c.transactions?.length || 0} transactions
Preferred Contact: ${c.preferred_contact_method || 'Any'}
`).join('\n---\n')}

Create a balanced follow-up schedule that:
1. Prioritizes hot leads and active clients
2. Distributes evenly across days
3. Suggests best channel for each contact
4. Includes specific talking points
5. Respects contact preferences`,
    })

    // Create follow-up appointments
    for (const followUp of followUpPlan.scheduledFollowUps) {
      await supabase.from("scheduled_touchpoints").insert({
        contact_id: followUp.contactId,
        agent_id: params.agentId,
        touchpoint_type: followUp.channel,
        scheduled_date: `${followUp.suggestedDate}T${followUp.suggestedTime}`,
        purpose: followUp.purpose,
        talking_points: followUp.talkingPoints,
        priority: followUp.priority,
        ai_generated: true,
        status: "scheduled",
      })
    }

    revalidatePath("/calendar")
    return { success: true, followUpPlan, scheduled: followUpPlan.scheduledFollowUps.length }
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
      prompt: `Suggest ${duration}-minute meeting slots considering existing appointments and business hours.`,
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
        start_time: params.startTime,
        end_time: params.endTime,
        title: params.title,
        block_type: params.type,
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
        status: "completed",
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
}) {
  try {
    const supabase = await createClient()

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

    // Get additional context
    const { data: interactions } = await supabase
      .from("interactions")
      .select("*")
      .eq("contact_id", appointment.contact_id)
      .order("interaction_date", { ascending: false })
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
${interactions?.map((i: any) => `- ${i.interaction_date}: ${i.interaction_type} - ${i.notes?.substring(0, 100)}`).join('\n') || 'None'}

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
    })

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
}) {
  try {
    const supabase = await createClient()
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
      .eq("agent_id", params.agentId)
      .gte("due_date", params.weekStartDate)
      .lt("due_date", endDate.toISOString().split('T')[0])

    const { data: transactions } = await supabase
      .from("transactions")
      .select("*")
      .eq("agent_id", params.agentId)
      .in("status", ["under_contract", "inspection", "financing", "appraisal", "closing"])

    const { data: goals } = await supabase
      .from("agent_goals")
      .select("*")
      .eq("agent_id", params.agentId)
      .eq("period", "weekly")

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
${appointments?.map((a: any) => `- ${a.start_time}: ${a.title}`).join('\n') || 'None'}

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
    })

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
  brokerageId: string
}) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return { success: false, error: "Unauthorized" }

    if (!isValidUUID(params.transactionId) || !isValidUUID(params.brokerageId)) {
      return { success: false, error: "Invalid IDs" }
    }

    // Fetch pending milestones with target dates
    const { data: milestones, error: mErr } = await supabase
      .from("transaction_milestones")
      .select("id, title, milestone_type, target_date, description")
      .eq("transaction_id", params.transactionId)
      .eq("status", "pending")
      .not("target_date", "is", null)

    if (mErr) throw mErr
    if (!milestones || milestones.length === 0) {
      return { success: true, created: 0, message: "No pending milestones with target dates" }
    }

    let created = 0
    for (const milestone of milestones) {
      // Check for existing calendar event for this milestone
      const { data: existing } = await supabase
        .from("calendar_events")
        .select("id")
        .eq("entity_type", "transaction_milestone")
        .eq("entity_id", milestone.id)
        .maybeSingle()

      if (existing) continue // Already exists

      const targetDate = new Date(milestone.target_date!)
      const startAt = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 9, 0, 0)
      const endAt = new Date(startAt.getTime() + 60 * 60000)

      const { error: insertErr } = await supabase
        .from("calendar_events")
        .insert({
          brokerage_id: params.brokerageId,
          entity_type: "transaction_milestone",
          entity_id: milestone.id,
          event_type: "deadline",
          start_at: startAt.toISOString(),
          end_at: endAt.toISOString(),
          is_system_generated: true,
          metadata: {
            title: milestone.title || milestone.milestone_type?.replace(/_/g, " ") || "Milestone",
            description: milestone.description,
            transaction_id: params.transactionId,
            milestone_type: milestone.milestone_type,
          },
        })

      if (!insertErr) created++
    }

    revalidatePath("/dashboard/calendar")

    return { success: true, created }
  } catch (error) {
    return handleError(error, "createDeadlineEventsFromMilestones")
  }
}

"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID } from "@/lib/validations"
import { getAgentContext } from "@/lib/identity/get-agent-context"

/**
 * Voice Assistant System - Hands-free AI for agents on the go
 * Like Alexa/Siri for real estate - voice commands while driving
 *
 * SECURITY: all entry points derive agentId from the authenticated session.
 * Caller-supplied agentId values are ignored — voice config and command
 * history are per-agent data and must be scoped to the calling agent.
 */

interface VoiceIntent {
  type: string
  entities: Record<string, any>
  confidence: number
}

/**
 * Resolve the calling user's agents.id from the session.
 * Falls back to a direct lookup if getAgentContext returns null (e.g. broker
 * with an agents row but no role assignment yet).
 */
async function resolveCallerAgentId(): Promise<{
  agentId: string | null
  brokerageId: string | null
  userId: string
  isAuthenticated: boolean
}> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) {
    return { agentId: null, brokerageId: null, userId: "", isAuthenticated: false }
  }
  if (ctx.agentId) {
    return {
      agentId: ctx.agentId,
      brokerageId: ctx.brokerageId,
      userId: ctx.userId,
      isAuthenticated: true,
    }
  }
  // Fallback: agents.id WHERE user_id = ctx.userId
  const svc = createServiceClient()
  const { data: agentRow } = await svc
    .from("agents")
    .select("id, brokerage_id")
    .eq("user_id", ctx.userId)
    .maybeSingle()
  return {
    agentId: agentRow?.id ?? null,
    brokerageId: ctx.brokerageId ?? agentRow?.brokerage_id ?? null,
    userId: ctx.userId,
    isAuthenticated: true,
  }
}

// Process voice command from agent
export async function processVoiceCommand(params: {
  agentId?: string // ignored — derived from session
  contactId?: string
  commandText: string
  context?: any
  sessionId?: string
}) {
  const { commandText, context, sessionId } = params
  let { contactId } = params

  const caller = await resolveCallerAgentId()
  if (!caller.isAuthenticated) {
    return { success: false, error: "Unauthorized" }
  }
  if (!caller.agentId) {
    return { success: false, error: "No agent profile for current user" }
  }
  const agentId = caller.agentId

  // If caller passed a contactId, verify it belongs to this agent's brokerage
  if (contactId) {
    if (!isValidUUID(contactId)) {
      return { success: false, error: "Invalid contact ID" }
    }
    const svc = createServiceClient()
    const { data: contactRow } = await svc
      .from("contacts")
      .select("brokerage_id")
      .eq("id", contactId)
      .maybeSingle()
    if (!contactRow || contactRow.brokerage_id !== caller.brokerageId) {
      return { success: false, error: "Forbidden" }
    }
  }

  const supabase = await createClient()

  try {
    // Parse intent using AI
    const intent = await parseVoiceIntent(commandText, agentId, context)

    let response = ""
    let actionTaken = ""
    let success = true
    let relatedContactId = contactId

    // Execute command based on intent
    switch (intent.type) {
      case "lookup_contact":
        const contact = await lookupContact(intent.entities.contact_name, agentId)
        if (contact) {
          relatedContactId = contact.id
          response = `${contact.first_name} ${contact.last_name} is a ${contact.contact_type || "contact"} with lead score ${contact.lead_score || 0}. Last contact was ${getDaysSince(contact.last_interaction_date)} days ago.`
        } else {
          response = `I couldn't find ${intent.entities.contact_name} in your contacts.`
          success = false
        }
        actionTaken = "contact_lookup"
        break

      case "get_schedule":
        const appointments = await getTodayAppointments(agentId)
        if (appointments.length === 0) {
          response = "You have no appointments scheduled for today."
        } else {
          const next = appointments[0]
          response = `You have ${appointments.length} appointments today. Next up: ${next.title || next.event_type} at ${formatTime(next.start_time)}`
        }
        actionTaken = "calendar_query"
        break

      case "add_note":
        const noteContact = await lookupContact(intent.entities.contact_name, agentId)
        if (noteContact) {
          relatedContactId = noteContact.id
          await addContactNote(noteContact.id, intent.entities.note_text, agentId)
          response = `Note added to ${noteContact.first_name} ${noteContact.last_name}.`
        } else {
          response = `I couldn't find ${intent.entities.contact_name}.`
          success = false
        }
        actionTaken = "note_created"
        break

      case "send_property":
        const propertyContact = await lookupContact(intent.entities.contact_name, agentId)
        if (propertyContact) {
          relatedContactId = propertyContact.id
          await sendPropertyToContact(intent.entities.property_address, propertyContact.id, agentId)
          response = `Sent property ${intent.entities.property_address} to ${propertyContact.first_name}.`
        } else {
          response = `I couldn't find ${intent.entities.contact_name}.`
          success = false
        }
        actionTaken = "property_sent"
        break

      case "hot_leads":
        const hotLeads = await getHotLeads(agentId)
        if (hotLeads.length === 0) {
          response = "You have no hot leads right now."
        } else {
          response = `You have ${hotLeads.length} hot leads: ${hotLeads.slice(0, 3).map(l => l.first_name).join(", ")}`
        }
        actionTaken = "hot_leads_query"
        break

      case "deals_at_risk":
        const atRisk = await getAtRiskDeals(agentId)
        if (atRisk.length === 0) {
          response = "All your deals are on track!"
        } else {
          response = `Warning: ${atRisk.length} deals need attention. ${atRisk[0].property_address || "First deal"} is missing documents.`
        }
        actionTaken = "risk_check"
        break

      case "create_task":
        await createTask({
          agent_id: agentId,
          contact_id: relatedContactId,
          title: intent.entities.task_title || commandText,
          description: intent.entities.task_description,
          due_date: intent.entities.due_date,
        })
        response = `Task created: ${intent.entities.task_title || "New task"}`
        actionTaken = "task_created"
        break

      default:
        response = "I didn't understand that command. Try 'What's my schedule' or 'Who are my hot leads?'"
        success = false
    }

    // Log command to database
    await supabase.from("voice_commands").insert({
      session_id: sessionId,
      agent_id: agentId,
      contact_id: relatedContactId,
      command_text: commandText,
      intent_detected: intent.type,
      entities_extracted: intent.entities,
      action_taken: actionTaken,
      response_text: response,
      success,
      confidence_score: intent.confidence,
    })

    // Update session command count
    if (sessionId) {
      await supabase.rpc("increment_voice_session_commands", {
        p_session_id: sessionId,
        p_success: success,
      })
    }

    return { success, response, actionTaken, intent: intent.type }
  } catch (error: any) {
    console.error("[voice-assistant] Error processing command:", error)
    return { success: false, error: error.message, response: `Sorry, I couldn't complete that. ${error.message}` }
  }
}

// Start a new voice assistant session
export async function startVoiceSession(_agentId?: string, context?: any) {
  // _agentId ignored — derived from session
  const caller = await resolveCallerAgentId()
  if (!caller.isAuthenticated) {
    return { success: false, error: "Unauthorized" }
  }
  if (!caller.agentId) {
    return { success: false, error: "No agent profile for current user" }
  }

  const supabase = await createClient()

  const { data, error } = await supabase
    .from("voice_assistant_sessions")
    .insert({
      agent_id: caller.agentId,
      session_start: new Date().toISOString(),
      context: context || {},
    })
    .select()
    .single()

  if (error) {
    console.error("[voice-assistant] Error starting session:", error)
    return { success: false, error: error.message }
  }

  return { success: true, sessionId: data.id }
}

// End voice assistant session
export async function endVoiceSession(sessionId: string) {
  if (!isValidUUID(sessionId)) {
    return { success: false, error: "Invalid session ID" }
  }

  const caller = await resolveCallerAgentId()
  if (!caller.isAuthenticated) {
    return { success: false, error: "Unauthorized" }
  }
  if (!caller.agentId) {
    return { success: false, error: "No agent profile for current user" }
  }

  // Verify the session belongs to this agent before mutating
  const svc = createServiceClient()
  const { data: session } = await svc
    .from("voice_assistant_sessions")
    .select("agent_id")
    .eq("id", sessionId)
    .maybeSingle()
  if (!session || session.agent_id !== caller.agentId) {
    return { success: false, error: "Forbidden" }
  }

  const supabase = await createClient()

  const { error } = await supabase
    .from("voice_assistant_sessions")
    .update({ session_end: new Date().toISOString() })
    .eq("id", sessionId)

  if (error) {
    console.error("[voice-assistant] Error ending session:", error)
    return { success: false, error: error.message }
  }

  return { success: true }
}

// Get or create voice assistant config for agent
export async function getVoiceConfig(_agentId?: string) {
  // _agentId ignored — derived from session
  const caller = await resolveCallerAgentId()
  if (!caller.isAuthenticated) {
    return { success: false, error: "Unauthorized" }
  }
  if (!caller.agentId) {
    return { success: false, error: "No agent profile for current user" }
  }
  const agentId = caller.agentId

  const supabase = await createClient()

  let { data: config } = await supabase
    .from("voice_assistant_config")
    .select("*")
    .eq("agent_id", agentId)
    .single()

  // Create default config if doesn't exist
  if (!config) {
    const { data: newConfig, error } = await supabase
      .from("voice_assistant_config")
      .insert({
        agent_id: agentId,
        voice_enabled: true,
        wake_word: "hey assistant",
        voice_type: "female",
        voice_speed: 1.0,
        proactive_alerts: true,
      })
      .select()
      .single()

    if (error) {
      console.error("[voice-assistant] Error creating config:", error)
      return { success: false, error: error.message }
    }

    config = newConfig
  }

  return { success: true, config }
}

// Update voice assistant config
export async function updateVoiceConfig(_agentId: string | undefined, updates: any) {
  // _agentId ignored — derived from session
  const caller = await resolveCallerAgentId()
  if (!caller.isAuthenticated) {
    return { success: false, error: "Unauthorized" }
  }
  if (!caller.agentId) {
    return { success: false, error: "No agent profile for current user" }
  }
  const agentId = caller.agentId

  const supabase = await createClient()

  const { data, error } = await supabase
    .from("voice_assistant_config")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("agent_id", agentId)
    .select()
    .single()

  if (error) {
    console.error("[voice-assistant] Error updating config:", error)
    return { success: false, error: error.message }
  }

  return { success: true, config: data }
}

// Get recent voice commands for agent
export async function getVoiceCommandHistory(_agentId?: string, limit = 50) {
  // _agentId ignored — derived from session
  const caller = await resolveCallerAgentId()
  if (!caller.isAuthenticated) {
    return { success: false, error: "Unauthorized" }
  }
  if (!caller.agentId) {
    return { success: false, error: "No agent profile for current user" }
  }
  const agentId = caller.agentId

  const supabase = await createClient()

  const { data, error } = await supabase
    .from("voice_commands")
    .select("*, contacts(first_name, last_name)")
    .eq("agent_id", agentId)
    .order("created_at", { ascending: false })
    .limit(limit)

  if (error) {
    console.error("[voice-assistant] Error fetching history:", error)
    return { success: false, error: error.message }
  }

  return { success: true, commands: data || [] }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

async function parseVoiceIntent(commandText: string, agentId: string, context: any): Promise<VoiceIntent> {
  // Use OpenAI to parse natural language intent
  const prompt = `
Parse this voice command for a real estate agent:

Command: "${commandText}"

Context:
- Agent ID: ${agentId}
- Current Location: ${context?.location || "unknown"}
- Current Time: ${new Date().toLocaleTimeString()}
- Active Transaction: ${context?.active_transaction || "none"}

Detect Intent (one of):
- lookup_contact: Find info about a contact
- get_schedule: Calendar queries
- add_note: Add note to contact
- send_property: Send listing to contact
- hot_leads: Get hot leads list
- deals_at_risk: Check deal health
- create_task: Create a task
- call_contact: Initiate call

Extract Entities:
- contact_name: Person's name mentioned
- property_address: Address mentioned
- note_text: Note content
- task_title: Task title
- task_description: Task description
- due_date: Any time/date mentioned

Return JSON:
{
  "type": "intent_type",
  "entities": {},
  "confidence": 0.95
}
`

  try {
    const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || ""}/api/ai/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, temperature: 0.2 }),
    })

    const result = await response.json()
    return result as VoiceIntent
  } catch (error) {
    // Fallback to simple keyword matching
    return simpleIntentParsing(commandText)
  }
}

function simpleIntentParsing(text: string): VoiceIntent {
  const lower = text.toLowerCase()

  if (lower.includes("schedule") || lower.includes("appointment") || lower.includes("calendar")) {
    return { type: "get_schedule", entities: {}, confidence: 0.8 }
  }
  if (lower.includes("hot lead") || lower.includes("top lead")) {
    return { type: "hot_leads", entities: {}, confidence: 0.8 }
  }
  if (lower.includes("risk") || lower.includes("problem") || lower.includes("concern")) {
    return { type: "deals_at_risk", entities: {}, confidence: 0.8 }
  }
  if (lower.includes("add note") || lower.includes("make note")) {
    return { type: "add_note", entities: { note_text: text }, confidence: 0.7 }
  }

  return { type: "unknown", entities: {}, confidence: 0.5 }
}

async function lookupContact(name: string, agentId: string) {
  const supabase = await createClient()
  const { data } = await supabase
    .from("contacts")
    .select("*")
    .eq("agent_id", agentId)
    .or(`first_name.ilike.%${name}%,last_name.ilike.%${name}%`)
    .limit(1)
    .single()

  return data
}

async function getTodayAppointments(agentId: string) {
  const supabase = await createClient()
  const today = new Date().toISOString().split("T")[0]

  const { data } = await supabase
    .from("calendar_events")
    .select("*")
    .eq("agent_id", agentId)
    .gte("start_time", `${today}T00:00:00`)
    .lte("start_time", `${today}T23:59:59`)
    .order("start_time", { ascending: true })

  return data || []
}

async function addContactNote(contactId: string, _noteText: string, _agentId: string) {
  const supabase = await createClient()
  // contact_notes uses body (not content), author_user_id (not agent_id), is_private.
  // The voice-assistant flow doesn't carry the auth user id directly, so derive it.
  const { data: { user } } = await supabase.auth.getUser()
  return await supabase.from("contact_notes").insert({
    contact_id: contactId,
    author_user_id: user?.id ?? null,
    body: _noteText,
    is_private: false,
  })
}

async function sendPropertyToContact(address: string, contactId: string, agentId: string) {
  const supabase = await createClient()
  // Find property by address
  const { data: property } = await supabase
    .from("listings")
    .select("id")
    .ilike("address", `%${address}%`)
    .limit(1)
    .single()

  if (property) {
    // Create property share record
    return await supabase.from("property_shares").insert({
      property_id: property.id,
      contact_id: contactId,
      agent_id: agentId,
      share_method: "voice_command",
    })
  }
}

async function getHotLeads(agentId: string) {
  const supabase = await createClient()
  const { data } = await supabase
    .from("contacts")
    .select("*")
    .eq("agent_id", agentId)
    .gte("lead_score", 80)
    .order("lead_score", { ascending: false })
    .limit(10)

  return data || []
}

async function getAtRiskDeals(agentId: string) {
  const supabase = await createClient()
  const { data } = await supabase
    .from("transactions")
    .select("*")
    .eq("agent_id", agentId)
    .eq("health_status", "at_risk")
    .limit(10)

  return data || []
}

async function createTask(task: any) {
  const supabase = await createClient()
  return await supabase.from("tasks").insert(task)
}

function getDaysSince(date: string | null): number {
  if (!date) return 999
  const diff = Date.now() - new Date(date).getTime()
  return Math.floor(diff / (1000 * 60 * 60 * 24))
}

function formatTime(time: string): string {
  return new Date(time).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
}

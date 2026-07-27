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
 * ROUND-TRIP RECEIPT line — spoken ONLY from the fresh ledger row the intent
 * writer read back after its write (LedgerReceipt), never from the command
 * input. "Done" from the voice admin always means "verified on the ledger".
 */
function speakReceipt(r?: import("@/app/actions/intent-writers").LedgerReceipt): string {
  if (!r) return ""
  const at = r.recordedAt
    ? new Date(r.recordedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : null
  const facts = Object.entries(r.facts).map(([k, v]) => `${k} ${v}`).join(", ")
  return ` Verified on the ledger${at ? ` at ${at}` : ""}${facts ? ` — ${facts}` : ""}.`
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
        // pass 12: calendar_events.agent_user_id is the USERS class — pass the
        // auth user id, not agents.id (the old filter always returned empty).
        const appointments = await getTodayAppointments(caller.userId)
        if (appointments.length === 0) {
          response = "You have no appointments scheduled for today."
        } else {
          const next = appointments[0]
          response = `You have ${appointments.length} appointments today. Next up: ${next.title || next.event_type} at ${formatTime(next.start_at)}`
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
          await sendPropertyToContact(intent.entities.property_address, propertyContact.id, agentId, caller.brokerageId)
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

      case "ai_work_receipt": {
        // THE SPOKEN ACTION RECEIPT (item 2) — answer "what did you do?" from
        // the real ledgers: overnight autonomous systems + ISA handoffs +
        // outreach + staged drafts. Same sources as the morning briefing.
        const { buildOvernightAiWork } = await import("@/lib/intelligence/overnight-ai-work")
        const { composeSpokenAiReceipt } = await import("@/lib/intelligence/spoken-ai-receipt")
        const svcR = createServiceClient()
        const sinceR = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
        const [overnight, handoffs, outreach, drafts] = await Promise.all([
          caller.brokerageId
            ? buildOvernightAiWork(svcR as any, { agentUserId: caller.userId, brokerageId: caller.brokerageId, since: sinceR }).catch(() => null)
            : Promise.resolve(null),
          svcR.from("assignment_log").select("id", { count: "exact", head: true })
            .eq("agent_id", agentId).gte("created_at", sinceR),
          svcR.from("isa_outreach_log").select("id", { count: "exact", head: true })
            .eq("brokerage_id", caller.brokerageId).gte("created_at", sinceR),
          svcR.from("ai_message_drafts").select("id", { count: "exact", head: true })
            .eq("agent_user_id", caller.userId).gte("created_at", sinceR),
        ])
        response = composeSpokenAiReceipt({
          overnight,
          isaHandoffs: handoffs.count ?? 0,
          isaOutreach: outreach.count ?? 0,
          draftsStaged: drafts.count ?? 0,
          windowLabel: "the last 24 hours",
        })
        actionTaken = "ai_work_receipt"
        break
      }

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
        }, caller.brokerageId)
        response = `Task created: ${intent.entities.task_title || "New task"}`
        actionTaken = "task_created"
        break

      // ── VOICE-ADMIN INTENT WRITERS (burn-down round 4) — "tell the admin and
      // it's done": these dispatch the intent-writers actions, which are the
      // ONE writers for document_requests / contact_vendors / property_upgrades.
      // ROUND-TRIP RECEIPTS (round 11): every success line ends with a receipt
      // composed from the FRESH ledger row the writer read back — the admin
      // never says "done" from intent, only from the verified write.
      case "request_document": {
        const docContact = intent.entities.contact_name
          ? await lookupContact(intent.entities.contact_name, agentId)
          : null
        if (docContact) relatedContactId = docContact.id
        const docName = intent.entities.document_name || intent.entities.task_title
        if (!docName) {
          response = "Which document should I request?"
          success = false
        } else {
          const { requestDocument } = await import("@/app/actions/intent-writers")
          const r = await requestDocument({
            documentName: docName,
            contactId: docContact?.id ?? relatedContactId ?? null,
            transactionId: context?.active_transaction ?? null,
            dueDate: intent.entities.due_date ?? null,
          })
          if (r.success) {
            response = (docContact
              ? `Requested "${docName}" from ${docContact.first_name}. It's on the tracked list — I'll flag it if it goes overdue.`
              : `Requested "${docName}". It's on the tracked list — I'll flag it if it goes overdue.`
            ) + speakReceipt(r.receipt)
          } else {
            response = "I couldn't file that document request."
            success = false
          }
        }
        actionTaken = "document_requested"
        break
      }

      case "assign_vendor": {
        const vContact = await lookupContact(intent.entities.contact_name, agentId)
        if (!vContact) {
          response = `I couldn't find ${intent.entities.contact_name}.`
          success = false
          actionTaken = "vendor_assigned"
          break
        }
        relatedContactId = vContact.id
        // Resolve the vendor by name within the tenant (vendors is canonical).
        const svcV = createServiceClient()
        const vendorName = String(intent.entities.vendor_name ?? "").trim()
        // vendors.name is the live column (NOT business_name — live-verified).
        const { data: vendorRows } = vendorName
          ? await svcV.from("vendors").select("id, name").eq("brokerage_id", caller.brokerageId).ilike("name", `%${vendorName}%`).limit(1)
          : { data: null }
        const vendor = (vendorRows ?? [])[0] ?? null
        if (!vendor) {
          response = vendorName
            ? `I couldn't find a vendor named ${vendorName} in your directory.`
            : "Which vendor should I introduce?"
          success = false
        } else {
          const { assignVendorToContact } = await import("@/app/actions/intent-writers")
          const r = await assignVendorToContact({
            contactId: vContact.id,
            vendorId: vendor.id as string,
            role: intent.entities.vendor_role ?? null,
          })
          response = r.success
            ? `Linked ${vendor.name} to ${vContact.first_name} — the vendor can now message them and it shows on the contact's profile.` + speakReceipt(r.receipt)
            : "I couldn't link that vendor."
          success = r.success
        }
        actionTaken = "vendor_assigned"
        break
      }

      case "set_portal_milestones": {
        const pContact = await lookupContact(intent.entities.contact_name, agentId)
        const milestoneKey = String(intent.entities.milestone_name ?? "").trim().toLowerCase().replace(/\s+/g, "_")
        if (!pContact || !milestoneKey) {
          response = !pContact ? `I couldn't find ${intent.entities.contact_name}.` : "Which milestone should I change?"
          success = false
        } else {
          relatedContactId = pContact.id
          const visible = !/hide|remove|off/.test(commandText.toLowerCase())
          const { setPortalMilestonePreferences } = await import("@/app/actions/intent-writers")
          const r = await setPortalMilestonePreferences({
            contactId: pContact.id,
            milestoneOverrides: { [milestoneKey]: visible },
          })
          response = r.success
            ? `${visible ? "Showing" : "Hiding"} the ${milestoneKey.replace(/_/g, " ")} milestone on ${pContact.first_name}'s portal.` + speakReceipt(r.receipt)
            : "I couldn't update that portal preference."
          success = r.success
        }
        actionTaken = "portal_milestones_updated"
        break
      }

      case "log_upgrade": {
        // Resolve the listing by address within the agent's book.
        const svcU = createServiceClient()
        const addr = String(intent.entities.property_address ?? "").trim()
        const { data: listingRows } = addr
          ? await svcU.from("listings").select("id, address").eq("brokerage_id", caller.brokerageId).ilike("address", `%${addr}%`).limit(1)
          : { data: null }
        const listing = (listingRows ?? [])[0] ?? null
        const upgradeText = intent.entities.note_text || intent.entities.task_title
        if (!listing || !upgradeText) {
          response = !listing ? "Which listing is the upgrade for?" : "What was the upgrade?"
          success = false
        } else {
          const { logPropertyUpgrade } = await import("@/app/actions/intent-writers")
          const r = await logPropertyUpgrade({
            listingId: listing.id as string,
            description: upgradeText,
            estimatedCost: intent.entities.amount ? Number(intent.entities.amount) : null,
          })
          response = r.success
            ? `Logged the upgrade on ${listing.address} — it'll show in the seller's CMA valuation.` + speakReceipt(r.receipt)
            : "I couldn't log that upgrade."
          success = r.success
        }
        actionTaken = "upgrade_logged"
        break
      }

      default:
        response = "I didn't understand that command. Try 'What's my schedule' or 'Who are my hot leads?'"
        success = false
    }

    // Log command to database. Canonical voice_commands columns: user_id (FK→users,
    // NOT agents), brokerage_id, raw_transcript (NOT NULL); intent → parsed_intent
    // (command_type left NULL — its CHECK doesn't cover these free-form intents);
    // contact_id/session_id have no columns here, folded into entities jsonb;
    // response → action_result jsonb.
    await supabase.from("voice_commands").insert({
      user_id: caller.userId,
      brokerage_id: caller.brokerageId,
      raw_transcript: commandText,
      parsed_intent: intent.type,
      entities: { ...intent.entities, contact_id: relatedContactId ?? null, session_id: sessionId ?? null },
      action_taken: actionTaken,
      action_result: { response },
      success,
      confidence_score: intent.confidence,
      source: "web",
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
      brokerage_id: caller.brokerageId,
      session_start: new Date().toISOString(),
      context_state: context || {},
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
        brokerage_id: caller.brokerageId,
        wake_word: "hey assistant",
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

  // Whitelist to real voice_assistant_config columns (UI may still send the old
  // voice_enabled/voice_type/voice_speed/proactive_alerts phantom keys).
  const { data, error } = await supabase
    .from("voice_assistant_config")
    .update({
      ...(updates.wake_word !== undefined ? { wake_word: updates.wake_word } : {}),
      ...(updates.auto_briefing !== undefined ? { auto_briefing: updates.auto_briefing } : {}),
      ...(updates.preferred_commands !== undefined ? { preferred_commands: updates.preferred_commands } : {}),
      ...(updates.voice_profile_id !== undefined ? { voice_profile_id: updates.voice_profile_id } : {}),
      updated_at: new Date().toISOString(),
    })
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
  const supabase = await createClient()

  // voice_commands is owned by user_id (FK→users); there is no contact_id FK to embed.
  const { data, error } = await supabase
    .from("voice_commands")
    .select("*")
    .eq("user_id", caller.userId)
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
- request_document: Ask a client for a document ("request the pre-approval letter from Jane")
- assign_vendor: Introduce/link a vendor to a contact ("assign my stager to the Hendersons")
- log_upgrade: Record a property upgrade/renovation on a listing ("they added a new roof at 12 Oak St")
- set_portal_milestones: Show/hide a milestone on a client's portal ("hide the inspection milestone from Jane's portal")

Extract Entities:
- contact_name: Person's name mentioned
- property_address: Address mentioned
- note_text: Note content
- task_title: Task title
- task_description: Task description
- due_date: Any time/date mentioned
- document_name: Document being requested
- vendor_name: Vendor/business name mentioned
- vendor_role: The vendor's role (stager, inspector, lender, …)
- amount: Any dollar amount mentioned (number only)
- milestone_name: Portal milestone mentioned (inspection, appraisal, …)

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
  if (lower.includes("request") && (lower.includes("document") || lower.includes("letter") || lower.includes("pre-approval") || lower.includes("preapproval"))) {
    return { type: "request_document", entities: { document_name: text }, confidence: 0.6 }
  }
  if ((lower.includes("assign") || lower.includes("introduce") || lower.includes("connect")) && (lower.includes("vendor") || lower.includes("stager") || lower.includes("inspector") || lower.includes("photographer"))) {
    return { type: "assign_vendor", entities: {}, confidence: 0.6 }
  }
  if (lower.includes("upgrade") || lower.includes("renovation") || lower.includes("remodel")) {
    return { type: "log_upgrade", entities: { note_text: text }, confidence: 0.6 }
  }
  // The spoken action receipt — "what did you (all) do", "daily receipt",
  // "while I was out/asleep", "AI report".
  if (
    lower.includes("what did you do") || lower.includes("what did the team do") ||
    lower.includes("daily receipt") || lower.includes("ai report") ||
    lower.includes("while i was")
  ) {
    return { type: "ai_work_receipt", entities: {}, confidence: 0.85 }
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

// pass 12: takes the auth users.id — calendar_events.agent_user_id is USERS-class.
async function getTodayAppointments(agentUserId: string) {
  const supabase = await createClient()
  const today = new Date().toISOString().split("T")[0]

  const { data } = await supabase
    .from("calendar_events")
    .select("*")
    .eq("agent_user_id", agentUserId)
    .gte("start_at", `${today}T00:00:00`)
    .lte("start_at", `${today}T23:59:59`)
    .order("start_at", { ascending: true })

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

async function sendPropertyToContact(address: string, contactId: string, agentId: string, brokerageId: string | null) {
  const supabase = await createClient()
  // Find property by address WITHIN the caller's brokerage. brokerageId was already a
  // parameter here and simply never used in the query — a spoken address could resolve
  // to another tenant's listing, and the activities row below then joined THEIR
  // listing_id to this caller's brokerage and contact.
  if (!brokerageId) return null
  const { data: property } = await supabase
    .from("listings")
    .select("id")
    .eq("brokerage_id", brokerageId)
    .ilike("address", `%${address}%`)
    .limit(1)
    .maybeSingle()

  if (property) {
    // pass 14: property_shares was a PHANTOM table — the share rides the
    // canonical activities ledger (listing_id + contact + agents-class agent_id).
    return await supabase.from("activities").insert({
      brokerage_id: brokerageId,
      listing_id: property.id,
      contact_id: contactId,
      agent_id: agentId,
      activity_type: "property_shared",
      channel: "voice",
      title: "Property shared by voice command",
      status: "completed",
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

async function createTask(task: any, brokerageId: string | null) {
  const supabase = await createClient()
  // tenant anchor (scope burn-down): every voice-created task is stamped with
  // the calling agent's brokerage.
  return await supabase.from("tasks").insert({ ...task, brokerage_id: brokerageId })
}

function getDaysSince(date: string | null): number {
  if (!date) return 999
  const diff = Date.now() - new Date(date).getTime()
  return Math.floor(diff / (1000 * 60 * 60 * 24))
}

function formatTime(time: string): string {
  return new Date(time).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
}

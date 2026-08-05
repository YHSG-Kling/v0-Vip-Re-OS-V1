

// =====================================================
// GO HIGH LEVEL (GHL) INTEGRATION SERVICE
// =====================================================
// All communications route through GHL to maintain contact history
// Includes: SMS, Email, Calls, Social Media, Calendar

const GHL_BASE_URL = "https://services.leadconnectorhq.com"
const GHL_API_VERSION = "2021-07-28"

interface GHLConfig {
  apiKey: string
  locationId: string
}

function getGHLConfig(): GHLConfig | null {
  const apiKey = process.env.GHL_API_KEY
  const locationId = process.env.GHL_LOCATION_ID

  if (!apiKey || !locationId) {
    console.warn(
      "[GHL Service] Go High Level not configured. Add GHL_API_KEY and GHL_LOCATION_ID to environment variables.",
    )
    return null
  }

  return { apiKey, locationId }
}

async function ghlFetch(endpoint: string, options: RequestInit = {}, configOverride?: GHLConfig | null) {
  // configOverride carries a TENANT's own GHL credential (resolved from the
  // Connection Center / connection cascade). When absent we fall back to the
  // platform env credential, preserving every existing caller's behavior.
  const config = configOverride ?? getGHLConfig()
  if (!config) {
    // THROW, do not return. This function's contract — stated two lines below —
    // is "returns parsed data on success, throws on a non-2xx". Returning a
    // {success:false} object here broke that contract for the seven callers that
    // wrap the result as `{ success: true, contact: result.contact }`: they read
    // the object as GHL data, found no such field, and reported SUCCESS with an
    // undefined id. There was no `mock` flag on those returns, so nothing
    // downstream could tell a fabricated success from a real one.
    //
    // Every caller already wraps this in try/catch and returns
    // { success: false, error: error.message }, so throwing is what makes them
    // all honest at once.
    throw new Error("GHL not configured. Add GHL_API_KEY and GHL_LOCATION_ID to environment variables.")
  }

  // Route through the single connector-gateway (one way in/out). Behavior preserved:
  // returns parsed data on success, throws on a non-2xx response.
  const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
  const method = (options.method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE") ?? "GET"
  const body = options.body ? JSON.parse(options.body as string) : undefined
  const res = await callConnector({
    connector: "gohighlevel",
    baseUrl: GHL_BASE_URL,
    path: endpoint,
    method,
    body,
    headers: { Version: GHL_API_VERSION, ...(options.headers as Record<string, string> | undefined) },
    auth: { style: "bearer", token: config.apiKey },
  })

  if (!res.ok) {
    throw new Error(res.error || "GHL API error")
  }
  return res.data
}

// =====================================================
// CONTACT MANAGEMENT
// =====================================================

export interface GHLContact {
  id?: string
  firstName: string
  lastName: string
  email?: string
  phone?: string
  tags?: string[]
  source?: string
  customFields?: Record<string, any>
  address1?: string
  city?: string
  state?: string
  postalCode?: string
}

export async function syncContactToGHL(contact: GHLContact, credentialOverride?: GHLConfig | null) {
  // credentialOverride carries a TENANT's own GHL apiKey + locationId (resolved
  // from the unified connection cascade in lib/crm/sync.ts). Without it we fall
  // back to the platform env credential so existing callers are unchanged.
  const config = credentialOverride ?? getGHLConfig()
  if (!config) {
    return { success: false, error: "GHL not configured. Add GHL_API_KEY and GHL_LOCATION_ID to environment variables.", requiresConfiguration: true }
  }

  try {
    // Check if contact exists by email or phone
    let existingContact = null
    if (contact.email) {
      const searchResult = await ghlFetch(
        `/contacts/?locationId=${config.locationId}&email=${encodeURIComponent(contact.email)}`,
        {},
        config,
      )
      if (searchResult.contacts?.length > 0) {
        existingContact = searchResult.contacts[0]
      }
    }

    if (existingContact) {
      // Update existing contact
      const result = await ghlFetch(`/contacts/${existingContact.id}`, {
        method: "PUT",
        body: JSON.stringify({
          ...contact,
          locationId: config.locationId,
        }),
      }, config)
      return { success: true, contactId: existingContact.id, action: "updated", data: result }
    } else {
      // Create new contact
      const result = await ghlFetch("/contacts/", {
        method: "POST",
        body: JSON.stringify({
          ...contact,
          locationId: config.locationId,
        }),
      }, config)
      return { success: true, contactId: result.contact?.id, action: "created", data: result }
    }
  } catch (error: any) {
    console.error("[GHL Service] Sync contact error:", error)
    return { success: false, error: error.message }
  }
}

export async function getGHLContact(contactId: string) {
  try {
    const result = await ghlFetch(`/contacts/${contactId}`)
    return { success: true, contact: result.contact }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

export async function searchGHLContacts(query: string) {
  const config = getGHLConfig()
  if (!config) {
    return { success: false, error: "GHL not configured", contacts: [] }
  }

  try {
    const result = await ghlFetch(`/contacts/?locationId=${config.locationId}&query=${encodeURIComponent(query)}`)
    return { success: true, contacts: result.contacts || [] }
  } catch (error: any) {
    return { success: false, error: error.message, contacts: [] }
  }
}

// =====================================================
// SMS MESSAGING (via GHL)
// =====================================================

export interface GHLMessage {
  contactId: string
  message: string
  type: "SMS" | "Email" | "Call" | "WhatsApp" | "GMB" | "FB" | "IG"
}

// =====================================================
// EMAIL (via GHL)
// =====================================================

// =====================================================
// CONVERSATIONS / MESSAGE HISTORY
// =====================================================

export async function getGHLConversations(params?: {
  contactId?: string
  limit?: number
  startAfter?: string
}) {
  const config = getGHLConfig()
  if (!config) {
    return { success: false, error: "GHL not configured", conversations: [] }
  }

  try {
    let url = `/conversations/?locationId=${config.locationId}`
    if (params?.contactId) url += `&contactId=${params.contactId}`
    if (params?.limit) url += `&limit=${params.limit}`
    if (params?.startAfter) url += `&startAfter=${params.startAfter}`

    const result = await ghlFetch(url)
    return { success: true, conversations: result.conversations || [] }
  } catch (error: any) {
    return { success: false, error: error.message, conversations: [] }
  }
}

export async function getGHLMessages(conversationId: string, limit = 50) {
  try {
    const result = await ghlFetch(`/conversations/${conversationId}/messages?limit=${limit}`)
    return { success: true, messages: result.messages || [] }
  } catch (error: any) {
    return { success: false, error: error.message, messages: [] }
  }
}

export async function getContactConversationHistory(contactId: string) {
  const config = getGHLConfig()
  if (!config) {
    return {
      success: false,
      error: "GHL not configured",
      history: [],
      mock: true,
    }
  }

  try {
    // Get all conversations for this contact
    const convResult = await ghlFetch(`/conversations/?locationId=${config.locationId}&contactId=${contactId}`)
    const conversations = convResult.conversations || []

    // Get messages from each conversation
    const history: any[] = []
    for (const conv of conversations.slice(0, 5)) {
      // Limit to last 5 conversations
      const msgResult = await ghlFetch(`/conversations/${conv.id}/messages?limit=20`)
      history.push({
        conversationId: conv.id,
        type: conv.type,
        lastMessageDate: conv.lastMessageDate,
        messages: msgResult.messages || [],
      })
    }

    return { success: true, history }
  } catch (error: any) {
    return { success: false, error: error.message, history: [] }
  }
}

// =====================================================
// SOCIAL MEDIA POSTING (via GHL Social Planner)
// =====================================================

export interface GHLSocialPost {
  content: string
  platforms: Array<"facebook" | "instagram" | "linkedin" | "twitter" | "tiktok" | "google">
  mediaUrls?: string[]
  scheduledTime?: string // ISO date string
  locationId?: string
}

// =====================================================
// CALENDAR & APPOINTMENTS
// =====================================================

// =====================================================
// CALL TRACKING
// =====================================================

export async function logGHLCall(params: {
  contactId: string
  direction: "inbound" | "outbound"
  duration?: number
  recordingUrl?: string
  notes?: string
  outcome?: "answered" | "voicemail" | "no_answer" | "busy"
}) {
  const config = getGHLConfig()
  if (!config) {
    return { success: false, error: "GHL not configured. Add GHL_API_KEY and GHL_LOCATION_ID to environment variables.", requiresConfiguration: true }
  }

  try {
    const result = await ghlFetch("/conversations/messages", {
      method: "POST",
      body: JSON.stringify({
        type: "Call",
        contactId: params.contactId,
        direction: params.direction,
        callDuration: params.duration,
        callStatus: params.outcome || "answered",
        recordingUrl: params.recordingUrl,
        message: params.notes || `${params.direction} call - ${params.outcome || "answered"}`,
      }),
    })

    return { success: true, callId: result.id }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

// =====================================================
// WORKFLOWS & AUTOMATIONS
// =====================================================

// =====================================================
// TAGS MANAGEMENT
// =====================================================

export async function addGHLContactTags(contactId: string, tags: string[]) {
  try {
    const result = await ghlFetch(`/contacts/${contactId}/tags`, {
      method: "POST",
      body: JSON.stringify({ tags }),
    })
    return { success: true, data: result }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

export async function removeGHLContactTags(contactId: string, tags: string[]) {
  try {
    const result = await ghlFetch(`/contacts/${contactId}/tags`, {
      method: "DELETE",
      body: JSON.stringify({ tags }),
    })
    return { success: true, data: result }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

// =====================================================
// NOTES
// =====================================================

export async function addGHLContactNote(contactId: string, note: string) {
  try {
    const result = await ghlFetch(`/contacts/${contactId}/notes`, {
      method: "POST",
      body: JSON.stringify({ body: note }),
    })
    return { success: true, noteId: result.id }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

export async function getGHLContactNotes(contactId: string) {
  try {
    const result = await ghlFetch(`/contacts/${contactId}/notes`)
    return { success: true, notes: result.notes || [] }
  } catch (error: any) {
    return { success: false, error: error.message, notes: [] }
  }
}

// =====================================================
// BULK SYNC UTILITY
// =====================================================

export async function bulkSyncContactsToGHL(contacts: GHLContact[]) {
  const results = {
    success: 0,
    failed: 0,
    errors: [] as string[],
  }

  for (const contact of contacts) {
    try {
      const result = await syncContactToGHL(contact)
      if (result.success) {
        results.success++
      } else {
        results.failed++
        results.errors.push(`${contact.email}: ${result.error}`)
      }
    } catch (error: any) {
      results.failed++
      results.errors.push(`${contact.email}: ${error.message}`)
    }
  }

  return results
}



// =====================================================
// GO HIGH LEVEL (GHL) INTEGRATION SERVICE — the ONE GHL egress module.
// =====================================================
// All communications route through GHL to maintain contact history
// Includes: SMS, Email, Calls, Social Media, Calendar
//
// TOMBSTONE (orphan doctrine §1.3, 2026-08-27) — lib/ghl-integration.ts
// (class GHLIntegration + singleton ghlIntegration) is DELETED; THIS file is
// the survivor. Its last importer was the duplicate webhook route
// app/api/webhooks/ghl/route.ts, deleted the same day (survivor:
// app/api/webhooks/gohighlevel/route.ts), which left the whole module a
// second public door onto endpoints this service already owns. Where each of
// its jobs lives now:
//   · syncContactToGHL (class copy)      → syncContactToGHL below — the copy
//     lib/crm/sync.ts and app/actions/communications.ts always called;
//   · syncContactFromGHL (inbound REFUSAL stub) → the ruling "GHL is sync-out
//     only" is enforced where inbound arrives: the gohighlevel webhook's
//     verified no-op ack, with sanctioned inbound import living in
//     lib/crm/import-pull.ts;
//   · logComplianceNote                  → addGHLContactNote below;
//   · handleIncomingMessage (no-op ack)  → inline in the gohighlevel route;
//   · syncMessageToGHL / sendComplianceApprovedEmail — CALLER-LESS copies of
//     the `/conversations/messages` POST; outbound messages ride the
//     approval-rail/outbound-sender lanes, and CRM egress goes through
//     lib/crm/sync.ts:syncContactToCRM. Not ported: a second unwired door is
//     the defect, not a capability.

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

// ─── REMOVED in the orphan burn-down (lane O) ───────────────────────────────
//
// `getGHLContact(contactId)` and `searchGHLContacts(query)` — DELETED.
// SURVIVOR: lib/crm/import-pull.ts:142 `pullGoHighLevel` (dispatched through
// `pullCrmPage`, lib/crm/import-pull.ts:159, called by
// app/actions/lead-import/crm-pull-actions.ts and surfaced on the superadmin
// tenant CRM-pull panel).
//
// These two WERE the "GHL read side is a backlog to finish" note recorded in
// this guard's own header (scripts/orphan-export-guard.ts, the SCANNED_ROOTS
// comment). That backlog HAS since been finished — but by import-pull.ts, not
// here, and the note was never retired. `pullGoHighLevel` is the more complete
// read on every axis that matters: it takes the TENANT's own apiKey +
// locationId (resolved from platform_credentials) instead of reading only the
// platform-wide `GHL_API_KEY`/`GHL_LOCATION_ID` env pair, it paginates with a
// resumable cursor instead of returning one un-paged page, and its rows land
// through the ONE gated import pipeline (processImportRows → field steward →
// captureContact) rather than being handed to a caller raw.
//
// Nothing needed merging: neither deleted function did anything
// `pullGoHighLevel` does not do better, and keeping an env-credentialed,
// ungated second read path is how a tenant ends up reading the platform's GHL
// book instead of its own.

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

// ─── MERGED in the orphan burn-down (lane O) ────────────────────────────────
//
// `getGHLConversations(params)` and `getGHLMessages(conversationId, limit)` —
// MERGED-THEN-DELETED as exports.
// SURVIVOR: `getContactConversationHistory` immediately below (this file), the
// one GHL conversation read with a live caller —
// app/actions/communications.ts:236 `getContactHistory`.
//
// The survivor already did both jobs, inline and verbatim: the same
// `/conversations/?locationId=…&contactId=…` fetch and the same
// `/conversations/{id}/messages?limit=…` fetch, hand-written a second time.
// Rather than delete two working fetchers and leave the duplicate copies
// embedded in the survivor, the fetchers ARE now the survivor's body — kept as
// module-private helpers, so the capability survives and stops being a second
// public door onto the same endpoints.
//
// What was merged ONTO them from the survivor's inline copies: nothing was
// lost, and their `{ success, error }` wrappers were dropped in favour of
// throwing, because the survivor's own try/catch is what turns a GHL failure
// into `{ success: false, error }` for its caller. A helper that swallowed the
// error would have handed the caller an empty history that read as success.

// TOMBSTONE (§1, lane E2 2026-08-28) — `getContactConversationHistory` and its
// module-private fetchers (`fetchGHLConversations`, `fetchGHLMessages`)
// deleted. The lane-O merge above kept this chain alive for exactly one
// caller, app/actions/communications.ts:getContactHistory — which a
// stripped-source census then found to have zero callers of its own outside
// the importer-less the actions barrel (app/actions/index, deleted this wave) barrel, so the whole chain was
// unreachable. Contact message history is served locally — SURVIVORS:
// app/actions/contact-details.ts:getContactActivity and
// app/actions/communications.ts:getRecentCommunications. GHL remains a
// one-way contact-data sync target (syncContactToGHL below); it is not a
// message-history source in this product.

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

// ─── REMOVED in the orphan burn-down (lane O) ───────────────────────────────
//
// `addGHLContactTags(contactId, tags)` and
// `removeGHLContactTags(contactId, tags)` — DELETED.
// SURVIVOR: lib/crm/sync.ts:43 `syncContactToCRM`, which passes `tags` on every
// push and reaches GHL through `syncContactToGHL` above — whose update branch
// PUTs the whole contact (`{ ...contact, locationId }`), so the tag ARRAY is
// authored wholesale on each sync. The OS derives that array from the contact
// itself (app/actions/contacts.ts:231 — `[contact_type, status]`), so there is
// no OS-side incremental "tag added" event for these two to have been wired to:
// a tag change in the OS is a contact change, and a contact change already
// re-authors the GHL tag set.
//
// Nothing needed merging. Deleting them also closes a bypass: both called
// `ghlFetch` with no credential override, i.e. the platform-wide env key rather
// than the tenant's own resolved credential, and skipped the egress gate
// (`validateEgress` / CRM_CONTACT_EGRESS_CONTRACT) that lib/crm/sync.ts:51
// applies to every outbound contact. lib/crm/sync.ts:7 states the rule they
// broke: never call goHighLevelService directly from feature code.

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

// ─── REMOVED in the orphan burn-down (lane O) ───────────────────────────────
//
// `getGHLContactNotes(contactId)` — DELETED.
// SURVIVOR: the `contact_notes` table is the OS's store of record for notes —
// app/actions/contacts.ts:374 is the canonical writer (its own header says so)
// and app/crm/page.tsx:605 reads it for the contact timeline
// (app/actions/crm.ts:221 reads it too).
//
// `addGHLContactNote` above stays because it MIRRORS an OS note outward
// (app/actions/communications.ts:358 writes locally and mirrors). Reading notes
// back the other way would make GHL an authority over a table the OS owns, and
// no surface asked for it. Nothing needed merging — the read that exists reads
// the store of record.

// =====================================================
// BULK SYNC UTILITY
// =====================================================

// ─── REMOVED in the orphan burn-down (lane O) ───────────────────────────────
//
// `bulkSyncContactsToGHL(contacts)` — DELETED.
// SURVIVOR: lib/crm/sync.ts:43 `syncContactToCRM` — the single sanctioned
// sync-out lane, already called per contact by app/actions/contacts.ts:226,
// app/actions/lead-lifecycle.ts:205 and app/actions/crm-connect.ts:146.
//
// Nothing needed merging: the deleted function's entire body was a for-loop
// with a success/failed tally, and looping is the caller's job — the three live
// callers each loop over their own scope with their own tenant context.
//
// It was deleted rather than wired because it was a THREE-WAY BYPASS of that
// lane, and every bypass was silent. It called `syncContactToGHL` with no
// credential override, so a bulk run pushed a tenant's whole book through the
// PLATFORM's `GHL_API_KEY`/`GHL_LOCATION_ID` — into the wrong GHL location. It
// skipped the provider cascade in lib/crm/sync.ts:67, so a brokerage that had
// connected Follow Up Boss, Lofty or HubSpot would still have had its contacts
// shipped to GoHighLevel. And it skipped the egress gate at lib/crm/sync.ts:51,
// so nameless/unreachable rows went out unrefused and unledgered. Doing that
// once, in bulk, is the worst possible scale for all three faults.

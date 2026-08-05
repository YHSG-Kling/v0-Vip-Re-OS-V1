"use server"

// =====================================================
// UNIFIED COMMUNICATIONS SERVICE
// =====================================================
// SMS and Email route through the kernel dispatch layer.
// Provider resolution cascade: user → team → brokerage → superadmin → system default.
// GHL-specific functions (logCall, notes, workflows, social, calendar) remain
// wired directly since they are GHL-only features with no provider alternative.

import {
  logGHLCall,
  syncContactToGHL,
  getContactConversationHistory,
  addGHLContactNote,
} from "@/services/goHighLevelService"
import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity"
import { dispatchSms, dispatchEmail } from "@/lib/providers/dispatch"
// Imported directly, NOT through an `as any` cast. The cast that used to sit here hid
// five members this file calls that did not exist on the service at all — tsc could not
// see a single one, and each call was a runtime TypeError.
import { supabaseService } from "@/services/supabaseService"
import { checkSuppression } from "@/lib/kernel/compliance/check-suppression"

// =====================================================
// SEND SMS (via kernel dispatch — Twilio or GHL based on provider resolution)
// =====================================================

export async function sendSMS(params: {
  contactId: string
  message: string
  templateId?: string
  trackingData?: Record<string, any>
}) {
  const supabase = await createClient()

  // Look up contact for phone number and brokerage context
  const { data: contact } = await supabase
    .from("contacts")
    .select("first_name, last_name, phone, email, contact_type, status, source, brokerage_id, agent_id")
    .eq("id", params.contactId)
    .single()

  if (!contact) {
    return { success: false, error: "Contact not found" }
  }

  if (!contact.phone) {
    return { success: false, error: "Contact has no phone number" }
  }

  // Suppression check — hard stop before dispatch
  const suppression = await checkSuppression({
    brokerageId: contact.brokerage_id,
    contactId: params.contactId,
    channel: "sms",
    phone: contact.phone,
  })
  if (suppression.suppressed) {
    return { success: false, error: `SMS suppressed: ${suppression.reason}`, suppressed: true }
  }

  const result = await dispatchSms({
    to: contact.phone,
    message: params.message,
    brokerageId: contact.brokerage_id,
    agentId: contact.agent_id ?? undefined,
    systemSource: "communications",
    // contactId, NOT leadId. This read the recipient out of `contacts` above and
    // then handed that contacts.id to the leadId slot. dispatchSms picks its
    // lookup table with `params.contactId ? "contacts" : "leads"`, so it went
    // looking for a contacts.id in `leads`, found nothing, and the guard
    // `if (!recipientError && recipient)` fell through — which SKIPPED
    // evaluateOutboundCompliance entirely. Express consent, quiet hours and the
    // fair-housing content check never ran on anything sent through here.
    // (checkSuppression still ran, so DNC/opt-out by phone was never the hole.)
    contactId: params.contactId,
    metadata: params.trackingData,
  })

  // Log to activities for local tracking
  if (result.success) {
    await supabase.from("activities").insert({
      brokerage_id: contact.brokerage_id,
      agent_id: contact.agent_id,
      contact_id: params.contactId,
      activity_type: "sms_sent",
      title: `SMS sent to contact`,
      description: `SMS sent: ${params.message.substring(0, 100)}`,
      notes: JSON.stringify({ message_id: result.messageId, provider: result.providerKey }),
      status: "completed",
      entity_type: "contact",
    })
  }

  return { ...result, providerKey: result.providerKey }
}

// =====================================================
// SEND EMAIL (via kernel dispatch — SendGrid or GHL based on provider resolution)
// =====================================================

export async function sendEmail(params: {
  contactId: string
  subject: string
  html: string
  text?: string
  from?: string
  templateId?: string
  attachments?: Array<{ url: string; filename: string }>
  /** Controls unsubscribe block in assembled email. Default: 'conversation' */
  channelPurpose?: 'conversation' | 'campaign' | 'update' | 'transactional'
}) {
  const supabase = await createClient()

  const { data: contact } = await supabase
    .from("contacts")
    .select("first_name, last_name, email, brokerage_id, agent_id")
    .eq("id", params.contactId)
    .single()

  if (!contact) {
    return { success: false, error: "Contact not found" }
  }

  if (!contact.email) {
    return { success: false, error: "Contact has no email address" }
  }

  // Suppression check — hard stop before dispatch
  const suppression = await checkSuppression({
    brokerageId: contact.brokerage_id,
    contactId: params.contactId,
    channel: "email",
    email: contact.email,
  })
  if (suppression.suppressed) {
    return { success: false, error: `Email suppressed: ${suppression.reason}`, suppressed: true }
  }

  // Kernel OS email assembly runs inside dispatchEmail() via assembleEmail().
  // Pass raw body HTML — do NOT call assembleEmail() here; that would double-assemble.
  const result = await dispatchEmail({
    to: contact.email,
    from: params.from ?? "",
    subject: params.subject,
    html: params.html,
    text: params.text,
    channelPurpose: params.channelPurpose ?? "conversation",
    brokerageId: contact.brokerage_id,
    agentId: contact.agent_id ?? undefined,
    systemSource: "communications",
    // contactId, NOT leadId — same defect as sendSMS above; see the note there.
    contactId: params.contactId,
  })

  if (result.success) {
    await supabase.from("activities").insert({
      brokerage_id: contact.brokerage_id,
      agent_id: contact.agent_id,
      contact_id: params.contactId,
      activity_type: "email_sent",
      title: `Email sent: ${params.subject}`,
      description: `Email sent: ${params.subject}`,
      notes: JSON.stringify({ message_id: result.messageId, provider: result.providerKey }),
      status: "completed",
      entity_type: "contact",
    })
  }

  return { ...result, providerKey: result.providerKey }
}

// =====================================================
// LOG CALL (via GHL)
// =====================================================

export async function logCall(params: {
  contactId: string
  direction: "inbound" | "outbound"
  duration?: number
  recordingUrl?: string
  notes?: string
  outcome?: "answered" | "voicemail" | "no_answer" | "busy"
}) {
  const contact = await supabaseService.getContactById(params.contactId)

  if (!contact) {
    return { success: false, error: "Contact not found" }
  }

  // Sync to GHL
  const ghlSync = await syncContactToGHL({
    firstName: contact.first_name,
    lastName: contact.last_name,
    email: contact.email || undefined,
    phone: contact.phone || undefined,
  })

  const ghlContactId = ghlSync.contactId || params.contactId

  // Log call to GHL
  const result = await logGHLCall({
    contactId: ghlContactId,
    direction: params.direction,
    duration: params.duration,
    recordingUrl: params.recordingUrl,
    notes: params.notes,
    outcome: params.outcome,
  })

  // Log locally
  if (result.success) {
    await supabaseService.logActivity({
      contact_id: params.contactId,
      activity_type: `call_${params.direction}`,
      description: `${params.direction} call - ${params.outcome || "answered"}${params.duration ? ` (${Math.floor(params.duration / 60)}m ${params.duration % 60}s)` : ""}`,
      metadata: {
        ghl_call_id: result.callId,
        ghl_contact_id: ghlContactId,
        duration: params.duration,
        outcome: params.outcome,
        recording_url: params.recordingUrl,
      },
    })
  }

  return result
}

// =====================================================
// GET CONTACT HISTORY (from GHL)
// =====================================================

export async function getContactHistory(contactId: string) {
  // Try to get from GHL first
  const ghlHistory = await getContactConversationHistory(contactId)

  // Also get local activity log
  const localActivities = await supabaseService.getContactActivities(contactId)

  return {
    success: true,
    ghlHistory: ghlHistory.history,
    localActivities,
    mock: ghlHistory.mock,
  }
}

export async function getCommunicationStats(params?: { agentId?: string; startDate?: string; endDate?: string }) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return { success: false, error: "Unauthorized" }
    const { data: u } = await supabase
      .from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
    if (!u?.brokerage_id) return { success: false, error: "Unauthorized" }

    // Always scope to caller's brokerage; agentId narrows within it.
    let query = supabase
      .from("messages")
      .select("*")
      .eq("brokerage_id", u.brokerage_id)

    if (params?.agentId) query = query.eq("agent_id", params.agentId)
    if (params?.startDate) query = query.gte("created_at", params.startDate)
    if (params?.endDate) query = query.lte("created_at", params.endDate)

    const { data, error } = await query

    if (error) throw error

    // Calculate stats
    const stats = {
      total: data?.length || 0,
      sms: data?.filter((c: any) => c.type === "sms").length || 0,
      email: data?.filter((c: any) => c.type === "email").length || 0,
      call: data?.filter((c: any) => c.type === "call").length || 0,
      byDay: data?.reduce((acc: any, c: any) => {
        const day = new Date(c.created_at).toISOString().split('T')[0]
        acc[day] = (acc[day] || 0) + 1
        return acc
      }, {})
    }

    return { success: true, stats }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

export async function getRecentCommunications(contactId: string, limit = 20) {
  try {
    const supabase = await createClient()

    const { data, error } = await supabase
      .from("messages")
      .select("*")
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(limit)

    if (error) throw error

    return { success: true, communications: data || [] }
  } catch (error: any) {
    return { success: false, error: error.message, communications: [] }
  }
}

// =====================================================
// ADD NOTE (synced to GHL)
// =====================================================

export async function addContactNote(params: {
  contactId: string
  note: string
  category?: string
}) {
  const contact = await supabaseService.getContactById(params.contactId)

  if (!contact) {
    return { success: false, error: "Contact not found" }
  }

  // Sync to GHL
  const ghlSync = await syncContactToGHL({
    firstName: contact.first_name,
    lastName: contact.last_name,
    email: contact.email || undefined,
    phone: contact.phone || undefined,
  })

  const ghlContactId = ghlSync.contactId || params.contactId

  // Add note to GHL
  const ghlResult = await addGHLContactNote(ghlContactId, params.note)

  // Also save locally. `category` and `ghl_note_id` are dropped here rather than passed:
  // contact_notes has no column for either, so they were never going to persist. The
  // external note id still comes back to the caller below.
  const localResult = await supabaseService.addContactNote({
    contact_id: params.contactId,
    note: params.note,
  })

  if (!localResult) {
    return { success: false, error: "Note synced externally but could not be saved locally" }
  }

  return {
    success: true,
    noteId: localResult.id,
    ghlNoteId: ghlResult.noteId,
  }
}

// =====================================================
// SOCIAL MEDIA POSTING (via GHL)
// =====================================================

// =====================================================
// SCHEDULE APPOINTMENT (via GHL Calendar)
// =====================================================

// =====================================================
// TRIGGER GHL AUTOMATION
// =====================================================

// =====================================================
// SEND NOTIFICATION TO AGENT (Push/SMS/Email)
// =====================================================

export async function sendNotificationToAgent(
  userId: string,
  notification: {
    title: string
    message: string
    priority?: "low" | "medium" | "high"
    actionUrl?: string
  },
) {
  // Get user details
  const user = await supabaseService.getUserById(userId)

  if (!user) {
    console.error(`[v0] User not found: ${userId}`)
    return { success: false, error: "User not found" }
  }

  // Write in-app notification to notifications table
  const notifRecord = await supabaseService.createNotification({
    user_id: userId,
    type: "agent_notification",
    title: notification.title,
    body: notification.message,
    priority: notification.priority || "medium",
    channel: "in_app",
  })

  // Log to activity table
  await supabaseService.logActivity({
    user_id: userId,
    activity_type: "notification_sent",
    description: `${notification.priority?.toUpperCase() || "MEDIUM"}: ${notification.title}`,
    metadata: {
      title: notification.title,
      message: notification.message,
      priority: notification.priority || "medium",
      action_url: notification.actionUrl,
    },
  })

  return {
    success: true,
    notificationId: notifRecord?.id ?? `notif_${Date.now()}`,
  }
}

// =====================================================
// BROKER → THEIR-AGENTS BROADCAST (in-app announcement)
// =====================================================
// The tenant-level sibling of the platform-staff announcement lane
// (app/actions/superadmin/platform-announcements.ts): the tenancy PRINCIPAL
// (broker/admin always; the solo agent on solo tier; the team lead on team
// tier — lib/kernel/tenancy-principal.ts) composes one internal announcement
// and it fans out as ONE notifications row per recipient in the in-app rail.
//
// IN-APP ONLY by design: this writes notifications rows (channel "in_app") and
// never touches email/SMS/voice, so NO egress gates (suppression / DNC /
// provider dispatch) apply — nothing here leaves the platform.
//
// Scoping: broker/admin may address the whole brokerage or one team; a team
// lead (principal on the team tier without a broker/admin seat) is ALWAYS
// forced to their own team — they govern their team, not the brokerage.
// Ledgered in lifecycle_events (event_type "team_announcement_posted") so the
// act is auditable; counters are honest (rows actually written, or zero).

/** notifications.type for tenant-internal team announcements. */
const TEAM_ANNOUNCEMENT_TYPE = "team_announcement"

const BROADCAST_ADMIN_ROLES = new Set(["broker", "admin", "super_admin", "superadmin", "broker_owner", "broker_admin"])

/** Staff seats (users.user_type) included in a whole-brokerage announcement
 *  alongside every active agent. */
const BROKERAGE_STAFF_TYPES = ["broker", "admin", "tc", "coordinator"] as const

async function resolveAnnouncementRecipients(
  svc: any,
  params: { brokerageId: string; scope: "brokerage" | "team"; teamId: string | null },
): Promise<string[]> {
  const ids = new Set<string>()
  if (params.scope === "team" && params.teamId) {
    // Team scope: the team's ACTIVE agents + the team lead.
    const { data: teamAgents } = await svc
      .from("agents")
      .select("user_id")
      .eq("brokerage_id", params.brokerageId)
      .eq("team_id", params.teamId)
      .eq("is_active", true)
      .not("user_id", "is", null)
      .limit(500)
    for (const a of (teamAgents ?? []) as Array<{ user_id: string | null }>) {
      if (a.user_id) ids.add(a.user_id)
    }
    const { data: team } = await svc
      .from("teams")
      .select("team_lead_id")
      .eq("id", params.teamId)
      .eq("brokerage_id", params.brokerageId)
      .maybeSingle()
    if ((team as any)?.team_lead_id) ids.add((team as any).team_lead_id)
  } else {
    // Brokerage scope: every ACTIVE agent + broker/admin/TC staff seats.
    const [{ data: agents }, { data: staff }] = await Promise.all([
      svc
        .from("agents")
        .select("user_id")
        .eq("brokerage_id", params.brokerageId)
        .eq("is_active", true)
        .not("user_id", "is", null)
        .limit(1000),
      svc
        .from("users")
        .select("id")
        .eq("brokerage_id", params.brokerageId)
        .in("user_type", BROKERAGE_STAFF_TYPES as unknown as string[])
        .limit(500),
    ])
    for (const a of (agents ?? []) as Array<{ user_id: string | null }>) {
      if (a.user_id) ids.add(a.user_id)
    }
    for (const u of (staff ?? []) as Array<{ id: string }>) {
      if (u.id) ids.add(u.id)
    }
  }
  return Array.from(ids)
}

/**
 * notifyBrokerageAgentsAction — principal-gated fan-out of one internal
 * announcement to every active agent/staff user in the caller's brokerage
 * (or one team). In-app notifications rail only — never email/SMS.
 */
export async function notifyBrokerageAgentsAction(input: {
  subject: string
  body: string
  priority?: "low" | "medium" | "high"
  /** "brokerage" (default for broker/admin) or "team". A team-lead principal
   *  is always forced to their own team regardless of what is passed. */
  scope?: "brokerage" | "team"
  /** Team to address when a broker/admin picks team scope. Ignored for team
   *  leads (their own team is resolved server-side). */
  teamId?: string | null
},
/**
 * Sessionless-caller overload (voice webhook): the caller supplies its OWN
 * verified client + acting users.id, and the SAME principal guard below runs
 * against the DB through that client. The cookie path stays the default —
 * every existing caller is untouched. A browser cannot spoof this param:
 * server-action deserialization cannot produce a functioning Supabase client,
 * so a forged `caller` fails closed at the guard query.
 */
caller?: { client: { from: (t: string) => any }; actorUserId: string },
): Promise<{ ok: boolean; notified?: number; scope?: "brokerage" | "team"; error?: string }> {
  let ctx: { userId: string; brokerageId: string; role: string }
  if (caller) {
    if (typeof caller.client?.from !== "function" || typeof caller.actorUserId !== "string" || !caller.actorUserId) {
      return { ok: false, error: "Not authenticated" }
    }
    const { data: userRow } = await caller.client
      .from("users")
      .select("brokerage_id, user_type")
      .eq("id", caller.actorUserId)
      .maybeSingle()
    const row = userRow as { brokerage_id?: string | null; user_type?: string | null } | null
    if (!row?.brokerage_id) return { ok: false, error: "Not authenticated" }
    ctx = { userId: caller.actorUserId, brokerageId: row.brokerage_id, role: String(row.user_type ?? "agent") }
  } else {
    const sessionCtx = await getAgentContext()
    if (!sessionCtx.isAuthenticated || !sessionCtx.brokerageId) return { ok: false, error: "Not authenticated" }
    ctx = { userId: sessionCtx.userId, brokerageId: sessionCtx.brokerageId, role: sessionCtx.role }
  }

  const { createServiceClient } = await import("@/lib/supabase/service")
  const { isTenancyPrincipal } = await import("@/lib/kernel/tenancy-principal")
  const svc = createServiceClient()

  const principal = await isTenancyPrincipal(svc, {
    userId: ctx.userId,
    brokerageId: ctx.brokerageId,
    role: ctx.role,
  })
  if (!principal) return { ok: false, error: "Forbidden — only the tenancy principal can announce to the team" }

  const subject = (input.subject ?? "").trim()
  const body = (input.body ?? "").trim()
  if (!subject) return { ok: false, error: "A subject is required" }
  if (!body) return { ok: false, error: "A message is required" }
  const priority = input.priority === "high" || input.priority === "low" ? input.priority : "medium"

  // ── Resolve effective scope ──
  const isBrokerAdmin = BROADCAST_ADMIN_ROLES.has(ctx.role)
  let scope: "brokerage" | "team" = input.scope === "team" ? "team" : "brokerage"
  let teamId: string | null = input.teamId ?? null
  if (!isBrokerAdmin) {
    // Non-broker principal: on the team tier this is the team lead — force
    // their own team. (A solo-tier principal has no team; brokerage scope of a
    // solo tenancy IS just their own shop.)
    const { data: ledTeam } = await svc
      .from("teams")
      .select("id")
      .eq("brokerage_id", ctx.brokerageId)
      .eq("team_lead_id", ctx.userId)
      .is("deleted_at", null)
      .limit(1)
      .maybeSingle()
    if ((ledTeam as any)?.id) {
      scope = "team"
      teamId = (ledTeam as any).id
    } else {
      scope = "brokerage"
      teamId = null
    }
  } else if (scope === "team" && !teamId) {
    return { ok: false, error: "Pick a team for a team-scoped announcement" }
  }

  // ── Author attribution (mirrors the platform-announcement idiom) ──
  const { data: me } = await svc.from("users").select("email, first_name, last_name").eq("id", ctx.userId).maybeSingle()
  const author =
    [(me as any)?.first_name, (me as any)?.last_name].filter(Boolean).join(" ") || (me as any)?.email || "Your broker"

  // ── Fan out: one notifications row per recipient ──
  const recipientIds = await resolveAnnouncementRecipients(svc, { brokerageId: ctx.brokerageId, scope, teamId })
  if (recipientIds.length === 0) {
    return { ok: false, error: "No active agents or staff resolved for this scope — nothing was sent" }
  }

  const rows = recipientIds.map((userId) => ({
    user_id: userId,
    brokerage_id: ctx.brokerageId,
    type: TEAM_ANNOUNCEMENT_TYPE,
    title: subject.slice(0, 200),
    body: `${body}\n— ${author}`.slice(0, 480),
    priority,
    channel: "in_app",
    is_read: false,
  }))
  const { error: insertError } = await svc.from("notifications").insert(rows)
  if (insertError) {
    console.error("[notifyBrokerageAgents] fan-out insert failed:", insertError.message)
    return { ok: false, error: "Announcement was not delivered — the notification write failed" }
  }

  // ── Ledger the act (audit + dedupe marker) — best-effort, never blocks ──
  await svc
    .from("lifecycle_events")
    .insert({
      brokerage_id: ctx.brokerageId,
      entity_type: scope === "team" ? "team" : "brokerage",
      entity_id: scope === "team" ? teamId : ctx.brokerageId,
      event_type: "team_announcement_posted",
      actor_user_id: ctx.userId,
      metadata: { subject, priority, scope, team_id: teamId, notified: recipientIds.length },
    })
    .then(() => {}, (e: unknown) => console.error("[notifyBrokerageAgents] ledger failed:", e))

  return { ok: true, notified: recipientIds.length, scope }
}

/**
 * draftTeamAnnouncementAction — optional AI polish for the composer. Drafts
 * the announcement in the tenant's brand voice (lib/ai-isa/brand-voice-prompt
 * resolves the tone) via the generatePersonaCopy seam; the caller's own raw
 * subject/body is the deterministic FALLBACK FLOOR — the composer always gets
 * real copy back even when the gateway is down.
 */
export async function draftTeamAnnouncementAction(input: {
  subject: string
  body: string
}): Promise<{ ok: boolean; subject?: string; body?: string; error?: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { ok: false, error: "Not authenticated" }

  const { createServiceClient } = await import("@/lib/supabase/service")
  const { isTenancyPrincipal } = await import("@/lib/kernel/tenancy-principal")
  const svc = createServiceClient()
  const principal = await isTenancyPrincipal(svc, { userId: ctx.userId, brokerageId: ctx.brokerageId, role: ctx.role })
  if (!principal) return { ok: false, error: "Forbidden" }

  const subject = (input.subject ?? "").trim()
  const body = (input.body ?? "").trim()
  if (!subject && !body) return { ok: false, error: "Give the draft something to work with" }

  // Tenant brand voice → tone hint; the raw input is the fallback floor.
  let tone: string | null = null
  try {
    const { loadBrandVoicePrompt } = await import("@/lib/ai-isa/brand-voice-prompt")
    const voice = await loadBrandVoicePrompt({ brokerageId: ctx.brokerageId })
    tone = voice.tone
  } catch {
    /* voice profile unavailable → neutral tone; the fallback still stands */
  }

  const fallback = { subject: subject || "Team announcement", body: body || subject }
  try {
    const { generatePersonaCopy, realCopyGenerator } = await import("@/lib/kernel/ai-copy")
    const drafted = await generatePersonaCopy(
      {
        goal: "a short INTERNAL team announcement from the broker to their own agents — clear, warm, action-first, no marketing fluff",
        facts: [subject ? `Topic: ${subject}` : null, body ? `Details: ${body}` : null].filter(Boolean) as string[],
        channel: "in_app",
        persona: { audience: "agent", tone: tone ?? undefined },
        words: 80,
      },
      fallback,
      { generator: realCopyGenerator },
    )
    return { ok: true, subject: drafted.subject?.trim() || fallback.subject, body: drafted.body?.trim() || fallback.body }
  } catch {
    // Gateway down → the principal's own words are the floor.
    return { ok: true, subject: fallback.subject, body: fallback.body }
  }
}

/** Teams the broker/admin composer can address (id + name). Principal-gated. */
export async function listAnnouncementTeamsAction(): Promise<{
  ok: boolean
  teams?: Array<{ id: string; name: string }>
  error?: string
}> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { ok: false, error: "Not authenticated" }
  if (!BROADCAST_ADMIN_ROLES.has(ctx.role)) return { ok: true, teams: [] }
  const { createServiceClient } = await import("@/lib/supabase/service")
  const svc = createServiceClient()
  const { data } = await svc
    .from("teams")
    .select("id, name")
    .eq("brokerage_id", ctx.brokerageId)
    .is("deleted_at", null)
    .order("name")
    .limit(100)
  return { ok: true, teams: ((data ?? []) as Array<{ id: string; name: string }>) }
}

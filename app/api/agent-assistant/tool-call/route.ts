/**
 * POST /api/agent-assistant/tool-call
 *
 * Webhook endpoint that ElevenLabs Conv AI calls when the assistant invokes
 * a tool. Each tool maps to a kernel-OS-validated CRM operation.
 *
 * Auth: ElevenLabs sends `x-elevenlabs-tool-secret` header (configured per
 *   tool when we provision the agent in lib/elevenlabs/conv-ai.ts).
 *   We validate it against AGENT_ASSISTANT_TOOL_SECRET on our side. Constant-
 *   time compare to avoid timing leaks.
 *
 * Attribution: ElevenLabs forwards the conversation_id with every call. We
 *   look it up against agent_assistant_sessions to find the user, brokerage,
 *   and agent. If it's the first call for this conversation, we stamp the
 *   conversation_id onto the session row that was created at /session time
 *   (matched by the user's most-recent open session).
 *
 * Audit: every call (success or failure) is logged to
 *   agent_assistant_tool_calls so brokers can audit "what did the AI do?".
 *
 * Tools (v1):
 *   - lookup_contact(query)
 *   - get_today_schedule()
 *   - get_contact_details(contact_id)
 *   - log_activity(contact_id, activity_type, notes)
 *   - create_task(title, due_date?, contact_id?)
 *   - send_portal_message(contact_id, body) — kernel-validated
 */

import "server-only"
import { type NextRequest, NextResponse } from "next/server"
import { timingSafeEqual } from "node:crypto"
import { createServiceClient } from "@/lib/supabase/service"

export const runtime = "nodejs"

interface ToolCallBody {
  conversation_id?: string
  tool_name?: string
  parameters?: Record<string, unknown>
  // ElevenLabs sometimes wraps the tool name in different fields depending
  // on the exact tool config — accept variants.
  tool?: string
  args?: Record<string, unknown>
}

type SessionRow = {
  id: string
  brokerage_id: string
  agent_id: string | null
  user_id: string
  conversation_id: string | null
  tool_call_count: number | null
}

export async function POST(request: NextRequest) {
  const start = Date.now()

  // ── Auth ───────────────────────────────────────────────────────────────
  const expected = process.env.AGENT_ASSISTANT_TOOL_SECRET ?? ""
  const provided = request.headers.get("x-elevenlabs-tool-secret") ?? ""
  if (!expected || !secretMatches(expected, provided)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  // ── Parse body ─────────────────────────────────────────────────────────
  const body = (await request.json().catch(() => null)) as ToolCallBody | null
  if (!body) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 })
  }
  const toolName = body.tool_name ?? body.tool
  const params = body.parameters ?? body.args ?? {}
  const conversationId = body.conversation_id ?? null

  if (!toolName) {
    return NextResponse.json({ error: "tool_name required" }, { status: 400 })
  }

  const supabase = createServiceClient()

  // ── Resolve session ────────────────────────────────────────────────────
  // The /session route created a row but didn't yet know the conversation_id.
  // First tool call: match by (user pending session) → stamp conv_id.
  // Subsequent calls: match by conversation_id directly.
  let session: SessionRow | null = null
  if (conversationId) {
    const { data } = await supabase
      .from("agent_assistant_sessions")
      .select("id, brokerage_id, agent_id, user_id, conversation_id, tool_call_count")
      .eq("conversation_id", conversationId)
      .is("ended_at", null)
      .maybeSingle()
    session = (data as SessionRow | null) ?? null
  }

  if (!session && conversationId) {
    // First call: pick the most-recent unattributed open session whose user
    // is the most likely owner. ElevenLabs doesn't pass our session id, so we
    // attribute by recency (sessions are created seconds before the first
    // tool call). This is best-effort — a defensive secondary match would
    // tie the conversation to the user via cookie/jwt if we had one, but the
    // webhook is unauthenticated by design.
    const { data: pending } = await supabase
      .from("agent_assistant_sessions")
      .select("id, brokerage_id, agent_id, user_id, conversation_id, tool_call_count")
      .is("conversation_id", null)
      .is("ended_at", null)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    if (pending) {
      await supabase
        .from("agent_assistant_sessions")
        .update({ conversation_id: conversationId })
        .eq("id", pending.id)
      session = pending as SessionRow
    }
  }

  if (!session) {
    return jsonToolError("Session not found — try ending and re-opening the assistant.")
  }

  // ── Dispatch ───────────────────────────────────────────────────────────
  let result: any
  let success = true
  let errorMessage: string | null = null
  try {
    result = await runTool(toolName, params, session, supabase)
  } catch (e: any) {
    success = false
    errorMessage = e?.message ?? "Tool failed"
    result = { error: errorMessage }
  }

  const latencyMs = Date.now() - start

  // ── Audit log + counter ────────────────────────────────────────────────
  await Promise.all([
    supabase.from("agent_assistant_tool_calls").insert({
      session_id: session.id,
      tool_name: toolName,
      tool_input: params,
      tool_output: typeof result === "object" ? result : { value: result },
      success,
      error_message: errorMessage,
      latency_ms: latencyMs,
    }),
    supabase
      .from("agent_assistant_sessions")
      .update({ tool_call_count: (session.tool_call_count ?? 0) + 1 })
      .eq("id", session.id),
  ])

  // ElevenLabs accepts string or object as the tool response; we return the
  // tool's structured result so the LLM can quote details verbatim.
  return NextResponse.json({ result })
}

// ─── Tool implementations ────────────────────────────────────────────────────

async function runTool(
  toolName: string,
  params: Record<string, unknown>,
  session: SessionRow,
  supabase: ReturnType<typeof createServiceClient>,
): Promise<any> {
  switch (toolName) {
    case "lookup_contact":
      return lookupContact(String(params.query ?? "").trim(), session, supabase)

    case "get_today_schedule":
      return getTodaySchedule(session, supabase)

    case "get_contact_details":
      return getContactDetails(String(params.contact_id ?? ""), session, supabase)

    case "log_activity":
      return logActivity(
        String(params.contact_id ?? ""),
        String(params.activity_type ?? "note"),
        String(params.notes ?? ""),
        session,
        supabase,
      )

    case "create_task":
      return createTask(
        String(params.title ?? ""),
        params.due_date ? String(params.due_date) : null,
        params.contact_id ? String(params.contact_id) : null,
        session,
        supabase,
      )

    case "send_portal_message":
      return sendPortalMessage(
        String(params.contact_id ?? ""),
        String(params.body ?? ""),
        session,
        supabase,
      )

    case "get_active_listings":
      return getActiveListings(session, supabase)

    case "get_pending_offers":
      return getPendingOffers(session, supabase)

    case "get_transactions_in_progress":
      return getTransactionsInProgress(session, supabase)

    case "get_recent_messages":
      return getRecentMessages(
        params.contact_id ? String(params.contact_id) : null,
        session,
        supabase,
      )

    case "update_contact_status":
      return updateContactStatus(
        String(params.contact_id ?? ""),
        String(params.status ?? ""),
        session,
        supabase,
      )

    case "stage_listing_packet":
      return stageListingPacket(params, session)

    case "stage_offer_packet":
      return stageOfferPacket(params, session, supabase)

    default:
      throw new Error(`Unknown tool: ${toolName}`)
  }
}

// ─── stage_listing_packet (voice) ────────────────────────────────────────────

async function stageListingPacket(
  params: Record<string, unknown>,
  session: SessionRow,
) {
  const address = String(params.address ?? "").trim()
  if (!address) return { error: "address required" }

  const { stageWizardPacketAsAgent } = await import("@/app/actions/wizard-staging-voice")
  const result = await stageWizardPacketAsAgent({
    brokerageId: session.brokerage_id,
    userId: session.user_id,
    mode: "listing",
    intake: {
      address,
      city: params.city ? String(params.city) : undefined,
      state: params.state ? String(params.state) : undefined,
      zip: params.zip ? String(params.zip) : undefined,
      listPrice: params.list_price != null ? Number(params.list_price) : undefined,
      sellerName: params.seller_name ? String(params.seller_name) : undefined,
      propertyType: params.property_type ? String(params.property_type) : undefined,
      notes: params.notes ? String(params.notes) : undefined,
    },
  })
  if (!result.success) return { error: result.error ?? "Staging failed" }
  return {
    success: true,
    document_id: result.documentId,
    open_url: result.openUrl,
    spoken_summary: `I've prefilled a listing wizard for ${address}. The agent can open it from the listings page to review and submit.`,
  }
}

// ─── stage_offer_packet (voice) ──────────────────────────────────────────────

async function stageOfferPacket(
  params: Record<string, unknown>,
  session: SessionRow,
  supabase: ReturnType<typeof createServiceClient>,
) {
  const contactId = String(params.contact_id ?? "").trim()
  const address = String(params.address ?? "").trim()
  if (!contactId || !address) return { error: "contact_id and address required" }

  // Brokerage check
  const { data: contact } = await supabase
    .from("contacts")
    .select("id, first_name, last_name")
    .eq("id", contactId)
    .eq("brokerage_id", session.brokerage_id)
    .maybeSingle()
  if (!contact) return { error: "Contact not found in your brokerage" }

  const { stageWizardPacketAsAgent } = await import("@/app/actions/wizard-staging-voice")
  const result = await stageWizardPacketAsAgent({
    brokerageId: session.brokerage_id,
    userId: session.user_id,
    mode: "offer",
    intake: {
      contactId,
      address,
      city: params.city ? String(params.city) : undefined,
      state: params.state ? String(params.state) : undefined,
      zip: params.zip ? String(params.zip) : undefined,
      offerPrice: params.offer_price != null ? Number(params.offer_price) : undefined,
      financingType: params.financing_type ? String(params.financing_type) : undefined,
      earnestMoney: params.earnest_money != null ? Number(params.earnest_money) : undefined,
      closingDate: params.closing_date ? String(params.closing_date) : undefined,
      notes: params.notes ? String(params.notes) : undefined,
    },
  })
  if (!result.success) return { error: result.error ?? "Staging failed" }
  const contactName = `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim()
  return {
    success: true,
    document_id: result.documentId,
    open_url: result.openUrl,
    contact_name: contactName,
    spoken_summary: `I've prefilled an offer for ${contactName} on ${address}. The agent can open it to review and send for signature.`,
  }
}

// ─── lookup_contact ───────────────────────────────────────────────────────────

async function lookupContact(
  query: string,
  session: SessionRow,
  supabase: ReturnType<typeof createServiceClient>,
) {
  if (!query || query.length < 2) return { matches: [] }

  const phoneDigits = query.replace(/\D/g, "")
  const isPhone = phoneDigits.length >= 7

  let q = supabase
    .from("contacts")
    .select("id, first_name, last_name, email, phone, contact_type, last_contact_at")
    .eq("brokerage_id", session.brokerage_id)
    .limit(5)

  if (isPhone) {
    q = q.ilike("phone", `%${phoneDigits.slice(-7)}%`)
  } else if (query.includes("@")) {
    q = q.ilike("email", `%${query}%`)
  } else {
    // Name search across first + last
    q = q.or(`first_name.ilike.%${query}%,last_name.ilike.%${query}%`)
  }

  const { data } = await q
  return {
    matches: (data ?? []).map((c: any) => ({
      contact_id: c.id,
      name: `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || "(no name)",
      email: c.email,
      phone: c.phone,
      type: c.contact_type,
      last_contact: c.last_contact_at,
    })),
  }
}

// ─── get_today_schedule ───────────────────────────────────────────────────────

async function getTodaySchedule(
  session: SessionRow,
  supabase: ReturnType<typeof createServiceClient>,
) {
  if (!session.agent_id) return { appointments: [], message: "No agent profile for this session." }

  const startOfDay = new Date()
  startOfDay.setHours(0, 0, 0, 0)
  const endOfDay = new Date(startOfDay)
  endOfDay.setHours(23, 59, 59, 999)

  // Showings + activities scheduled today
  const [showings, activities] = await Promise.all([
    supabase
      .from("showings")
      .select("id, scheduled_at, listing_id, contact_id, notes")
      .eq("agent_id", session.agent_id)
      .gte("scheduled_at", startOfDay.toISOString())
      .lt("scheduled_at", endOfDay.toISOString())
      .order("scheduled_at", { ascending: true }),
    supabase
      .from("activities")
      .select("id, scheduled_at, activity_type, title, contact_id")
      .eq("agent_id", session.agent_id)
      .eq("status", "scheduled")
      .gte("scheduled_at", startOfDay.toISOString())
      .lt("scheduled_at", endOfDay.toISOString())
      .order("scheduled_at", { ascending: true }),
  ])

  const appointments = [
    ...(showings.data ?? []).map((s: any) => ({
      time: s.scheduled_at,
      type: "showing",
      title: s.notes ?? "Showing",
      listing_id: s.listing_id,
      contact_id: s.contact_id,
    })),
    ...(activities.data ?? []).map((a: any) => ({
      time: a.scheduled_at,
      type: a.activity_type,
      title: a.title,
      contact_id: a.contact_id,
    })),
  ].sort((a, b) => (a.time < b.time ? -1 : 1))

  return { appointments, count: appointments.length }
}

// ─── get_contact_details ──────────────────────────────────────────────────────

async function getContactDetails(
  contactId: string,
  session: SessionRow,
  supabase: ReturnType<typeof createServiceClient>,
) {
  if (!contactId) return { error: "contact_id required" }

  const { data: c } = await supabase
    .from("contacts")
    .select(
      "id, first_name, last_name, email, phone, contact_type, contact_persona, last_contact_at, engagement_score, do_not_contact, notes, status",
    )
    .eq("id", contactId)
    .eq("brokerage_id", session.brokerage_id)
    .maybeSingle()

  if (!c) return { error: "Contact not found in your brokerage" }

  const { data: recentActivities } = await supabase
    .from("activities")
    .select("activity_type, title, scheduled_at, status")
    .eq("contact_id", contactId)
    .order("scheduled_at", { ascending: false })
    .limit(5)

  return {
    contact_id: c.id,
    name: `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || "(no name)",
    email: c.email,
    phone: c.phone,
    type: c.contact_type,
    persona: c.contact_persona,
    status: c.status,
    do_not_contact: !!c.do_not_contact,
    engagement_score: c.engagement_score,
    last_contact: c.last_contact_at,
    notes: c.notes,
    recent_activities: recentActivities ?? [],
  }
}

// ─── log_activity ─────────────────────────────────────────────────────────────

async function logActivity(
  contactId: string,
  activityType: string,
  notes: string,
  session: SessionRow,
  supabase: ReturnType<typeof createServiceClient>,
) {
  if (!contactId || !notes) return { error: "contact_id + notes required" }

  // Verify contact belongs to this brokerage
  const { data: contact } = await supabase
    .from("contacts")
    .select("id")
    .eq("id", contactId)
    .eq("brokerage_id", session.brokerage_id)
    .maybeSingle()
  if (!contact) return { error: "Contact not found" }

  const { data, error } = await supabase
    .from("activities")
    .insert({
      brokerage_id: session.brokerage_id,
      agent_id: session.agent_id,
      contact_id: contactId,
      activity_type: activityType,
      title: notes.slice(0, 100),
      notes,
      status: "completed",
      completed_at: new Date().toISOString(),
    })
    .select("id")
    .maybeSingle()

  if (error || !data) return { error: error?.message ?? "Failed to log activity" }

  // Bump contacts.last_contact_at so the CRM reflects the touchpoint.
  await supabase
    .from("contacts")
    .update({ last_contact_at: new Date().toISOString() })
    .eq("id", contactId)

  return { success: true, activity_id: data.id }
}

// ─── create_task ──────────────────────────────────────────────────────────────

async function createTask(
  title: string,
  dueDate: string | null,
  contactId: string | null,
  session: SessionRow,
  supabase: ReturnType<typeof createServiceClient>,
) {
  if (!title) return { error: "title required" }

  const { data, error } = await supabase
    .from("tasks")
    .insert({
      brokerage_id: session.brokerage_id,
      assigned_to_agent_id: session.user_id,
      created_by_agent_id: session.user_id,
      title,
      priority: "normal",
      due_date: dueDate ?? undefined,
      contact_id: contactId ?? undefined,
      status: "pending",
    })
    .select("id, title, due_date")
    .maybeSingle()

  if (error || !data) return { error: error?.message ?? "Failed to create task" }
  return { success: true, task_id: data.id, title: data.title, due_date: data.due_date }
}

// ─── send_portal_message ──────────────────────────────────────────────────────

async function sendPortalMessage(
  contactId: string,
  bodyText: string,
  session: SessionRow,
  supabase: ReturnType<typeof createServiceClient>,
) {
  if (!contactId || !bodyText) return { error: "contact_id + body required" }

  const { data: contact } = await supabase
    .from("contacts")
    .select("id, agent_id, do_not_contact")
    .eq("id", contactId)
    .eq("brokerage_id", session.brokerage_id)
    .maybeSingle()

  if (!contact) return { error: "Contact not found" }
  if (contact.do_not_contact) {
    return { error: "Contact is on the Do Not Contact list — message blocked." }
  }

  const { data, error } = await supabase
    .from("client_portal_messages")
    .insert({
      contact_id: contactId,
      agent_id: contact.agent_id ?? session.agent_id,
      brokerage_id: session.brokerage_id,
      direction: "agent_to_client",
      channel: "portal",
      read: false,
      body: bodyText,
      read_at: null,
    })
    .select("id")
    .maybeSingle()

  if (error || !data) return { error: error?.message ?? "Failed to send message" }
  return { success: true, message_id: data.id, preview: bodyText.slice(0, 80) }
}

// ─── get_active_listings ──────────────────────────────────────────────────────

async function getActiveListings(
  session: SessionRow,
  supabase: ReturnType<typeof createServiceClient>,
) {
  if (!session.agent_id) return { listings: [] }
  const { data } = await supabase
    .from("listings")
    .select("id, address, city, state, list_price, bedrooms, bathrooms, sqft, status, lifecycle_stage")
    .eq("agent_id", session.agent_id)
    .in("status", ["active", "coming_soon"])
    .is("deleted_at", null)
    .order("listing_date", { ascending: false })
    .limit(10)
  return { listings: data ?? [], count: data?.length ?? 0 }
}

// ─── get_pending_offers ───────────────────────────────────────────────────────

async function getPendingOffers(
  session: SessionRow,
  supabase: ReturnType<typeof createServiceClient>,
) {
  if (!session.agent_id) return { offers: [] }
  const { data } = await supabase
    .from("offers")
    .select(
      "id, offer_number, offer_price, status, response_deadline, financing_type, contact_id, listing_id, property_address",
    )
    .eq("agent_id", session.agent_id)
    .in("status", ["pending", "countered", "submitted"])
    .order("submitted_at", { ascending: false })
    .limit(10)
  return { offers: data ?? [], count: data?.length ?? 0 }
}

// ─── get_transactions_in_progress ─────────────────────────────────────────────

async function getTransactionsInProgress(
  session: SessionRow,
  supabase: ReturnType<typeof createServiceClient>,
) {
  if (!session.agent_id) return { transactions: [] }
  const { data } = await supabase
    .from("transactions")
    .select("id, deal_name, status, stage, property_address, close_date, contact_id, purchase_price")
    .eq("agent_id", session.agent_id)
    .in("status", ["under_contract", "inspection", "appraisal", "financing", "closing_prep"])
    .is("deleted_at", null)
    .order("close_date", { ascending: true })
    .limit(10)
  return { transactions: data ?? [], count: data?.length ?? 0 }
}

// ─── get_recent_messages ──────────────────────────────────────────────────────

async function getRecentMessages(
  contactId: string | null,
  session: SessionRow,
  supabase: ReturnType<typeof createServiceClient>,
) {
  let q = supabase
    .from("client_portal_messages")
    .select("id, contact_id, direction, body, channel, read, created_at")
    .eq("brokerage_id", session.brokerage_id)
    .order("created_at", { ascending: false })
    .limit(10)
  if (contactId) q = q.eq("contact_id", contactId)
  if (session.agent_id) q = q.eq("agent_id", session.agent_id)
  const { data } = await q
  return {
    messages: (data ?? []).map((m: any) => ({
      contact_id: m.contact_id,
      from: m.direction === "agent_to_client" ? "you" : "client",
      preview: (m.body as string).slice(0, 120),
      channel: m.channel,
      read: m.read,
      ts: m.created_at,
    })),
  }
}

// ─── update_contact_status ────────────────────────────────────────────────────

async function updateContactStatus(
  contactId: string,
  status: string,
  session: SessionRow,
  supabase: ReturnType<typeof createServiceClient>,
) {
  if (!contactId || !status) return { error: "contact_id + status required" }

  const { data, error } = await supabase
    .from("contacts")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", contactId)
    .eq("brokerage_id", session.brokerage_id)
    .select("id, first_name, last_name, status")
    .maybeSingle()

  if (error || !data) return { error: error?.message ?? "Update failed — contact not in your brokerage" }
  return {
    success: true,
    contact_id: data.id,
    name: `${data.first_name ?? ""} ${data.last_name ?? ""}`.trim(),
    new_status: data.status,
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function jsonToolError(message: string) {
  return NextResponse.json({ result: { error: message } })
}

function secretMatches(expected: string, provided: string): boolean {
  // Constant-time comparison to thwart timing attacks. Fall back to a length
  // mismatch rejection if buffers differ.
  const a = Buffer.from(expected)
  const b = Buffer.from(provided)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

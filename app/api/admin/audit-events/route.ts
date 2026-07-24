"use server"

import { createClient } from "@/lib/supabase/server"
import { NextRequest, NextResponse } from "next/server"

// Role validation for admin routes
const ALLOWED_ROLES = ["broker", "admin", "superadmin", "compliance_officer"]

interface UnifiedAuditEvent {
  id: string
  timestamp: string
  entity_type: string
  entity_id: string | null
  event_type: string
  actor_name: string
  subject_name: string | null
  summary: string
  metadata_json: Record<string, unknown>
  source_table: string
}

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  
  // Auth check
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // Get user role
  const { data: userData } = await supabase
    .from("users")
    .select("user_type, platform_role, brokerage_id")
    .eq("id", user.id)
    .single()

  if (
    !userData ||
    (!ALLOWED_ROLES.includes(userData.user_type || "") && userData.platform_role !== "superadmin")
  ) {
    return NextResponse.redirect(new URL("/dashboard", request.url))
  }

  const brokerageId = userData.brokerage_id
  const searchParams = request.nextUrl.searchParams
  
  // Parse filters
  const entityType = searchParams.get("entity_type") || "all"
  const agentId = searchParams.get("agent_id")
  const dateRange = searchParams.get("date_range") || "last_7_days"
  const customStart = searchParams.get("start_date")
  const customEnd = searchParams.get("end_date")
  const category = searchParams.get("category") || "all"
  const search = searchParams.get("search") || ""
  const complianceOnly = searchParams.get("compliance_only") === "true"
  const format = searchParams.get("format")
  const page = parseInt(searchParams.get("page") || "1")
  const pageSize = 50

  // Calculate date range
  let startDate: Date
  let endDate = new Date()
  
  switch (dateRange) {
    case "today":
      startDate = new Date()
      startDate.setHours(0, 0, 0, 0)
      break
    case "last_7_days":
      startDate = new Date()
      startDate.setDate(startDate.getDate() - 7)
      break
    case "last_30_days":
      startDate = new Date()
      startDate.setDate(startDate.getDate() - 30)
      break
    case "custom":
      startDate = customStart ? new Date(customStart) : new Date()
      endDate = customEnd ? new Date(customEnd) : new Date()
      break
    default:
      startDate = new Date()
      startDate.setDate(startDate.getDate() - 7)
  }

  const events: UnifiedAuditEvent[] = []

  // Helper to get agent name
  const getAgentName = async (agentId: string | null): Promise<string> => {
    if (!agentId) return "System"
    const { data } = await supabase
      .from("agents")
      .select("id")
      .eq("id", agentId)
      .single()
    if (!data) return "Unknown Agent"
    // Get user info via agents.user_id
    const { data: agentData } = await supabase
      .from("agents")
      .select("user_id")
      .eq("id", agentId)
      .single()
    if (!agentData?.user_id) return "Unknown Agent"
    const { data: user } = await supabase
      .from("users")
      .select("first_name, last_name")
      .eq("id", agentData.user_id)
      .single()
    return user ? `${user.first_name || ""} ${user.last_name || ""}`.trim() || "Agent" : "Unknown Agent"
  }

  // Helper to get contact name
  const getContactName = async (contactId: string | null): Promise<string> => {
    if (!contactId) return ""
    const { data } = await supabase
      .from("contacts")
      .select("first_name, last_name")
      .eq("id", contactId)
      .single()
    return data ? `${data.first_name || ""} ${data.last_name || ""}`.trim() : "Unknown Contact"
  }

  // Cache for names to avoid duplicate queries
  const agentNameCache = new Map<string, string>()
  const contactNameCache = new Map<string, string>()

  const getCachedAgentName = async (id: string | null): Promise<string> => {
    if (!id) return "System"
    if (agentNameCache.has(id)) return agentNameCache.get(id)!
    const name = await getAgentName(id)
    agentNameCache.set(id, name)
    return name
  }

  const getCachedContactName = async (id: string | null): Promise<string> => {
    if (!id) return ""
    if (contactNameCache.has(id)) return contactNameCache.get(id)!
    const name = await getContactName(id)
    contactNameCache.set(id, name)
    return name
  }

  // 1. lifecycle_events
  if (entityType === "all" || entityType === "event") {
    let query = supabase
      .from("lifecycle_events")
      .select("id, entity_type, entity_id, event_type, actor_user_id, metadata, created_at")
      .eq("brokerage_id", brokerageId)
      .gte("created_at", startDate.toISOString())
      .lte("created_at", endDate.toISOString())
      .order("created_at", { ascending: false })
      .limit(500)

    const { data: lifecycleEvents } = await query

    if (lifecycleEvents) {
      for (const event of lifecycleEvents) {
        const actorName = event.actor_user_id 
          ? (await supabase.from("users").select("first_name, last_name").eq("id", event.actor_user_id).single()).data
          : null
        events.push({
          id: event.id,
          timestamp: event.created_at,
          entity_type: event.entity_type || "event",
          entity_id: event.entity_id,
          event_type: event.event_type || "lifecycle",
          actor_name: actorName ? `${actorName.first_name || ""} ${actorName.last_name || ""}`.trim() : "System",
          subject_name: null,
          summary: `${event.event_type}: ${event.entity_type}`,
          metadata_json: event.metadata || {},
          source_table: "lifecycle_events",
        })
      }
    }
  }

  // 2. client_portal_messages
  if (entityType === "all" || entityType === "message") {
    const { data: messages } = await supabase
      .from("client_portal_messages")
      .select("id, contact_id, agent_id, direction, body, created_at")
      .eq("brokerage_id", brokerageId)
      .gte("created_at", startDate.toISOString())
      .lte("created_at", endDate.toISOString())
      .order("created_at", { ascending: false })
      .limit(500)

    if (messages) {
      for (const msg of messages) {
        const actorName = await getCachedAgentName(msg.agent_id)
        const contactName = await getCachedContactName(msg.contact_id)
        events.push({
          id: msg.id,
          timestamp: msg.created_at,
          entity_type: "message",
          entity_id: msg.contact_id,
          event_type: "portal_message",
          actor_name: actorName,
          subject_name: contactName,
          summary: `[${msg.direction}] message re: ${contactName}`,
          metadata_json: { body_preview: msg.body?.substring(0, 100) },
          source_table: "client_portal_messages",
        })
      }
    }
  }

  // 3. transaction_documents (compliance sensitive)
  if (entityType === "all" || entityType === "document" || complianceOnly) {
    const { data: docs } = await supabase
      .from("transaction_documents")
      .select("id, transaction_id, doc_type, doc_label, uploaded_by, created_at")
      .eq("brokerage_id", brokerageId)
      .gte("created_at", startDate.toISOString())
      .lte("created_at", endDate.toISOString())
      .order("created_at", { ascending: false })
      .limit(500)

    if (docs) {
      for (const doc of docs) {
        const uploaderName = doc.uploaded_by 
          ? (await supabase.from("users").select("first_name, last_name").eq("id", doc.uploaded_by).single()).data
          : null
        events.push({
          id: doc.id,
          timestamp: doc.created_at,
          entity_type: "document",
          entity_id: doc.transaction_id,
          event_type: "document_upload",
          actor_name: uploaderName ? `${uploaderName.first_name || ""} ${uploaderName.last_name || ""}`.trim() : "System",
          subject_name: null,
          summary: `${doc.doc_label || doc.doc_type || "Document"} uploaded for transaction`,
          metadata_json: { doc_type: doc.doc_type, doc_label: doc.doc_label },
          source_table: "transaction_documents",
        })
      }
    }
  }

  // 4. commission_distributions (compliance sensitive)
  if (entityType === "all" || entityType === "commission" || complianceOnly) {
    const { data: distributions } = await supabase
      .from("commission_distributions")
      .select("id, transaction_id, recipient_id, distribution_type, calculated_amount, created_at")
      .eq("brokerage_id", brokerageId)
      .gte("created_at", startDate.toISOString())
      .lte("created_at", endDate.toISOString())
      .order("created_at", { ascending: false })
      .limit(500)

    if (distributions) {
      for (const dist of distributions) {
        events.push({
          id: dist.id,
          timestamp: dist.created_at,
          entity_type: "commission",
          entity_id: dist.transaction_id,
          event_type: "commission_distribution",
          actor_name: "System",
          subject_name: null,
          summary: `$${dist.calculated_amount?.toFixed(2) || "0"} distributed (${dist.distribution_type})`,
          metadata_json: { distribution_type: dist.distribution_type, amount: dist.calculated_amount },
          source_table: "commission_distributions",
        })
      }
    }
  }

  // 5. voice_calls (compliance sensitive) — the single voice ledger. The AI
  // voice lane records every call here (vapi_call_id holds the vendor CallSid);
  // the legacy vapi_voice_calls billing table was retired.
  if (entityType === "all" || entityType === "voice_call" || complianceOnly) {
    const { data: voiceCalls } = await supabase
      .from("voice_calls")
      .select("id, vapi_call_id, agent_id, contact_id, direction, status, created_at")
      .eq("brokerage_id", brokerageId)
      .gte("created_at", startDate.toISOString())
      .lte("created_at", endDate.toISOString())
      .order("created_at", { ascending: false })
      .limit(500)

    if (voiceCalls) {
      for (const call of voiceCalls) {
        const actorName = call.agent_id ? await getCachedAgentName(call.agent_id) : "System"
        const contactName = call.contact_id ? await getCachedContactName(call.contact_id) : ""

        events.push({
          id: call.id,
          timestamp: call.created_at,
          entity_type: "voice_call",
          entity_id: call.id,
          event_type: "voice_call",
          actor_name: actorName,
          subject_name: contactName,
          summary: `[${call.direction || "unknown"}] call with ${contactName || "unknown contact"}`,
          metadata_json: { vendor_call_id: call.vapi_call_id, status: call.status },
          source_table: "voice_calls",
        })
      }
    }
  }

  // 6. ai_isa_calls (compliance sensitive)
  if (entityType === "all" || entityType === "isa_call" || complianceOnly) {
    const { data: isaCalls } = await supabase
      .from("ai_isa_calls")
      .select("id, contact_id, appointment_set, lead_quality_score, created_at")
      .eq("brokerage_id", brokerageId)
      .gte("created_at", startDate.toISOString())
      .lte("created_at", endDate.toISOString())
      .order("created_at", { ascending: false })
      .limit(500)

    if (isaCalls) {
      for (const call of isaCalls) {
        const contactName = await getCachedContactName(call.contact_id)
        const outcome = call.appointment_set ? "appointment_set" : "no_appointment"
        events.push({
          id: call.id,
          timestamp: call.created_at,
          entity_type: "isa_call",
          entity_id: call.contact_id,
          event_type: "isa_call",
          actor_name: "AI ISA",
          subject_name: contactName,
          summary: `ISA call: ${outcome} (score: ${call.lead_quality_score || "N/A"})`,
          metadata_json: { appointment_set: call.appointment_set, lead_quality_score: call.lead_quality_score },
          source_table: "ai_isa_calls",
        })
      }
    }
  }

  // 7. agent_badges
  if (entityType === "all" || entityType === "badge") {
    const { data: badges } = await supabase
      .from("agent_badges")
      .select("id, agent_id, badge_id, awarded_at, awarded_reason")
      .gte("awarded_at", startDate.toISOString())
      .lte("awarded_at", endDate.toISOString())
      .order("awarded_at", { ascending: false })
      .limit(500)

    if (badges) {
      for (const badge of badges) {
        const agentName = await getCachedAgentName(badge.agent_id)
        // Get badge name
        const { data: badgeData } = await supabase
          .from("gamification_badges")
          .select("badge_name")
          .eq("id", badge.badge_id)
          .single()

        events.push({
          id: badge.id,
          timestamp: badge.awarded_at,
          entity_type: "badge",
          entity_id: badge.agent_id,
          event_type: "badge_awarded",
          actor_name: "System",
          subject_name: agentName,
          summary: `${badgeData?.badge_name || "Badge"} awarded to ${agentName}`,
          metadata_json: { badge_id: badge.badge_id, awarded_reason: badge.awarded_reason },
          source_table: "agent_badges",
        })
      }
    }
  }

  // 8. accounting_sync_log
  if (entityType === "all" || entityType === "accounting_sync") {
    const { data: syncs } = await supabase
      .from("accounting_sync_log")
      .select("id, provider, sync_type, status, started_at, completed_at, records_synced")
      .eq("brokerage_id", brokerageId)
      .gte("started_at", startDate.toISOString())
      .lte("started_at", endDate.toISOString())
      .order("started_at", { ascending: false })
      .limit(500)

    if (syncs) {
      for (const sync of syncs) {
        events.push({
          id: sync.id,
          timestamp: sync.started_at,
          entity_type: "accounting_sync",
          entity_id: null,
          event_type: "accounting_sync",
          actor_name: "System",
          subject_name: null,
          summary: `${sync.provider} ${sync.sync_type} sync: ${sync.status}`,
          metadata_json: { provider: sync.provider, sync_type: sync.sync_type, status: sync.status, records_synced: sync.records_synced },
          source_table: "accounting_sync_log",
        })
      }
    }
  }

  // 9. portal_access_logs (compliance sensitive)
  if (entityType === "all" || entityType === "portal_access" || complianceOnly) {
    const { data: accessLogs } = await supabase
      .from("portal_access_logs")
      .select("id, contact_id, agent_id, module_key, action, accessed_at")
      .gte("accessed_at", startDate.toISOString())
      .lte("accessed_at", endDate.toISOString())
      .order("accessed_at", { ascending: false })
      .limit(500)

    if (accessLogs) {
      for (const log of accessLogs) {
        const contactName = await getCachedContactName(log.contact_id)
        events.push({
          id: log.id,
          timestamp: log.accessed_at,
          entity_type: "portal_access",
          entity_id: log.contact_id,
          event_type: "portal_access",
          actor_name: contactName || "Portal User",
          subject_name: null,
          summary: `${contactName || "User"} viewed ${log.module_key}`,
          metadata_json: { module_key: log.module_key, action: log.action },
          source_table: "portal_access_logs",
        })
      }
    }
  }

  // Filter by agent if specified
  let filteredEvents = agentId
    ? events.filter(e => e.metadata_json?.agent_id === agentId || e.actor_name?.includes(agentId))
    : events

  // Filter by category
  if (category !== "all") {
    const categoryMap: Record<string, string[]> = {
      financial: ["commission", "accounting_sync"],
      communication: ["message", "voice_call", "isa_call"],
      compliance: ["document", "commission", "voice_call", "portal_access"],
      system: ["badge", "accounting_sync", "event"],
    }
    const allowedTypes = categoryMap[category] || []
    filteredEvents = filteredEvents.filter(e => allowedTypes.includes(e.entity_type))
  }

  // Filter by search
  if (search) {
    const searchLower = search.toLowerCase()
    filteredEvents = filteredEvents.filter(e => 
      e.summary.toLowerCase().includes(searchLower) ||
      e.actor_name.toLowerCase().includes(searchLower) ||
      (e.subject_name?.toLowerCase().includes(searchLower) ?? false)
    )
  }

  // Sort by timestamp DESC
  filteredEvents.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())

  // CSV export
  if (format === "csv") {
    const maxExport = 10000
    const exportEvents = filteredEvents.slice(0, maxExport)
    
    const csvRows = [
      ["timestamp", "entity_type", "summary", "actor", "source_table", "metadata_json"].join(","),
      ...exportEvents.map(e => [
        e.timestamp,
        e.entity_type,
        `"${e.summary.replace(/"/g, '""')}"`,
        `"${e.actor_name.replace(/"/g, '""')}"`,
        e.source_table,
        `"${JSON.stringify(e.metadata_json).replace(/"/g, '""')}"`,
      ].join(","))
    ]

    const csvContent = csvRows.join("\n")
    const dateRangeLabel = dateRange === "custom" ? `${customStart}-${customEnd}` : dateRange
    
    return new NextResponse(csvContent, {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename=audit-trail-${dateRangeLabel}.csv`,
      },
    })
  }

  // Paginate
  const totalCount = filteredEvents.length
  const startIndex = (page - 1) * pageSize
  const paginatedEvents = filteredEvents.slice(startIndex, startIndex + pageSize)

  return NextResponse.json({
    events: paginatedEvents,
    pagination: {
      page,
      pageSize,
      totalCount,
      totalPages: Math.ceil(totalCount / pageSize),
      hasMore: startIndex + pageSize < totalCount,
    },
  })
}

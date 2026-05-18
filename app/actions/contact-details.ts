"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity"

// Every read in this file is a contact PII surface: contact record itself,
// credit accounts, transactions, message threads, documents, video engagement,
// portal activity. Previously NONE of them verified that the caller had access
// to the contact — any signed-in user could pull this data for any contactId
// they could guess (UUIDs but enumerable from URL leaks, etc.). IDOR across
// every brokerage.
//
// Fix: every function now resolves brokerage_id from the session and verifies
// the contact's brokerage_id matches before returning anything.

async function authorizeContactAccess(contactId: string): Promise<
  | { ok: true; brokerageId: string; contact: { id: string; brokerage_id: string } }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }

  const svc = createServiceClient()
  const { data: u } = await svc
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!u?.brokerage_id) return { ok: false, error: "Unauthorized" }

  const { data: contact } = await svc
    .from("contacts")
    .select("id, brokerage_id")
    .eq("id", contactId)
    .maybeSingle()
  if (!contact) return { ok: false, error: "Contact not found" }
  if (contact.brokerage_id !== u.brokerage_id) return { ok: false, error: "Forbidden" }

  return { ok: true, brokerageId: u.brokerage_id, contact: { id: contact.id, brokerage_id: contact.brokerage_id } }
}

export async function getContactDetails(contactId: string) {
  const gate = await authorizeContactAccess(contactId)
  if (!gate.ok) return { contact: null, error: gate.error }

  const supabase = await createClient()
  const { data: contact, error } = await supabase
    .from("contacts")
    .select("*")
    .eq("id", contactId)
    .eq("brokerage_id", gate.brokerageId)
    .single()

  if (error) {
    return { contact: null, error: error.message }
  }

  const { data: conversations } = await supabase
    .from("conversations")
    .select("*")
    .eq("contact_id", contactId)
    .eq("brokerage_id", gate.brokerageId)
    .order("created_at", { ascending: false })
    .limit(10)

  return {
    contact: {
      ...contact,
      conversations: conversations || []
    },
    error: null
  }
}

export async function getContactCreditAccounts(contactId: string) {
  const gate = await authorizeContactAccess(contactId)
  if (!gate.ok) return { accounts: [], error: gate.error }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from("credit_accounts")
    .select("*")
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false })

  return { accounts: data || [], error }
}

export async function getContactVideoEngagement(contactId: string) {
  const gate = await authorizeContactAccess(contactId)
  if (!gate.ok) return { videos: [], error: gate.error }

  const supabase = await createClient()
  const { data: events } = await supabase
    .from("video_engagement_events")
    .select("video_asset_id, event_type, timestamp")
    .eq("contact_id", contactId)
    .order("timestamp", { ascending: false })
    .limit(20)

  const assetIds = [...new Set((events ?? []).map((e: any) => e.video_asset_id).filter(Boolean))]
  if (!assetIds.length) return { videos: [], error: null }

  const [{ data: perf }, { data: projects }] = await Promise.all([
    supabase
      .from("video_performance_tracking")
      .select("video_asset_id, total_views, average_completion_rate, last_event_at, brokerage_id")
      .in("video_asset_id", assetIds)
      .eq("brokerage_id", gate.brokerageId),
    supabase
      .from("ai_video_projects")
      .select("id, title, created_at, brokerage_id")
      .in("id", assetIds)
      .eq("brokerage_id", gate.brokerageId),
  ])

  const videos = assetIds.map((id: string) => {
    const p = perf?.find((x: any) => x.video_asset_id === id)
    const proj = projects?.find((x: any) => x.id === id)
    const firstEvent = (events ?? []).find((e: any) => e.video_asset_id === id)
    return {
      id,
      script_title: proj?.title ?? "Video",
      created_at: proj?.created_at ?? firstEvent?.timestamp,
      view_count: p?.total_views ?? 0,
      avg_completion_rate: p?.average_completion_rate ?? 0,
      last_viewed_at: p?.last_event_at ?? null,
    }
  })

  return { videos, error: null }
}

export async function getContactTransactions(contactId: string) {
  const gate = await authorizeContactAccess(contactId)
  if (!gate.ok) return { transactions: [], error: gate.error }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from("transactions")
    .select(
      "id, contact_id, listing_id, agent_id, property_address, city, state, " +
      "purchase_price, sale_price, list_price, status, contract_date, " +
      "closing_date, earnest_money, transaction_type, created_at, updated_at"
    )
    .eq("contact_id", contactId)
    .eq("brokerage_id", gate.brokerageId)
    .order("created_at", { ascending: false })

  return { transactions: data || [], error }
}

export async function getContactCopilotSuggestions(contactId: string) {
  // Use service client to bypass RLS on smart_assistant_suggestions.
  // Explicit tenant filters (brokerage_id + agent_id) maintain isolation.
  const supabase = createServiceClient()
  const { agentId, brokerageId } = await getAgentContext()

  if (!brokerageId) {
    return { suggestions: [], error: "No brokerage context" }
  }

  // Guard: service client bypasses RLS, so we must filter by agentId when available
  if (!agentId) {
    // Without an agentId we cannot safely scope suggestions — return empty
    return { suggestions: [], error: null }
  }

  // Pre-check that the contact belongs to caller's brokerage
  const { data: contact } = await supabase
    .from("contacts")
    .select("brokerage_id")
    .eq("id", contactId)
    .maybeSingle()
  if (!contact || contact.brokerage_id !== brokerageId) {
    return { suggestions: [], error: null }
  }

  let query = supabase
    .from("smart_assistant_suggestions")
    .select("*")
    .eq("context_id", contactId)
    .eq("context_type", "contact")
    .eq("status", "pending")
    .eq("brokerage_id", brokerageId)

  query = query.eq("agent_id", agentId)

  const { data, error } = await query
    .order("priority", { ascending: false })
    .limit(10)

  return { suggestions: data || [], error }
}

export async function getContactActivity(contactId: string) {
  const gate = await authorizeContactAccess(contactId)
  if (!gate.ok) return { activity: [], error: gate.error }

  const supabase = await createClient()

  // All activity tables are scoped to the verified contact
  const [conversations, messages, tasks, activities, portalActivity] = await Promise.all([
    supabase
      .from("conversations")
      .select("*")
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("messages")
      .select("*")
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("tasks")
      .select("*")
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("activities")
      .select("*")
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("client_portal_activity")
      .select("id, contact_id, activity_type, metadata, created_at")
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(50)
  ])

  const activity = [
    ...(conversations.data || []).map((item: any) => ({
      ...item,
      activity_type: "conversation",
      activity_date: item.created_at
    })),
    ...(messages.data || []).map((item: any) => ({
      ...item,
      activity_type: "message",
      activity_date: item.created_at
    })),
    ...(tasks.data || []).map((item: any) => ({
      ...item,
      activity_type: "task",
      activity_date: item.created_at
    })),
    ...(activities.data || []).map((item: any) => ({
      ...item,
      activity_type: "activity",
      activity_date: item.created_at
    })),
    ...(portalActivity.data || []).map((item: any) => ({
      ...item,
      activity_type: item.activity_type ?? "portal_view",
      activity_date: item.created_at,
      notes: item.metadata ? JSON.stringify(item.metadata) : "Portal activity",
    }))
  ].sort((a, b) => new Date(b.activity_date).getTime() - new Date(a.activity_date).getTime())

  return { activity, error: null }
}

export async function getContactDocuments(contactId: string) {
  const gate = await authorizeContactAccess(contactId)
  if (!gate.ok) return { documents: [], error: gate.error }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from("transaction_documents")
    .select("*, uploaded_by_agent:agents!transaction_documents_uploaded_by_fkey(first_name, last_name)")
    .eq("contact_id", contactId)
    .eq("brokerage_id", gate.brokerageId)
    .order("uploaded_at", { ascending: false })

  return { documents: data || [], error }
}

export async function getContactInteractions(contactId: string) {
  const gate = await authorizeContactAccess(contactId)
  if (!gate.ok) return { interactions: [], error: gate.error }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from("conversations")
    .select("*")
    .eq("contact_id", contactId)
    .eq("brokerage_id", gate.brokerageId)
    .order("created_at", { ascending: false })

  return { interactions: data || [], error }
}

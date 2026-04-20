"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity"

export async function getContactDetails(contactId: string) {
  const supabase = await createClient()

  // Get contact data
  const { data: contact, error } = await supabase
    .from("contacts")
    .select("*")
    .eq("id", contactId)
    .single()

  if (error) {
    console.error("[getContactDetails] Error:", error)
    return { contact: null, error: error.message }
  }

  // Get conversations separately
  const { data: conversations } = await supabase
    .from("conversations")
    .select("*")
    .eq("contact_id", contactId)
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
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("credit_accounts")
    .select("*")
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false })

  return { accounts: data || [], error }
}

export async function getContactVideoEngagement(contactId: string) {
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
      .select("video_asset_id, total_views, average_completion_rate, last_event_at")
      .in("video_asset_id", assetIds),
    supabase
      .from("ai_video_projects")
      .select("id, title, created_at")
      .in("id", assetIds),
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
  const supabase = await createClient()

  // Transactions are created from accepted offers via createTransactionFromCompliantAcceptedOffer().
  // They carry their own property data and are self-contained — no join to listings needed.
  const { data, error } = await supabase
    .from("transactions")
    .select(
      "id, contact_id, listing_id, agent_id, property_address, city, state, " +
      "purchase_price, sale_price, list_price, status, contract_date, " +
      "closing_date, earnest_money, transaction_type, created_at, updated_at"
    )
    .eq("contact_id", contactId)
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
  const supabase = await createClient()

  // Fetch all activity types
  const [conversations, messages, tasks, activities] = await Promise.all([
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
      .limit(50)
  ])

  // Combine and sort by date
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
    }))
  ].sort((a, b) => new Date(b.activity_date).getTime() - new Date(a.activity_date).getTime())

  return { activity, error: null }
}

export async function getContactDocuments(contactId: string) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("transaction_documents")
    .select("*, uploaded_by_agent:agents!transaction_documents_uploaded_by_fkey(first_name, last_name)")
    .eq("contact_id", contactId)
    .order("uploaded_at", { ascending: false })

  return { documents: data || [], error }
}

export async function getContactInteractions(contactId: string) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("conversations")
    .select("*")
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false })

  return { interactions: data || [], error }
}

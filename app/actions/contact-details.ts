"use server"

import { createClient } from "@/lib/supabase/server"

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

  const { data, error } = await supabase
    .from("video_scripts_library")
    .select("*")
    .eq("target_contact_id", contactId)
    .order("created_at", { ascending: false })

  return { videos: data || [], error }
}

export async function getContactTransactions(contactId: string) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("transactions")
    .select(`
      *,
      listings (
        address,
        city,
        state,
        price
      )
    `)
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false })

  return { transactions: data || [], error }
}

export async function getContactCopilotSuggestions(contactId: string) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("smart_assistant_suggestions")
    .select("*")
    .eq("context_id", contactId)
    .eq("context_type", "contact")
    .eq("status", "pending")
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

"use server"

import { createClient } from "@/lib/supabase/server"

export async function getContactDetails(contactId: string) {
  const supabase = await createClient()

  // Get contact with related data
  const { data: contact, error } = await supabase
    .from("contacts")
    .select(`
      *,
      interactions (
        id,
        interaction_type,
        interaction_date,
        notes,
        outcome
      )
    `)
    .eq("id", contactId)
    .single()

  if (error) {
    console.error("[getContactDetails] Error:", error)
    return { contact: null, error: error.message }
  }

  return { contact, error: null }
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
    .from("video_scripts")
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
  const [interactions, communications, tasks, notes] = await Promise.all([
    supabase
      .from("interactions")
      .select("*, agent:agents!interactions_agent_id_fkey(first_name, last_name)")
      .eq("contact_id", contactId)
      .order("interaction_date", { ascending: false })
      .limit(50),
    supabase
      .from("communications")
      .select("*")
      .eq("contact_id", contactId)
      .order("sent_at", { ascending: false })
      .limit(50),
    supabase
      .from("tasks")
      .select("*, assigned_agent:agents!tasks_assigned_to_fkey(first_name, last_name)")
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("contact_notes")
      .select("*, created_by_agent:agents!contact_notes_created_by_fkey(first_name, last_name)")
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(50)
  ])

  // Combine and sort by date
  const activity = [
    ...(interactions.data || []).map((item: any) => ({ 
      ...item, 
      activity_type: "interaction", 
      activity_date: item.interaction_date 
    })),
    ...(communications.data || []).map((item: any) => ({ 
      ...item, 
      activity_type: "communication", 
      activity_date: item.sent_at 
    })),
    ...(tasks.data || []).map((item: any) => ({ 
      ...item, 
      activity_type: "task", 
      activity_date: item.created_at 
    })),
    ...(notes.data || []).map((item: any) => ({ 
      ...item, 
      activity_type: "note", 
      activity_date: item.created_at 
    }))
  ].sort((a, b) => new Date(b.activity_date).getTime() - new Date(a.activity_date).getTime())

  return { activity, error: null }
}

export async function getContactDocuments(contactId: string) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("documents")
    .select("*, uploaded_by_agent:agents!documents_uploaded_by_fkey(first_name, last_name)")
    .eq("contact_id", contactId)
    .order("uploaded_at", { ascending: false })

  return { documents: data || [], error }
}

export async function getContactInteractions(contactId: string) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("interactions")
    .select("*, agent:agents!interactions_agent_id_fkey(first_name, last_name)")
    .eq("contact_id", contactId)
    .order("interaction_date", { ascending: false })

  return { interactions: data || [], error }
}

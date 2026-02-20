"use server"

import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"

export async function getContacts(params?: {
  status?: string
  buyer_seller_status?: string
  limit?: number
}) {
  try {
    const { agentId, brokerageId } = await getAgentContext()
    const supabase = await createClient()

    let query = supabase
      .from("contacts")
      .select("*")
      .eq("agent_id", agentId)
      .eq("brokerage_id", brokerageId)
      .order("created_at", { ascending: false })

    // Apply filters
    if (params?.status) {
      query = query.eq("status", params.status)
    }

    if (params?.buyer_seller_status) {
      query = query.eq("buyer_seller_status", params.buyer_seller_status)
    }

    if (params?.limit) {
      query = query.limit(params.limit)
    }

    const { data, error } = await query

    if (error) {
      console.error("[v0] Error fetching contacts:", error)
      return { success: false, error: error.message, contacts: [] }
    }

    return { success: true, contacts: data || [] }
  } catch (error: any) {
    console.error("[v0] Error in getContacts:", error)
    return { success: false, error: error.message, contacts: [] }
  }
}

export async function getContactById(contactId: string) {
  try {
    const { agentId, brokerageId } = await getAgentContext()
    const supabase = await createClient()

    const { data, error } = await supabase
      .from("contacts")
      .select("*")
      .eq("id", contactId)
      .eq("agent_id", agentId)
      .eq("brokerage_id", brokerageId)
      .single()

    if (error) {
      console.error("[v0] Error fetching contact:", error)
      return { success: false, error: error.message, contact: null }
    }

    return { success: true, contact: data }
  } catch (error: any) {
    console.error("[v0] Error in getContactById:", error)
    return { success: false, error: error.message, contact: null }
  }
}

export async function createContact(contactData: {
  first_name: string
  last_name: string
  email: string
  phone?: string
  buyer_seller_status?: string
  status?: string
}) {
  try {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      return { success: false, error: "Not authenticated" }
    }

    const { data, error } = await supabase
      .from("contacts")
      .insert({
        ...contactData,
        agent_id: user.id,
      })
      .select()
      .single()

    if (error) {
      console.error("[v0] Error creating contact:", error)
      return { success: false, error: error.message }
    }

    return { success: true, contact: data }
  } catch (error: any) {
    console.error("[v0] Error in createContact:", error)
    return { success: false, error: error.message }
  }
}

export async function updateContact(contactId: string, updates: Partial<any>) {
  try {
    const { agentId, brokerageId } = await getAgentContext()
    const supabase = await createClient()

    const { data, error } = await supabase
      .from("contacts")
      .update(updates)
      .eq("id", contactId)
      .eq("agent_id", agentId)
      .eq("brokerage_id", brokerageId)
      .select()
      .single()

    if (error) {
      console.error("[v0] Error updating contact:", error)
      return { success: false, error: error.message }
    }

    return { success: true, contact: data }
  } catch (error: any) {
    console.error("[v0] Error in updateContact:", error)
    return { success: false, error: error.message }
  }
}

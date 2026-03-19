"use server"

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"

// ─── Log Activity ────────────────────────────────────────────────────────────
export async function logActivity(data: {
  agentId: string
  contactId?: string
  activityType: string
  title: string
  description?: string
  metadata?: Record<string, unknown>
}): Promise<{ success: boolean; activityId?: string; error?: string }> {
  try {
    const supabase = await createClient()

    const { data: activity, error } = await supabase
      .from("activities")
      .insert({
        agent_id: data.agentId,
        contact_id: data.contactId,
        activity_type: data.activityType,
        title: data.title,
        description: data.description,
        metadata: data.metadata || {},
        created_at: new Date().toISOString(),
      })
      .select("id")
      .single()

    if (error) {
      console.error("[logActivity] Error:", error)
      return { success: false, error: error.message }
    }

    revalidatePath("/mobile/assistant")
    revalidatePath("/dashboard")

    return { success: true, activityId: activity?.id }
  } catch (err) {
    console.error("[logActivity] Exception:", err)
    return { success: false, error: "Failed to log activity" }
  }
}

// ─── Complete Activity ───────────────────────────────────────────────────────
export async function completeActivity(
  activityId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = await createClient()

    const { error } = await supabase
      .from("activities")
      .update({
        status: "completed",
        completed_at: new Date().toISOString(),
      })
      .eq("id", activityId)

    if (error) {
      console.error("[completeActivity] Error:", error)
      return { success: false, error: error.message }
    }

    revalidatePath("/mobile/assistant")
    revalidatePath("/dashboard")

    return { success: true }
  } catch (err) {
    console.error("[completeActivity] Exception:", err)
    return { success: false, error: "Failed to complete activity" }
  }
}

// ─── Get Agent Activities ────────────────────────────────────────────────────
export async function getAgentActivities(
  agentId: string,
  options?: { limit?: number; status?: string }
): Promise<{ activities: any[]; error?: string }> {
  try {
    const supabase = await createClient()

    let query = supabase
      .from("activities")
      .select("*")
      .eq("agent_id", agentId)
      .order("created_at", { ascending: false })

    if (options?.status) {
      query = query.eq("status", options.status)
    }

    if (options?.limit) {
      query = query.limit(options.limit)
    }

    const { data, error } = await query

    if (error) {
      console.error("[getAgentActivities] Error:", error)
      return { activities: [], error: error.message }
    }

    return { activities: data || [] }
  } catch (err) {
    console.error("[getAgentActivities] Exception:", err)
    return { activities: [], error: "Failed to fetch activities" }
  }
}

// ─── Get Pending Followups ───────────────────────────────────────────────────
export async function getPendingFollowups(
  agentId: string,
  limit: number = 10
): Promise<{ followups: any[]; error?: string }> {
  try {
    const supabase = await createClient()

    const { data, error } = await supabase
      .from("activities")
      .select(`
        *,
        contacts:contact_id (
          id,
          first_name,
          last_name,
          phone,
          email
        )
      `)
      .eq("agent_id", agentId)
      .eq("status", "pending")
      .in("activity_type", ["followup", "callback", "reminder", "task"])
      .order("due_date", { ascending: true, nullsFirst: false })
      .limit(limit)

    if (error) {
      console.error("[getPendingFollowups] Error:", error)
      return { followups: [], error: error.message }
    }

    return { followups: data || [] }
  } catch (err) {
    console.error("[getPendingFollowups] Exception:", err)
    return { followups: [], error: "Failed to fetch followups" }
  }
}

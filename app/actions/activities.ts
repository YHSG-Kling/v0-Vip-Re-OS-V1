"use server"

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { getAgentContext } from "@/lib/identity/get-agent-context"

/**
 * The two readers below are `"use server"` exports, i.e. public HTTP endpoints,
 * and both took the agent whose activities to return **from the caller**.
 * `getPendingFollowups` embeds `contacts(first_name, last_name, phone, email)`,
 * so an anonymous caller iterating agent ids was reading contact PII out of any
 * brokerage. Neither had any caller, so nothing depended on the loose behaviour.
 *
 * They now resolve the agent from the SESSION and refuse a mismatch. Callers may
 * still pass the id (that is how the surfaces are written) — it just has to be
 * their own. Platform staff acting-as a tenant are covered because
 * getAgentContext() already returns the impersonated agentId.
 */
async function resolveOwnAgentId(
  requestedAgentId: string,
): Promise<{ ok: true; agentId: string } | { ok: false; error: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return { ok: false, error: "Unauthenticated" }
  if (!ctx.agentId) return { ok: false, error: "No agent profile for this user" }
  if (requestedAgentId && requestedAgentId !== ctx.agentId) {
    return { ok: false, error: "Forbidden — you can only read your own activities" }
  }
  return { ok: true, agentId: ctx.agentId }
}

// ─── Log Activity ────────────────────────────────────────────────────────────
export async function logActivity(data: {
  brokerageId: string
  agentId: string
  contactId?: string
  transactionId?: string
  activityType: string
  title: string
  description?: string
  notes?: string
  status?: string
  priority?: "low" | "medium" | "high"
  entityType?: string
  scheduledAt?: string
  completedAt?: string
  durationMinutes?: number
}): Promise<{ success: boolean; activityId?: string; error?: string }> {
  try {
    const supabase = await createClient()

    const { data: activity, error } = await supabase
      .from("activities")
      .insert({
        brokerage_id: data.brokerageId,
        agent_id: data.agentId,
        contact_id: data.contactId ?? null,
        transaction_id: data.transactionId ?? null,
        activity_type: data.activityType,
        title: data.title,
        description: data.description ?? null,
        notes: data.notes ?? null,
        status: data.status ?? "pending",
        priority: data.priority ?? "medium",
        entity_type: data.entityType ?? (data.transactionId ? "transaction" : "contact"),
        scheduled_at: data.scheduledAt ?? null,
        completed_at: data.completedAt ?? null,
        duration_minutes: data.durationMinutes ?? null,
      })
      .select("id")
      .single()

    if (error) {
      console.error("[logActivity] Error:", error.message)
      return { success: false, error: error.message }
    }

    revalidatePath("/mobile/assistant")
    revalidatePath("/dashboard")
    // The activity log renders this on the server — a freshly logged activity is
    // invisible there until this entry is dropped.
    revalidatePath("/mobile/activity")

    return { success: true, activityId: activity?.id }
  } catch (err) {
    console.error("[logActivity] Exception:", err)
    return { success: false, error: "Failed to log activity" }
  }
}

// ─── Complete Activity ───────────────────────────────────────────────────────
export async function completeActivity(
  activityId: string,
  /** What the agent heard, captured at the moment of completion. The mobile
   *  sheet has always shown an "Add notes" box; until now the text was dropped
   *  on submit, so the most perishable intelligence in the business — what the
   *  seller actually said at the door — was collected and destroyed. */
  notes?: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = await createClient()

    const trimmed = notes?.trim()
    const { error } = await supabase
      .from("activities")
      .update({
        status: "completed",
        completed_at: new Date().toISOString(),
        ...(trimmed ? { notes: trimmed } : {}),
      })
      .eq("id", activityId)

    if (error) {
      console.error("[completeActivity] Error:", error)
      return { success: false, error: error.message }
    }

    revalidatePath("/mobile/assistant")
    revalidatePath("/dashboard")
    // Completion moves the row between the log's status filters AND writes the note
    // the log renders.
    revalidatePath("/mobile/activity")

    return { success: true }
  } catch (err) {
    console.error("[completeActivity] Exception:", err)
    return { success: false, error: "Failed to complete activity" }
  }
}

// ─── Get Agent Activities ────────────────────────────────────────────────────
/**
 * WIRED (orphan burn-down). This file had three live WRITERS on the field surfaces —
 * app/mobile/components/os/field-quick-actions.tsx, app/crm/components/os/
 * contact-command-strip.tsx and app/crm/components/contact-header-card.tsx all call
 * logActivity, and app/mobile/components/os/mobile-followup-panel.tsx calls
 * completeActivity — and this read had no caller at all. An agent could log a door
 * knock, a call and a note from the field and there was no screen anywhere in the
 * product that showed them back, including the notes captured at completion, which
 * are the most perishable thing the business collects.
 *
 * Its reader is now app/mobile/activity/page.tsx: the full history behind the
 * `getPendingFollowups` queue, status-filtered through searchParams so it stays a
 * server component and no unrendered activity row (free-text notes included) is ever
 * shipped to the client.
 *
 * NOT A DUPLICATE OF getPendingFollowups below: that one returns only `pending` rows
 * of four follow-up types with the contact embedded, ordered by schedule. This one
 * returns every activity type in every status, newest first, and embeds nothing.
 */
export async function getAgentActivities(
  agentId: string,
  options?: { limit?: number; status?: string }
): Promise<{ activities: any[]; error?: string }> {
  try {
    const actor = await resolveOwnAgentId(agentId)
    if (!actor.ok) return { activities: [], error: actor.error }

    const supabase = await createClient()

    let query = supabase
      .from("activities")
      .select("*")
      .eq("agent_id", actor.agentId)
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
    const actor = await resolveOwnAgentId(agentId)
    if (!actor.ok) return { followups: [], error: actor.error }

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
      .eq("agent_id", actor.agentId)
      .eq("status", "pending")
      .in("activity_type", ["followup", "callback", "reminder", "task"])
      .order("scheduled_at", { ascending: true, nullsFirst: false })
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

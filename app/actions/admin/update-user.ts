"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"

export interface UpdateUserParams {
  userId: string
  updates: {
    first_name?: string
    last_name?: string
    user_type?: string
    role?: string
    status?: string
    brokerage_id?: string | null
  }
}

export interface UpdateUserResult {
  success: boolean
  error?: string
}

export async function updateUser({ userId, updates }: UpdateUserParams): Promise<UpdateUserResult> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthenticated" }

  // Role gate: caller must be admin or superadmin
  const { data: caller } = await supabase
    .from("users")
    .select("user_type, role, brokerage_id")
    .eq("id", user.id)
    .single()

  const callerRole = caller?.user_type ?? caller?.role ?? ""
  if (!["admin", "superadmin"].includes(callerRole)) {
    return { success: false, error: "Forbidden: admin or superadmin only" }
  }

  // Non-superadmin admins can only update users in their own brokerage
  if (callerRole === "admin" && caller?.brokerage_id) {
    const { data: target } = await supabase
      .from("users")
      .select("brokerage_id")
      .eq("id", userId)
      .single()
    if (target?.brokerage_id !== caller.brokerage_id) {
      return { success: false, error: "Forbidden: user belongs to a different brokerage" }
    }
    // Prevent admin from granting brokerage_id outside their own
    if (updates.brokerage_id && updates.brokerage_id !== caller.brokerage_id) {
      return { success: false, error: "Forbidden: cannot reassign user to another brokerage" }
    }
  }

  // Prevent role escalation to superadmin by non-superadmin callers
  if (callerRole !== "superadmin" && (updates.user_type === "superadmin" || updates.role === "superadmin")) {
    return { success: false, error: "Forbidden: cannot grant superadmin role" }
  }

  const service = createServiceClient()

  // Snapshot current state for audit before
  const { data: before } = await service
    .from("users")
    .select("first_name, last_name, user_type, role, status, brokerage_id")
    .eq("id", userId)
    .single()

  // Apply update — keep role and user_type in sync
  const patch: Record<string, unknown> = {
    ...updates,
    updated_at: new Date().toISOString(),
  }
  if (updates.user_type && !updates.role) patch.role = updates.user_type
  if (updates.role && !updates.user_type) patch.user_type = updates.role

  const { error: updateError } = await service
    .from("users")
    .update(patch)
    .eq("id", userId)

  if (updateError) {
    return { success: false, error: updateError.message }
  }

  // Audit log to activities table
  await service
    .from("activities")
    .insert({
      activity_type: "admin.user.updated",
      agent_id: user.id,
      brokerage_id: caller?.brokerage_id ?? null,
      title: `User updated: ${userId}`,
      description: JSON.stringify({ before, after: patch, updated_by: user.id }),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .catch(() => {})

  return { success: true }
}

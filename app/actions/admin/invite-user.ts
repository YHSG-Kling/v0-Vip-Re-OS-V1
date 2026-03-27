"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"

export async function inviteUser(params: {
  email: string
  firstName: string
  lastName: string
  userType: string
  brokerageId?: string
}): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthenticated" }

  const { data: caller } = await supabase
    .from("users")
    .select("user_type, role, brokerage_id")
    .eq("id", user.id)
    .single()

  const callerType = caller?.user_type ?? caller?.role
  if (!["admin", "superadmin"].includes(callerType ?? "")) {
    return { success: false, error: "Forbidden: admin or superadmin only" }
  }

  // Non-superadmin admins can only invite to their own brokerage
  const resolvedBrokerageId =
    callerType === "superadmin"
      ? params.brokerageId || caller?.brokerage_id || null
      : caller?.brokerage_id || null

  const service = createServiceClient()

  try {
    await service.auth.admin.inviteUserByEmail(params.email, {
      data: {
        first_name: params.firstName,
        last_name: params.lastName,
        user_type: params.userType,
        brokerage_id: resolvedBrokerageId,
      },
      redirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/onboarding`,
    })

    // Upsert users record so they appear in admin panel immediately
    const { data: upsertedUser } = await service
      .from("users")
      .upsert(
        {
          email: params.email,
          first_name: params.firstName,
          last_name: params.lastName,
          user_type: params.userType,
          role: params.userType,
          brokerage_id: resolvedBrokerageId,
          is_contact: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "email" }
      )
      .select("id")
      .maybeSingle()
      .catch(() => ({ data: null }))

    // ── Full provisioning for agent / coordinator roles ──────────────────
    const isAgentRole = ["agent", "coordinator", "tc"].includes(params.userType)
    if (isAgentRole && upsertedUser?.id && resolvedBrokerageId) {
      const newUserId = upsertedUser.id

      // 1. agents row — creates the canonical agent record
      const { data: agentRow } = await service
        .from("agents")
        .upsert(
          {
            user_id: newUserId,
            brokerage_id: resolvedBrokerageId,
            first_name: params.firstName || null,
            last_name: params.lastName || null,
            email: params.email,
            status: "pending",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id" }
        )
        .select("id")
        .maybeSingle()
        .catch(() => ({ data: null }))

      // 2. commission profile (agent_commission_profiles)
      if (agentRow?.id) {
        await service
          .from("agent_commission_profiles")
          .upsert(
            {
              agent_id: agentRow.id,
              brokerage_id: resolvedBrokerageId,
              split_percentage: 70, // brokerage default; overrideable post-onboard
              is_active: true,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
            { onConflict: "agent_id" }
          )
          .catch(() => {})
      }

      // 3. onboarding state row — prevents "onboarding incomplete" false-negative
      await service
        .from("agent_onboarding")
        .upsert(
          {
            user_id: newUserId,
            brokerage_id: resolvedBrokerageId,
            status: "pending",
            completion_percentage: 0,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id" }
        )
        .catch(() => {})
    }

    // Audit log
    await service
      .from("activities")
      .insert({
        activity_type: "admin.user.invited",
        agent_id: user.id,
        brokerage_id: resolvedBrokerageId,
        title: `User invited: ${params.email}`,
        notes: JSON.stringify({
          user_type: params.userType,
          brokerage_id: resolvedBrokerageId,
          invited_by: user.id,
          provisioned: isAgentRole,
        }),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .catch(() => {})

    return { success: true }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
}

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"

export async function POST(req: Request) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 })

    const { data: profile } = await supabase
      .from("users")
      .select("user_type, role, brokerage_id")
      .eq("id", user.id)
      .maybeSingle()

    const resolvedType = profile?.user_type ?? profile?.role ?? ""
    if (!["broker", "admin", "superadmin"].includes(resolvedType)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const { recruitId } = await req.json()
    if (!recruitId) return NextResponse.json({ error: "recruitId required" }, { status: 400 })

    const service = createServiceClient()

    // Fetch recruit — must belong to same brokerage and be status=joined
    const { data: recruit } = await service
      .from("recruits")
      .select("id, first_name, last_name, email, brokerage_id, status, provisioned, years_experience, license_state")
      .eq("id", recruitId)
      .eq("brokerage_id", profile!.brokerage_id!)
      .maybeSingle()

    if (!recruit) return NextResponse.json({ error: "Recruit not found" }, { status: 404 })
    if (recruit.provisioned) return NextResponse.json({ error: "Already provisioned" }, { status: 409 })
    if (recruit.status !== "joined") {
      return NextResponse.json({ error: "Recruit must be in 'joined' status before provisioning" }, { status: 422 })
    }

    // Check for existing user with this email to avoid duplicate auth record
    const { data: existingUser } = await service
      .from("users")
      .select("id")
      .eq("email", recruit.email)
      .maybeSingle()

    let newUserId: string | null = existingUser?.id ?? null

    if (!existingUser) {
      // Send auth invite — creates auth.users record
      const { data: inviteData, error: inviteError } = await service.auth.admin.inviteUserByEmail(recruit.email, {
        data: {
          first_name: recruit.first_name,
          last_name: recruit.last_name,
          user_type: "agent",
          brokerage_id: recruit.brokerage_id,
        },
        redirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/onboarding`,
      })
      if (inviteError) throw inviteError
      newUserId = inviteData?.user?.id ?? null
    }

    // Upsert users row
    const { data: upsertedUser } = await service
      .from("users")
      .upsert(
        {
          email: recruit.email,
          first_name: recruit.first_name,
          last_name: recruit.last_name,
          user_type: "agent",
          role: "agent",
          brokerage_id: recruit.brokerage_id,
          is_contact: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          ...(newUserId ? { id: newUserId } : {}),
        },
        { onConflict: "email" }
      )
      .select("id")
      .maybeSingle()
      .catch(() => ({ data: null }))

    const resolvedUserId = upsertedUser?.id ?? newUserId

    // Create agents row
    let agentId: string | null = null
    if (resolvedUserId) {
      const { data: agentRow } = await service
        .from("agents")
        .upsert(
          {
            user_id: resolvedUserId,
            brokerage_id: recruit.brokerage_id,
            is_active: true,
            years_experience: recruit.years_experience ?? 0,
            license_state: recruit.license_state ?? null,
            onboarding_status: "pending",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id" }
        )
        .select("id")
        .maybeSingle()
        .catch(() => ({ data: null }))
      agentId = agentRow?.id ?? null

      // Default commission profile
      if (agentId) {
        await service.from("agent_commission_profiles").upsert(
          {
            agent_id: agentId,
            brokerage_id: recruit.brokerage_id,
            split_percent: 70,
            split_percentage: 70,
            structure_type: "split",
            is_active: true,
            created_at: new Date().toISOString(),
          },
          { onConflict: "agent_id" }
        ).catch(() => {})
      }

      // Onboarding state
      await service.from("agent_onboarding").upsert(
        {
          user_id: resolvedUserId,
          brokerage_id: recruit.brokerage_id,
          status: "pending",
          completion_percentage: 0,
          current_day: 1,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" }
      ).catch(() => {})
    }

    // Mark recruit as provisioned
    await service.from("recruits").update({
      provisioned: true,
      provisioned_at: new Date().toISOString(),
      provisioned_user_id: resolvedUserId,
      updated_at: new Date().toISOString(),
    }).eq("id", recruitId)

    // Activity log
    await service.from("activities").insert({
      activity_type: "recruiting.agent_provisioned",
      agent_id: user.id,
      brokerage_id: recruit.brokerage_id,
      title: `Agent provisioned from recruit: ${recruit.first_name} ${recruit.last_name}`,
      notes: JSON.stringify({ recruit_id: recruitId, new_user_id: resolvedUserId, agent_id: agentId }),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).catch(() => {})

    return NextResponse.json({
      success: true,
      userId: resolvedUserId,
      agentId,
      email: recruit.email,
    })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

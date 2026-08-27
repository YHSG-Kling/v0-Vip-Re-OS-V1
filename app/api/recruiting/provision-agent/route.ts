import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"
import { seatGate } from "@/lib/kernel/seat-usage"
import { isPlatformSuperadminIdentity } from "@/lib/platform/platform-staff-roster"
import { bestEffort } from "@/lib/db/best-effort"

export async function POST(req: Request) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 })

    const { data: profile } = await supabase
      .from("users")
      .select("user_type, brokerage_id, platform_role")
      .eq("id", user.id)
      .maybeSingle()

    const resolvedType = profile?.user_type ?? ""
    // ONE DEFINITION (ruling 1) — lib/platform/platform-staff-roster.ts:isPlatformSuperadminIdentity
    const isPlatformAdmin = isPlatformSuperadminIdentity(resolvedType, profile?.platform_role)
    const isBrokerageAdmin = isAdminOrBroker({ user_type: resolvedType })
    if (!isPlatformAdmin && !isBrokerageAdmin) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const { recruitId } = await req.json()
    if (!recruitId) return NextResponse.json({ error: "recruitId required" }, { status: 400 })

    const service = createServiceClient()

    // Fetch recruit. Brokerage admins are scoped to their own brokerage;
    // platform admin may provision across brokerages.
    let recruitQuery = service
      .from("recruits")
      .select("id, first_name, last_name, email, brokerage_id, status, provisioned, years_experience, license_state, recruiter_agent_id")
      .eq("id", recruitId)

    if (!isPlatformAdmin) {
      recruitQuery = recruitQuery.eq("brokerage_id", profile!.brokerage_id!)
    }

    const { data: recruit } = await recruitQuery.maybeSingle()

    if (!recruit) return NextResponse.json({ error: "Recruit not found" }, { status: 404 })

    // Cross-brokerage provisioning is reserved for platform admins. Even
    // after RLS scopes the recruit lookup, double-check here so the audit
    // log captures attempted boundary crossings.
    if (!isPlatformAdmin && recruit.brokerage_id !== profile!.brokerage_id) {
      await service.from("tenant_transition_log").insert({
        actor_user_id: user.id,
        action: "provision_recruit_denied_cross_brokerage",
        entity_type: "recruit",
        entity_id: recruit.id,
        from_brokerage_id: recruit.brokerage_id,
        to_brokerage_id: profile!.brokerage_id,
        metadata: { reason: "caller_not_platform_admin" },
      }).then(() => {}, () => {})
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }
    if (recruit.provisioned) return NextResponse.json({ error: "Already provisioned" }, { status: 409 })
    if (recruit.status !== "joined") {
      return NextResponse.json({ error: "Recruit must be in 'joined' status before provisioning" }, { status: 422 })
    }

    // Check for existing user with this email to avoid duplicate auth record.
    //
    // brokerage_id is selected, not just id, because the upsert below conflicts on
    // `email` — a GLOBAL key — while setting brokerage_id to the recruit's. Without
    // this check, provisioning a recruit whose email already belongs to a user at
    // ANOTHER brokerage silently rewrites that person's row into this one, and takes
    // their agents row and commission profile with it. Same cross-tenant capture that
    // createOrRepairUserDomainRecords guards in lib/kernel/users.ts; the rule matches:
    // the person must leave their current brokerage first, and only a platform admin
    // may move them deliberately.
    const { data: existingUser } = await service
      .from("users")
      .select("id, brokerage_id")
      .eq("email", recruit.email)
      .maybeSingle()

    const holderBrokerageId = (existingUser as { brokerage_id?: string | null } | null)?.brokerage_id ?? null
    if (holderBrokerageId && holderBrokerageId !== recruit.brokerage_id && !isPlatformAdmin) {
      await service.from("tenant_transition_log").insert({
        actor_user_id: user.id,
        action: "provision_recruit_denied_email_belongs_to_other_brokerage",
        entity_type: "recruit",
        entity_id: recruit.id,
        from_brokerage_id: holderBrokerageId,
        to_brokerage_id: recruit.brokerage_id,
        metadata: { reason: "email_holder_at_other_brokerage" },
      }).then(() => {}, () => {})
      return NextResponse.json({
        error: "That email already belongs to a user at another brokerage. They must leave it before they can be provisioned here.",
      }, { status: 409 })
    }

    let newUserId: string | null = existingUser?.id ?? null

    // ── SEATS ─────────────────────────────────────────────────────────────────
    // A provisioned recruit becomes user_type 'agent' — a working seat — and this
    // route had no tier or seat check at all, so recruiting was a way past the
    // subscription cap that the invite surface enforces. Same ONE gate as the
    // invite, the god console, the role-change and the reactivation paths
    // (lib/kernel/seat-usage.ts): the count comes from both role sources, the
    // limit from the plan catalogue, and it FAILS CLOSED if any of the three
    // reads is refused.
    //
    // The tenant is the RECRUIT'S brokerage, which the block above has already
    // proved the caller may act on (own tenant, or platform staff) — never a
    // value from the request body. `subjectUserId` keeps a re-provision of
    // someone already seated here from being charged twice.
    //
    // 409, not 403: nothing is wrong with the caller or the recruit. The plan is
    // full, and the body names the tier that fixes it so the recruiting UI can
    // put an Upgrade button on the refusal instead of a shrug.
    {
      const verdict = await seatGate(service, recruit.brokerage_id as string, "agent", {
        subjectUserId: existingUser?.id ?? null,
      })
      if (!verdict.allowed) {
        return NextResponse.json({
          error: verdict.message ?? "Seat limit reached.",
          reason: verdict.reason,
          upgradeTo: verdict.decision?.upgradeTo ?? null,
          upgradeSeats: verdict.decision?.upgradeSeats ?? null,
          seatLimit: verdict.decision?.limit ?? null,
        }, { status: 409 })
      }
    }

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

    // Upsert users row (user_type is the canonical role column; the
    // legacy `role` column is no longer written — migration 036+).
    const { data: upsertedUser } = await service
      .from("users")
      .upsert(
        {
          email: recruit.email,
          first_name: recruit.first_name,
          last_name: recruit.last_name,
          user_type: "agent",
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
            // agents.onboarding_status is (not_started|in_progress|completed|
            // pending_review). A freshly provisioned recruit has not started.
            onboarding_status: "not_started",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id" }
        )
        .select("id")
        .maybeSingle()
      agentId = agentRow?.id ?? null

      // Default commission profile
      if (agentId) {
        await service.from("agent_commission_profiles").upsert(
          {
            agent_id: agentId,
            brokerage_id: recruit.brokerage_id,
            split_percent: 70,
            structure_type: "split",
            is_active: true,
            created_at: new Date().toISOString(),
          },
          { onConflict: "agent_id" }
        ).then(() => {}, () => {})

        // Onboarding state — agent_onboarding is keyed on agent_id (NOT NULL).
        await service.from("agent_onboarding").upsert(
          {
            agent_id: agentId,
            user_id: resolvedUserId,
            brokerage_id: recruit.brokerage_id,
            status: "in_progress",
            completion_percentage: 0,
            current_day: 1,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          { onConflict: "agent_id" }
        ).then(() => {}, () => {})

        // REVENUE-SHARE TREE (burn-down round 5, owner spec): when the recruit
        // was referred by a sponsoring agent, plant the downline edge — the
        // revenue-share leaderboard and the commission waterfall's residual
        // step read agent_relationships, which had NO writer until now.
        // Live rules: UNIQUE(agent_id, brokerage_id, relationship_type),
        // agent ≠ sponsor, depth_level = sponsor's depth + 1 (root sponsor = 1).
        //
        // TERMS COME FROM THE CONFIGURED MODEL (owner ruling 2026-08-27: the
        // settings tell the platform how the share is distributed — this write
        // used to invent `revenue_share_percent: 5, source_of_funds:
        // "brokerage"` for every brokerage). FAIL-CLOSED: an enabled mark with
        // no configured model (m575) plants NO edge — nothing is invented; the
        // broker configures the model in Settings → Commission & Offerings and
        // future provisions stamp it.
        if ((recruit as any).recruiter_agent_id && (recruit as any).recruiter_agent_id !== agentId) {
          const { getRevenueShareModel, edgeTermsFromModel } = await import("@/lib/commission/revenue-share-model")
          const rsState = await getRevenueShareModel(recruit.brokerage_id, service)
          const edgeTerms = edgeTermsFromModel(rsState)
          if (!edgeTerms) {
            console.warn(
              `[provision-agent] no revenue-share edge planted for recruit ${recruitId}: ` +
                (rsState.enabled
                  ? `distribution model unconfigured (missing: ${rsState.missing.join(", ")})`
                  : "brokerage has not enabled revenue share")
            )
          } else {
            const sponsorId = (recruit as any).recruiter_agent_id as string
            const { data: sponsorEdge } = await service
              .from("agent_relationships")
              .select("depth_level")
              .eq("agent_id", sponsorId)
              .eq("brokerage_id", recruit.brokerage_id)
              .eq("relationship_type", "sponsor")
              .eq("is_active", true)
              .maybeSingle()
            // Plain await (supabase-js resolves with {error}, never throws) —
            // the pass-4 silencer ratchet forbids new '.then(noop,noop)' writes.
            // edgeTerms only carries revenue_share_flat_cents for a flat model
            // (an m575-only configuration), so a percent-model write stays
            // valid pre-apply — naming an absent column would refuse the whole
            // upsert (PGRST204, §3).
            await service.from("agent_relationships").upsert(
              {
                brokerage_id: recruit.brokerage_id,
                agent_id: agentId,
                sponsor_agent_id: sponsorId,
                relationship_type: "sponsor",
                ...edgeTerms,
                depth_level: ((sponsorEdge as any)?.depth_level ?? 0) + 1,
                is_active: true,
              },
              { onConflict: "agent_id,brokerage_id,relationship_type" }
            )
          }
        }
      }
    }

    // Mark recruit as provisioned
    await service.from("recruits").update({
      provisioned: true,
      provisioned_at: new Date().toISOString(),
      provisioned_user_id: resolvedUserId,
      updated_at: new Date().toISOString(),
    }).eq("id", recruitId)

    // Activity log
    await bestEffort(
      service.from("activities").insert({
        activity_type: "recruiting.agent_provisioned",
        agent_user_id: user.id,
        brokerage_id: recruit.brokerage_id,
        title: `Agent provisioned from recruit: ${recruit.first_name} ${recruit.last_name}`,
        notes: JSON.stringify({ recruit_id: recruitId, new_user_id: resolvedUserId, agent_id: agentId }),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
      "the users, agents and recruits rows are already provisioned above; an audit echo must not fail a provisioning that has already created a live login",
    )

    // MANAGERS TALKING — the Recruiting Manager tells the Deal Coordinator a recruit just
    // became an ACTIVE AGENT (provisioned users+agents rows). No contacts are involved at
    // this stage — the Deal Coordinator consumes by setting up first-deal onboarding
    // support (learning path + welcome), governed and recorded.
    if (agentId && resolvedUserId) {
      try {
        const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
        await publishManagerSignal({
          brokerageId: recruit.brokerage_id,
          fromManager: "recruiting_manager",
          toManager: "deal_coordinator",
          signalType: "recruit_activated",
          message: `${recruit.first_name} ${recruit.last_name} just became an active agent — over to you for first-deal onboarding support.`,
          entityType: "recruit",
          entityId: recruit.id,
          payload: { agent_id: agentId, user_id: resolvedUserId },
        }, service)
      } catch (err) {
        console.error("[provision-agent] recruit_activated signal failed:", err)
      }
    }

    // Tenant transition audit (immutable cross-tenant log — migration 038)
    await service.from("tenant_transition_log").insert({
      actor_user_id: user.id,
      action: "provision_recruit",
      entity_type: "recruit",
      entity_id: recruit.id,
      from_brokerage_id: null,
      to_brokerage_id: recruit.brokerage_id,
      row_count_moved: 1,
      metadata: {
        new_user_id: resolvedUserId,
        agent_id: agentId,
        email: recruit.email,
      },
    }).then(() => {}, () => {})

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

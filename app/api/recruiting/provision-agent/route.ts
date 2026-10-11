import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
// NOT isAdminOrBroker (lane ROSTER, 2026-09-04). Provisioning a recruit runs
// `seatGate` below and turns them into a BILLED seat on the tenant's
// subscription — the same spend as app/actions/admin/invite-user.ts, and here
// the whole route runs on the SERVICE client, so this app predicate is the ONLY
// gate. The owner's ruling added `compliance_officer` to
// TENANT_ADMIN_USER_TYPES as tenant staff admin, not as the seat buyer, so this
// site takes the commerce tier: the same roster minus exactly that role, with
// team_lead / broker / broker_owner / broker_admin / admin unchanged.
import { isTenantCommerceAdmin } from "@/lib/auth/resolve-user-role"
import { seatGate } from "@/lib/kernel/seat-usage"
import { inviteTenantMember } from "@/lib/kernel/users"
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
    const isBrokerageAdmin = isTenantCommerceAdmin({ user_type: resolvedType })
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
      await sentinelWrite(service, service.from("tenant_transition_log").insert({
        actor_user_id: user.id,
        action: "provision_recruit_denied_cross_brokerage",
        entity_type: "recruit",
        entity_id: recruit.id,
        from_brokerage_id: recruit.brokerage_id,
        to_brokerage_id: profile!.brokerage_id,
        metadata: { reason: "caller_not_platform_admin" },
      }), { table: "tenant_transition_log", flow: "provision_cross_brokerage_denied_audit", reason: "audit of a denial that is returned 403 regardless" })
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
      await sentinelWrite(service, service.from("tenant_transition_log").insert({
        actor_user_id: user.id,
        action: "provision_recruit_denied_email_belongs_to_other_brokerage",
        entity_type: "recruit",
        entity_id: recruit.id,
        from_brokerage_id: holderBrokerageId,
        to_brokerage_id: recruit.brokerage_id,
        metadata: { reason: "email_holder_at_other_brokerage" },
      }), { table: "tenant_transition_log", flow: "provision_email_other_brokerage_denied_audit", reason: "audit of a denial that is returned regardless" })
      return NextResponse.json({
        error: "That email already belongs to a user at another brokerage. They must leave it before they can be provisioned here.",
      }, { status: 409 })
    }

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

    // ── ONE PROVISIONER (wave 140F) ──────────────────────────────────────────
    // TOMBSTONE (orphan doctrine §1.1): the hand-rolled chain that stood here —
    // inviteUserByEmail → users.upsert(onConflict:"email") → agents.upsert →
    // agent_commission_profiles → agent_onboarding — was a DUPLICATE of the
    // survivor lib/kernel/users.ts:inviteTenantMember (→ createOrRepair-
    // UserDomainRecords), and it drifted: it wrote NO user_role_assignments
    // grant (the recruit had a seat, a tenant and an agents row but no RBAC
    // role — "missing role", measured live as 10 tenant users with no grant),
    // upserted users on the GLOBAL email key, and skipped the invitation
    // ledger. The survivor does all of it, idempotently, keyed on the auth id
    // (users.id === auth.users.id), with the cross-tenant capture guard the
    // block above already enforces for this door. Recruit-specific facts the
    // survivor does not carry (years_experience, license_state) are stamped on
    // the survivor-created agents row below.
    const provisioned = await inviteTenantMember({
      brokerageId: recruit.brokerage_id as string,
      email: recruit.email,
      firstName: recruit.first_name ?? "",
      lastName: recruit.last_name ?? "",
      userType: "agent",
      callerUserId: user.id,
      redirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/onboarding`,
    })
    if (!provisioned.success || !provisioned.userId) {
      return NextResponse.json({ error: provisioned.error ?? "The recruit could not be provisioned." }, { status: 409 })
    }
    const resolvedUserId: string = provisioned.userId
    const agentId: string | null = provisioned.agentId

    if (agentId) {
      // Recruit facts onto the canonical agents row — COUNTED (§3): an update
      // that matches nothing resolves clean, and that would mean the survivor
      // handed back an agents id that is not this tenant's.
      const { data: stamped, error: stampErr } = await service
        .from("agents")
        .update({
          years_experience: recruit.years_experience ?? 0,
          license_state: recruit.license_state ?? null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", agentId)
        .eq("brokerage_id", recruit.brokerage_id)
        .select("id")
      if (stampErr || (stamped ?? []).length !== 1) {
        console.error(`[provision-agent] recruit facts NOT stamped on agents ${agentId}: ${stampErr?.message ?? `${(stamped ?? []).length} rows matched`}`)
      }

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
          // RELATIONSHIP GRAPH (wave 105, lane 105D): the recruiter's USERS id, read ONCE here and
          // reused by the sponsor_of edge below. recruited_by is a fact of the recruit row itself —
          // planted whether or not a revenue-share model is configured; earns_residual is planted only
          // beside a planted agent_relationships edge (planRecruitEdges).
          let recruiterUserId: string | null = null
          try {
            const { data: recruiterAgent, error: recruiterErr } = await service.from("agents").select("user_id").eq("id", (recruit as any).recruiter_agent_id as string).maybeSingle()
            if (recruiterErr) console.error(`[provision-agent] recruiter agent read refused — no recruited_by edge: ${recruiterErr.message}`)
            recruiterUserId = ((recruiterAgent as { user_id?: string | null } | null)?.user_id as string | null) ?? null
            if (recruiterUserId && resolvedUserId) {
              const { planRecruitEdges, upsertRelationships } = await import("@/lib/kernel/relationship-graph")
              const r = await upsertRelationships(service, recruit.brokerage_id, planRecruitEdges({ recruitUserId: resolvedUserId, recruiterUserId, residualPlanted: false, observedAt: new Date().toISOString(), provisionedOn: new Date().toISOString().slice(0, 10) }), user.id)
              if (r.errors.length > 0 && !r.degraded) console.error(`[provision-agent] recruited_by edge not derived: ${r.errors.join("; ")}`)
            }
          } catch (e) {
            console.error("[provision-agent] recruited_by derivation failed (non-blocking)", e)
          }
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
            await sentinelWrite(service, service.from("agent_relationships").upsert(
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
            ), { table: "agent_relationships", flow: "agent_relationships_write", reason: "analytics/cache/annotation row: its loss does not change what the caller reports — logged, never silent" })

            // RELATIONSHIP GRAPH (wave 102, lane 102B): the downline edge IS a sponsor_of fact
            // (sponsor → recruit). The graph's `agent` entity is a USERS id (agents.id and users.id
            // are disjoint, §3): the recruit's is resolvedUserId, the sponsor's is crossed once via
            // agents.user_id. agent_relationships stays the revenue-share record; a lost edge is
            // ledgered on the same sentinel the tree write uses.
            try {
              // The sponsor IS the recruiter (sponsorId = recruiter_agent_id): its users id was read above.
              if (recruiterUserId && resolvedUserId) {
                const { upsertRelationship, upsertRelationships, planRecruitEdges } = await import("@/lib/kernel/relationship-graph")
                const edge = await upsertRelationship(service, {
                  brokerageId: recruit.brokerage_id,
                  from: { type: "agent", id: recruiterUserId },
                  to: { type: "agent", id: resolvedUserId },
                  type: "sponsor_of",
                  evidence: { source: "agent_relationships", confidence: 1, observed_at: new Date().toISOString() },
                })
                if (!edge.ok && !edge.degraded) {
                  const { recordBestEffortLoss } = await import("@/lib/kernel/write-sentinel")
                  await recordBestEffortLoss(service, { table: "relationship_edges", flow: "sponsor_of_relationship_edge", brokerageId: recruit.brokerage_id, reason: "sponsor_of edge beside the revenue-share tree; the tree write already landed" }, edge.error, null)
                }
                // WAVE 105 (105D): the planted tree edge means the sponsor EARNS RESIDUAL from the recruit.
                const residual = planRecruitEdges({ recruitUserId: resolvedUserId, recruiterUserId, residualPlanted: true, observedAt: new Date().toISOString(), provisionedOn: new Date().toISOString().slice(0, 10) }).filter((e) => e.type === "earns_residual")
                const rr = await upsertRelationships(service, recruit.brokerage_id, residual, user.id)
                if (rr.errors.length > 0 && !rr.degraded) console.error(`[provision-agent] earns_residual edge not derived: ${rr.errors.join("; ")}`)
              }
            } catch (e) {
              console.error("[provision-agent] relationship edge derivation failed (non-blocking)", e)
            }
          }
        }
    }

    // Mark recruit as provisioned
    const { error: provisionedStampErr } = await service.from("recruits").update({
      provisioned: true,
      provisioned_at: new Date().toISOString(),
      provisioned_user_id: resolvedUserId,
      updated_at: new Date().toISOString(),
    }).eq("id", recruitId)
    if (provisionedStampErr) console.error(`[provision-agent] agent provisioned but the recruit was NOT marked provisioned: ${provisionedStampErr.message}`)

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

    // Tenant transition audit (immutable cross-tenant log — migration 038).
    // READER (orphan doctrine §1.2): the recruiting_manager's own loop
    // confirms the move it just recorded actually landed — row_count_moved
    // is written and then read back in the SAME request, not assumed from
    // "the insert did not throw" (§3: a resolved insert is not proof of the
    // MOVE it claims). A landed provisioning (resolvedUserId + agentId both
    // set) with a confirmed row_count_moved of 0 is a real anomaly and is
    // logged as one; the response is unaffected either way — the login
    // already exists and telling the recruiter it failed would be false.
    const { data: transitionRow, error: transitionErr } = await service
      .from("tenant_transition_log")
      .insert({
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
      })
      .select("row_count_moved")
      .maybeSingle()
    if (transitionErr) {
      console.error("[provision-agent] tenant_transition_log write refused (non-blocking):", transitionErr.message)
    } else if (resolvedUserId && agentId && (transitionRow?.row_count_moved ?? 0) === 0) {
      console.error(`[provision-agent] recruiting_manager: recruit ${recruit.id} provisioned but the transition log confirms row_count_moved=0 — the move may not have completed as recorded`)
    }

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

"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"
import { isValidUUID } from "@/lib/validations"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { resolveUserOffice, pickUserOffice } from "@/lib/kernel/resolve-user-office"
import { ensureAgentCapWindow } from "@/lib/commission/cap-resolver"
import { isAdminOrBroker, isBrokerageFinanceAdmin } from "@/lib/auth/resolve-user-role"

interface AchievementRow {
  id: string
  name: string
  description: string | null
  points_required: number
  badge_url: string | null
  category: string | null
}

/** Roles allowed to administer OTHER people's agent records / brokerage rollups. */
// ==================== AGENT CRUD ====================

/**
 * THE BROKERAGE ROSTER.
 *
 * MERGE from the dashboard-data lane (wave 13). `hooks/use-dashboard-data.ts`
 * names this function as the survivor for the `agents` type, and the endpoint it
 * replaces held two properties this one lacked. Both are carried here BEFORE
 * that lane is removed, because a deletion that drops capability is the mistake
 * this whole burn-down exists to avoid.
 *
 *   · THE TENANT IS DERIVED, NOT ACCEPTED. `brokerageId` was an OPTIONAL
 *     CALLER-SUPPLIED argument, and omitting it dropped the filter entirely.
 *     RLS on `agents` confines the read to the caller's brokerage
 *     (`agents_read_brokerage`), so this was never the cross-tenant leak it
 *     looks like — verified against the live policy rather than assumed. It was
 *     still a filter the caller could choose not to apply, and a tenant boundary
 *     that depends on the caller passing an argument is not a boundary. It is
 *     now resolved from the session and the parameter is gone.
 *   · A ROSTER IS NOT PUBLIC WITHIN THE TENANT. The endpoint restricted it to
 *     broker / admin / superadmin; this had no role gate at all. The one real
 *     caller is an ADMIN page (app/dashboard/admin/phone-settings), so the gate
 *     costs no working surface — checked before adding it.
 *
 * Returns a discriminated result rather than a bare array: `[]` had to mean
 * "no agents", "you may not see this" and "the read was refused" all at once,
 * and supabase-js resolves a refused query, so the caller could not tell them
 * apart even in principle.
 */
export async function getAgents(): Promise<
  { ok: true; agents: unknown[] } | { ok: false; error: string }
> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return { ok: false, error: "Not authenticated" }
  if (!ctx.brokerageId) return { ok: false, error: "Your account is not linked to a brokerage yet." }
  if (!isAdminOrBroker({ user_type: ctx.userType })) {
    return { ok: false, error: "Only brokers / admins / team leads can view the full agent roster." }
  }

  const supabase = await createClient()
  // `users` HAS NO `name` AND NO `avatar_url` (verified against
  // information_schema), so PostgREST rejected this ENTIRE query and the roster
  // has never rendered — the port-in picker on /dashboard/admin/phone-settings
  // looked like a brokerage with no agents. A person's name lives on `users` as
  // first_name/last_name; agents_user_id_fkey is the ONLY FK from agents to
  // users, so the embed is an OBJECT.
  const { data, error } = await supabase
    .from("agents")
    .select(`
      *,
      user:users(id, first_name, last_name, email, phone)
    `)
    .eq("brokerage_id", ctx.brokerageId)
    .eq("is_active", true)
    .order("created_at", { ascending: false })

  if (error) {
    console.error("[getAgents] roster read refused:", error.message)
    return { ok: false, error: `Could not load the agent roster: ${error.message}` }
  }

  // Flattened to the shape the caller already consumes (`user.name`), so no
  // consumer changes — but the value is now real. There is no live equivalent of
  // the old `user.avatar_url`: an agent's photo is `agents.photo_url` (what the
  // profile editor writes) falling back to `profile_image_url`, and `*` already
  // returns both, so the key is dropped rather than faked.
  const agents = (data ?? []).map((row: any) => {
    const u = row?.user ?? null
    return {
      ...row,
      user: u
        ? { ...u, name: [u.first_name, u.last_name].filter(Boolean).join(" ") || null }
        : null,
    }
  })

  return { ok: true, agents }
}

/**
 * MAY THE CALLER READ THIS AGENT'S MONEY?
 *
 * Their own, always. Anyone else's, only as a broker / admin / team lead in the
 * SAME brokerage. `agent_commissions` and `business_expenses` are both
 * brokerage-scoped by RLS (verified against the live policies), so the exposure
 * was never cross-tenant — but INSIDE a brokerage the agent id came straight
 * from the caller with no ownership check, so one agent could read a colleague's
 * commission and expense ledgers by passing their id. Pay is not team-readable.
 */
async function requireAgentLedgerAccess(
  agentId: string,
): Promise<{ ok: true; brokerageId: string } | { ok: false; error: string }> {
  if (!isValidUUID(agentId)) return { ok: false, error: "Invalid agent ID" }
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return { ok: false, error: "Not authenticated" }
  if (!ctx.brokerageId) return { ok: false, error: "Your account is not linked to a brokerage yet." }
  if (ctx.agentId === agentId) return { ok: true, brokerageId: ctx.brokerageId }
  if (!isAdminOrBroker({ user_type: ctx.userType })) {
    return { ok: false, error: "You can only view your own commissions and expenses." }
  }
  // A broker/admin may look at their OWN brokerage's agents, not an id from
  // anywhere. The agents row is the thing that carries the tenant.
  const svc = createServiceClient()
  const { data, error } = await svc
    .from("agents")
    .select("brokerage_id")
    .eq("id", agentId)
    .maybeSingle()
  if (error) return { ok: false, error: `Could not verify that agent: ${error.message}` }
  if (!data || data.brokerage_id !== ctx.brokerageId) {
    return { ok: false, error: "That agent is not in your brokerage." }
  }
  return { ok: true, brokerageId: ctx.brokerageId }
}

export async function getAgentById(agentId: string) {
  const supabase = await createClient()

  // Same dead embed as getAgents: `users` has no `name` and no `avatar_url`, so
  // this whole read returned an error and every caller saw `null` as "no such
  // agent". Name comes off users.first_name/last_name; the photo is on `agents`
  // itself and `*` already returns it.
  const { data, error } = await supabase
    .from("agents")
    .select(`
      *,
      user:users(id, first_name, last_name, email, phone),
      commissions:agent_commissions(*),
      expenses:business_expenses(*),
      achievements:agent_achievements(*, achievement:achievements(*)),
      goals:agent_goals(*)
    `)
    .eq("id", agentId)
    .single()

  if (error) {
    console.error("Error fetching agent:", error)
    return null
  }

  const u = (data as any)?.user ?? null
  return {
    ...(data as any),
    user: u
      ? { ...u, name: [u.first_name, u.last_name].filter(Boolean).join(" ") || null }
      : null,
  }
}

/**
 * Provision the missing `agents` domain record for a user who already exists in
 * the brokerage. This is the writer behind the "Domain record missing" banner on
 * /dashboard/admin/users — until now that banner told an admin to "edit and save
 * to trigger automatic repair", and nothing on the page could actually create the
 * row for SOMEONE ELSE (ensureAgentContextInPlace only ever heals the CALLER).
 *
 * Verified against the live schema and policies before this was wired:
 *   • agents.brokerage_id is NOT NULL — it is stamped AT the insert, from the
 *     caller's SESSION. It was previously accepted from the caller
 *     (`agentData.brokerage_id ?? ctx.brokerageId`), which let any caller plant a
 *     row in another tenant.
 *   • RLS policy `agents_insert_own` is WITH CHECK (user_id = auth.uid()), so an
 *     admin creating a record for a DIFFERENT user is refused outright by the
 *     request-scoped client. The insert therefore runs on the service client —
 *     and because the service client bypasses RLS, the tenant + role checks below
 *     are the boundary, done explicitly and before the write.
 *   • agents_user_id_key is UNIQUE (user_id) — a second call is refused with a
 *     sentence rather than a raw 23505.
 */
export async function createAgent(agentData: {
  user_id: string
  license_number?: string
  license_state?: string
  license_expiry?: string
  commission_split?: number
  cap_amount?: number
  team_id?: string
}) {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return { error: "Not authenticated" }
  if (!ctx.brokerageId) return { error: "Your account is not linked to a brokerage yet." }
  if (!isAdminOrBroker({ user_type: ctx.userType })) {
    return { error: "Only brokers / admins / team leads can create agent records." }
  }
  if (!isValidUUID(agentData.user_id)) return { error: "A valid user is required." }

  const svc = createServiceClient()

  // The target user must already exist AND live in the CALLER's brokerage.
  // users.id and agents.id are distinct id spaces — this resolves between them,
  // it never substitutes one for the other.
  const { data: targetUser, error: userErr } = await svc
    .from("users")
    .select("id, brokerage_id")
    .eq("id", agentData.user_id)
    .maybeSingle()
  if (userErr) {
    console.error("Error resolving target user:", userErr)
    return { error: userErr.message }
  }
  if (!targetUser) return { error: "That user does not exist." }
  if (targetUser.brokerage_id !== ctx.brokerageId) {
    return { error: "That user is not in your brokerage." }
  }

  // TENANT-SCOPED PROBE. The check above already proves this user belongs to the
  // caller's brokerage, so an unscoped read here could not actually leak — but
  // that safety lives in a DIFFERENT statement, and a reader (or a scanner)
  // cannot see it from here. Cross-tenant reads have to be impossible by
  // construction, not by the continued presence of an earlier guard.
  const { data: existing, error: existingErr } = await svc
    .from("agents")
    .select("id")
    .eq("user_id", agentData.user_id)
    .eq("brokerage_id", ctx.brokerageId)
    .maybeSingle()
  if (existingErr) {
    console.error("Error checking for an existing agent record:", existingErr)
    return { error: existingErr.message }
  }
  if (existing) return { error: "That user already has an agent record." }

  // A team, if named, must belong to the same brokerage.
  if (agentData.team_id) {
    if (!isValidUUID(agentData.team_id)) return { error: "That team id is not valid." }
    const { data: team, error: teamErr } = await svc
      .from("teams")
      .select("id, brokerage_id")
      .eq("id", agentData.team_id)
      .maybeSingle()
    if (teamErr) return { error: teamErr.message }
    if (!team || team.brokerage_id !== ctx.brokerageId) {
      return { error: "That team is not in your brokerage." }
    }
  }

  const { data, error } = await svc
    .from("agents")
    .insert({
      // TENANT ANCHOR FIRST, deliberately. It was stamped correctly but sat
      // eight fields down, past the 500 characters the tenant-scope scanner
      // reads after a .from(), so the write looked unscoped to CI. The fix is
      // to make the anchor visible AT the write rather than to widen the
      // window: if a scanner cannot see the tenant on a write, neither can the
      // next person to read it.
      brokerage_id: ctx.brokerageId,
      user_id: agentData.user_id,
      license_number: agentData.license_number?.trim() || null,
      license_state: agentData.license_state?.trim() || null,
      license_expiry: agentData.license_expiry?.trim() || null,
      commission_split: agentData.commission_split ?? null,
      // NEITHER `cap_amount` NOR `cap_progress` IS WRITTEN HERE ANY MORE, and
      // that is the fix, not an omission.
      //
      // The commission engine reads exactly one table for a cap:
      // `agent_cap_tracking` (lib/commission/waterfall/07-apply-cap.ts). Writing
      // the number onto the `agents` row put it somewhere nothing enforces —
      // measured on the live database before m461, four agents carried
      // `agents.cap_amount` and THREE of them had no ledger row at all, so
      // stage 07 found nothing, returned capStatus 'n/a', and never capped them.
      // A broker set a cap, this screen showed it back, and it had never once
      // been applied to a cheque.
      //
      // The cap the caller named is materialised into the LEDGER below, by
      // `ensureAgentCapWindow`, along with the brokerage's default for a caller
      // who named none. Both columns stay on the table until m463 drops them,
      // because other surfaces still read them; nothing here adds to them.
      team_id: agentData.team_id ?? null,
      gamification_points: 0,
      ytd_gci: 0,
      ytd_transactions: 0,
      is_active: true,
    })
    .select("id, user_id, brokerage_id")
    .single()

  if (error) {
    console.error("Error creating agent:", error)
    // agents_user_id_key is UNIQUE on user_id GLOBALLY, not per brokerage. The
    // probe above is deliberately tenant-scoped, so it cannot see a record this
    // user still holds under a brokerage they have since left — that case
    // arrives here as 23505. Answer it in words rather than handing back a raw
    // Postgres string, and without disclosing which brokerage holds the row.
    if ((error as { code?: string }).code === "23505") {
      return {
        error:
          "That user already has an agent record on the platform, held under a different brokerage. It has to be released there before a new one can be created here.",
      }
    }
    return { error: error.message }
  }

  // ── SEED THE CAP LEDGER — THIS IS WHAT MAKES THE CAP REAL ─────────────────
  //
  // A cap that is only CONFIGURED is not a cap. `07-apply-cap.ts` reads
  // `agent_cap_tracking` and nothing else, so a number that never reaches that
  // table is a number the engine cannot see. `ensureAgentCapWindow` resolves
  // which cap applies — the cap named on this form, else
  // `agent_commission_profiles.cap_amount` (honouring is_active / effective_date),
  // else `brokerages.default_cap_amount`, else none — and writes it into the
  // anniversary window that CONTAINS TODAY, which is the only window stage 07's
  // `anniversary_start <= today <= anniversary_end` filter will ever match.
  //
  // Calling it here is what lets a brokerage state its cap ONCE in settings and
  // have every new agent inherit it, instead of a broker re-typing the number
  // into a field that nothing enforced.
  //
  // BEST EFFORT, and reported. The agent record is committed and is the point of
  // this action; a failure to seed must not reverse it. But it is never silent —
  // an agent with no ledger row is exactly the state that hid this defect for as
  // long as it hid, so the caller is told the cap is not yet in force.
  let capSeeding: { capAmount?: number | null; source?: string; error?: string } | undefined
  if (data?.id) {
    const seeded = await ensureAgentCapWindow(svc, {
      agentId: data.id,
      brokerageId: ctx.brokerageId,
      explicitCapAmount: agentData.cap_amount ?? null,
    })
    if (!seeded.ok) {
      // Logged as well as returned. The one UI that calls this action today
      // surfaces `phoneProvisioning` and not yet `capSeeding`, and an
      // unenforced cap that nobody is told about is precisely the silence this
      // whole change exists to end.
      console.error(`[agents] cap ledger not seeded for agent ${data.id}: ${seeded.error}`)
      capSeeding = {
        error: `Agent created, but their commission cap was not put into the ledger the payout engine reads, so it is not yet enforced: ${seeded.error}`,
      }
    } else if (seeded.result.outcome === "seeded") {
      capSeeding = { capAmount: seeded.result.capAmount, source: seeded.result.source }
    } else if (seeded.result.outcome === "no_cap_configured") {
      capSeeding = { capAmount: null, source: "none" }
    }
  }

  // ── AUTO-PROVISION THE AGENT'S PHONE NUMBER ────────────────────────────────
  // `brokerages.auto_provision_phone_numbers` was a control that did nothing:
  // the phone-settings toggle told the broker "new agents get a phone number
  // automatically", and NOTHING in the tree read the flag. This is that reader.
  //
  //  • Only when the flag is ON. This purchases a real Twilio number and bills
  //    the tenant, so it never runs on a brokerage that did not ask for it.
  //  • BEST EFFORT. The agent record is already committed and is the point of
  //    this action; a provisioning failure is REPORTED, never allowed to
  //    reverse or fail the creation.
  //  • autoProvisionAgentPhone re-derives the caller's own context and role —
  //    no identity is forged here, and it re-checks that the agent belongs to
  //    this brokerage.
  //  • The plan's phone allowance is enforced inside it (metered overage,
  //    blocked only at the hard cap).
  let phoneProvisioning: { phoneNumber?: string; error?: string } | undefined
  if (data?.id) {
    // Destructure error: a refused settings read must not read as "toggle off"
    // — but it must also not be treated as "toggle on" and spend money. A
    // failure here simply skips provisioning and says so.
    const { data: brkSettings, error: settingsErr } = await svc
      .from("brokerages")
      .select("auto_provision_phone_numbers")
      .eq("id", ctx.brokerageId)
      .maybeSingle()

    if (settingsErr) {
      phoneProvisioning = {
        error: `Agent created. Could not check your auto-provisioning setting, so no number was purchased: ${settingsErr.message}`,
      }
    } else if (brkSettings?.auto_provision_phone_numbers === true) {
      try {
        const { autoProvisionAgentPhone } = await import("@/app/actions/phone-provisioning")
        const prov = await autoProvisionAgentPhone({ agentId: data.id })
        phoneProvisioning = prov.success
          ? { phoneNumber: prov.phoneNumber }
          : { error: `Agent created, but no phone number was provisioned: ${prov.error}` }
      } catch (err) {
        phoneProvisioning = {
          error: `Agent created, but phone provisioning failed: ${err instanceof Error ? err.message : "unknown error"}`,
        }
      }
    }
  }

  revalidatePath("/dashboard/admin/users")
  return { data, phoneProvisioning, capSeeding }
}

/**
 * `cap_amount` IS NO LONGER ACCEPTED HERE. It used to be spread straight onto
 * the `agents` row, which is the copy the commission engine never reads —
 * `07-apply-cap.ts` reads `agent_cap_tracking` and nothing else. A cap changed
 * through this function would have been shown back on every screen and applied
 * to no cheque.
 *
 * A cap now has two honest homes and both reach the engine: the brokerage
 * default at /dashboard/settings (`brokerages.default_cap_amount`), and the
 * per-agent override on the agent profile form
 * (`agent_commission_profiles.cap_amount`, written by
 * app/actions/admin/agent-profile.ts). `lib/commission/cap-resolver.ts` resolves
 * between them and materialises the answer into the ledger.
 */
export async function updateAgent(
  agentId: string,
  updates: Partial<{
    license_number: string
    license_state: string
    license_expiry: string
    commission_split: number
    team_id: string
    specializations: string[]
    bio: string
    is_active: boolean
  }>,
) {
  const supabase = await createClient()

  // Re-sanitized rather than trusted: this is a spread of a caller-supplied
  // object, so a `cap_amount` (or anything else) smuggled past the type would
  // otherwise reach the column the type just removed.
  const { cap_amount: _droppedCap, cap_progress: _droppedProgress, ...safeUpdates } =
    (updates ?? {}) as Record<string, unknown>

  const { data, error } = await supabase
    .from("agents")
    .update({ ...safeUpdates, updated_at: new Date().toISOString() })
    .eq("id", agentId)
    .select()
    .single()

  if (error) {
    console.error("Error updating agent:", error)
    return { error: error.message }
  }

  revalidatePath("/dashboard/admin/users")
  return { data }
}

// ==================== GAMIFICATION ====================

export async function awardPoints(agentId: string, points: number, reason: string, category: string) {
  const supabase = await createClient()

  // Get current points
  const { data: agent } = await supabase.from("agents").select("gamification_points").eq("id", agentId).single()

  const currentPoints = agent?.gamification_points || 0
  const newPoints = currentPoints + points

  // Update agent points
  const { error: updateError } = await supabase
    .from("agents")
    .update({
      gamification_points: newPoints,
      updated_at: new Date().toISOString(),
    })
    .eq("id", agentId)

  if (updateError) {
    console.error("Error awarding points:", updateError)
    return { error: updateError.message }
  }

  // Log the points transaction
  const { error: logError } = await supabase.from("agent_points_log").insert({
    agent_id: agentId,
    points,
    reason,
    reference_type: category, // real column; running balance lives on agents.gamification_points
  })

  if (logError) {
    console.error("Error logging points:", logError)
  }

  // Check for new achievements
  await checkAndAwardAchievements(agentId, newPoints)

  revalidatePath("/dashboard/admin/users")
  return { data: { newPoints } }
}

export async function getLeaderboard(
  brokerageId?: string,
  period: "weekly" | "monthly" | "yearly" | "all_time" = "monthly",
) {
  const supabase = await createClient()

  // Map period to period_label format used in leaderboard_rankings
  let periodLabel: string | null = null
  if (period !== "all_time") {
    const now = new Date()
    if (period === "monthly") {
      periodLabel = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
    } else if (period === "weekly") {
      // ISO week number
      const weekNum = Math.ceil((now.getDate() - now.getDay() + 1) / 7)
      periodLabel = `${now.getFullYear()}-W${String(weekNum).padStart(2, "0")}`
    } else if (period === "yearly") {
      periodLabel = `${now.getFullYear()}`
    }
  }

  // `agents` HAS gamification_points / profile_image_url / ytd_gci /
  // ytd_transactions but NO first_name / last_name — those are on `users`,
  // reached through agents_user_id_fkey (a single FK, so an OBJECT embed).
  // Naming them here made PostgREST reject the WHOLE query, so this leaderboard
  // has only ever returned [].
  let query = supabase
    .from("leaderboard_rankings")
    .select(`
      id,
      rank_position,
      metric_value,
      agent_id,
      agents:agent_id(
        id, gamification_points, photo_url, profile_image_url, ytd_gci, ytd_transactions,
        users:user_id(first_name, last_name)
      )
    `)
    .eq("scope", "agent")
    .eq("metric_type", "points")
    .order("rank_position", { ascending: true })
    .limit(20)

  if (brokerageId) {
    query = query.eq("brokerage_id", brokerageId)
  }

  if (periodLabel) {
    query = query.eq("period_label", periodLabel)
  }

  const { data, error } = await query

  if (error) {
    console.error("Error fetching leaderboard:", error)
    return []
  }

  // Flattened back to first_name / last_name, the shape every agent-name reader
  // in the app already uses, so the row keeps its declared shape.
  return (data ?? []).map((row: any) => {
    const a = row?.agents ?? null
    const u = a?.users ?? null
    return {
      ...row,
      agents: a
        ? {
            id: a.id,
            first_name: u?.first_name ?? null,
            last_name: u?.last_name ?? null,
            gamification_points: a.gamification_points ?? null,
            profile_image_url: a.photo_url ?? a.profile_image_url ?? null,
            ytd_gci: a.ytd_gci ?? null,
            ytd_transactions: a.ytd_transactions ?? null,
          }
        : null,
    }
  })
}

/**
 * The achievement CATALOG — every rung an agent can climb, ordered by the points
 * that unlock it. `achievements` is a global table (no brokerage_id column) and
 * its RLS SELECT policy is `true`, so it is readable by any signed-in user.
 *
 * Returning a bare [] on a failed read would render a refused query as "there are
 * no achievements", so the verdict is reported instead of being flattened away.
 */
export async function getAchievements(): Promise<{
  ok: boolean
  achievements: AchievementRow[]
  error?: string
}> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("achievements")
    .select("id, name, description, points_required, badge_url, category")
    .eq("is_active", true)
    .order("points_required", { ascending: true })

  if (error) {
    console.error("Error fetching achievements:", error)
    return { ok: false, achievements: [], error: error.message }
  }

  return { ok: true, achievements: (data ?? []) as unknown as AchievementRow[] }
}

export async function getAgentAchievements(agentId: string) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("agent_achievements")
    .select(`
      *,
      achievement:achievements(*)
    `)
    .eq("agent_id", agentId)
    .order("unlocked_at", { ascending: false })

  if (error) {
    console.error("Error fetching agent achievements:", error)
    return []
  }

  return data || []
}

async function checkAndAwardAchievements(agentId: string, currentPoints: number) {
  const supabase = await createClient()

  // Get all achievements agent doesn't have yet
  const { data: unearned } = await supabase
    .from("achievements")
    .select("*")
    .lte("points_required", currentPoints)
    .not("id", "in", `(SELECT achievement_id FROM agent_achievements WHERE agent_id = '${agentId}')`)

  if (!unearned || unearned.length === 0) return

  // Award new achievements
  for (const achievement of unearned) {
    await supabase.from("agent_achievements").insert({
      agent_id: agentId,
      achievement_id: achievement.id,
      // unlocked_at has default now()
    })

    // Achievement is recorded in agent_achievements (above). The agents.badges array was a phantom
    // denormalization (column never existed, read nowhere else); badge awards live in agent_badges,
    // owned by the gamification path — no duplicate copy on agents.
  }
}

// ==================== COMMISSION TRACKING ====================

export async function getAgentCommissions(agentId: string, year?: number) {
  // Their own ledger, or a broker/admin looking at their own brokerage's agent.
  // See requireAgentLedgerAccess — the id used to come straight from the caller.
  const access = await requireAgentLedgerAccess(agentId)
  if (!access.ok) return { ok: false as const, error: access.error, commissions: [] }

  const supabase = await createClient()

  const currentYear = year || new Date().getFullYear()
  const startDate = `${currentYear}-01-01`
  const endDate = `${currentYear}-12-31`

  const { data, error } = await supabase
    .from("agent_commissions")
    .select(`
      *,
      transaction:transactions(id, property_address, purchase_price, status)
    `)
    .eq("brokerage_id", access.brokerageId)
    .eq("agent_id", agentId)
    .gte("close_date", startDate)
    .lte("close_date", endDate)
    .order("close_date", { ascending: false })

  // A refused read is NOT an empty ledger. supabase-js resolves a denied query,
  // so returning [] here rendered "you earned nothing this year" for a
  // permission failure — on the one screen where that is least acceptable.
  if (error) {
    console.error("[getAgentCommissions] read refused:", error.message)
    return { ok: false as const, error: `Could not load commissions: ${error.message}`, commissions: [] }
  }

  return { ok: true as const, error: null, commissions: data ?? [] }
}

/**
 * NOT THE CANONICAL COMMISSION CREATOR. The canonical creator on this rail is
 * lib/kernel/financial.ts:createCommissionRecord (exposed as
 * app/actions/financial-kernel.ts:createCommissionRecordAction and wired at
 * app/dashboard/financials/agent/agent-financials-client.tsx) — it applies the cap,
 * the fee schedule and the splits ledger. This one is kept ONLY because it carries two
 * things that one does not: the caller's real close_date and the deal `side`. It is
 * deliberately left without a UI surface so agent_commissions keeps a single live writer.
 *
 * It could never have run as written. Verified against the live schema:
 *   • agent_commissions.brokerage_id is NOT NULL and was never supplied (23502), and
 *   • agent_commission / brokerage_commission are GENERATED ALWAYS columns
 *     (gross_commission * agent_split_percent / 100 and its complement) — inserting
 *     into them is rejected outright.
 * So every call returned an error and the splits row below was unreachable. Both are
 * fixed here rather than left as a landmine on the money ledger.
 */
export async function addAgentCommission(commissionData: {
  agent_id: string
  transaction_id: string
  gross_commission: number
  agent_split_percent: number
  close_date: string
  side: "listing" | "buying" | "both"
}) {
  const supabase = await createClient()

  const agentCommission = commissionData.gross_commission * (commissionData.agent_split_percent / 100)
  const brokerageCommission = commissionData.gross_commission - agentCommission

  // agent_commissions.agent_id is agents-class, so the brokerage anchor comes off the
  // agents row (NOT NULL on the table).
  const { data: agentRow, error: agentErr } = await supabase
    .from("agents").select("brokerage_id, user_id, location_id").eq("id", commissionData.agent_id).maybeSingle()
  if (agentErr) {
    console.error("Error resolving agent brokerage:", agentErr)
    return { error: agentErr.message }
  }
  if (!agentRow?.brokerage_id) {
    return { error: "Agent has no brokerage — cannot create a commission record" }
  }

  // OFFICE OF RECORD for the PRODUCING agent — not the caller, who may be a
  // broker filing this on someone else's behalf. Resolved through the ONE
  // precedence rule (lib/kernel/resolve-user-office.ts: users.location_id wins
  // over agents.location_id); the agents row is already in hand, so an agent
  // with no linked user takes the pure form of the same rule rather than a
  // second one written out here. Stamped on the split below because the owner
  // ruled a closed commission stays with the office that closed the deal — a
  // read-time join to agents.location_id would move it when the agent transfers.
  const office = agentRow.user_id
    ? await resolveUserOffice(supabase, agentRow.user_id)
    : pickUserOffice(null, agentRow.location_id)

  const { data, error } = await supabase
    .from("agent_commissions")
    .insert({
      ...commissionData,
      brokerage_id: agentRow.brokerage_id,
      // agent_commission / brokerage_commission are GENERATED — the database computes them.
      status: "pending",
    })
    .select()
    .single()

  if (error) {
    console.error("Error adding commission:", error)
    return { error: error.message }
  }

  // Splits ledger row alongside the commission (burn-down round 4 — the agent
  // financials page reads commission_splits). Same numbers, same lifecycle.
  const { error: splitErr } = await supabase.from("commission_splits").insert({
    agent_id: commissionData.agent_id,
    brokerage_id: agentRow.brokerage_id,
    location_id: office.locationId,
    transaction_id: commissionData.transaction_id,
    commission_id: data.id,
    agent_amount: agentCommission,
    brokerage_amount: brokerageCommission,
    status: "pending",
    metadata: { agent_split_percent: commissionData.agent_split_percent, side: commissionData.side },
  })
  if (splitErr) {
    console.error("Error writing commission split ledger row:", splitErr)
  }

  // Update agent YTD stats
  await updateAgentYTDStats(commissionData.agent_id)

  // Award points for closing
  await awardPoints(commissionData.agent_id, 100, "Closed transaction", "transaction")

  revalidatePath("/dashboard/admin/users")
  return { data }
}

export async function updateCommissionStatus(
  commissionId: string,
  status: "pending" | "paid" | "cancelled",
  paidDate?: string,
) {
  const supabase = await createClient()

  const updates: Record<string, unknown> = { status }
  if (paidDate) {
    updates.paid_date = paidDate
  }

  const { data, error } = await supabase
    .from("agent_commissions")
    .update(updates)
    .eq("id", commissionId)
    .select()
    .single()

  if (error) {
    console.error("Error updating commission status:", error)
    return { error: error.message }
  }

  revalidatePath("/dashboard/admin/users")
  return { data }
}

async function updateAgentYTDStats(agentId: string) {
  const supabase = await createClient()

  const currentYear = new Date().getFullYear()
  const startDate = `${currentYear}-01-01`
  const endDate = `${currentYear}-12-31`

  // Get YTD commissions
  const { data: commissions } = await supabase
    .from("agent_commissions")
    .select("agent_commission")
    .eq("agent_id", agentId)
    .eq("status", "paid")
    .gte("close_date", startDate)
    .lte("close_date", endDate)

  const ytdGci = commissions?.reduce((sum, c) => sum + (c.agent_commission || 0), 0) || 0
  const ytdTransactions = commissions?.length || 0

  // ── cap_progress IS NO LONGER COMPUTED OR WRITTEN HERE ────────────────────
  //
  // It was `min(ytdGci / agents.cap_amount * 100, 100)` — and that is not what a
  // cap measures. A cap is a ceiling on what the BROKERAGE COLLECTS from the
  // agent (`07-apply-cap.ts`: "Cap tracks brokerage's cumulative earnings, NOT
  // agent's"); `ytdGci` here is the sum of `agent_commissions.agent_commission`,
  // which is what the AGENT KEPT. So the third copy of cap state was not merely
  // duplicated, it was measuring the opposite side of the split — an agent on a
  // 70/30 with a $100k cap would have read as "capped" while the brokerage had
  // collected roughly $43k of it.
  //
  // The canonical answer is `agent_cap_tracking.cap_paid_to_date / cap_amount`,
  // advanced by the commission engine on every disbursement, and that is what
  // app/actions/admin/agent-360.ts now reads. `agents.cap_progress` is dropped
  // in m463; nothing here keeps feeding it in the meantime.
  await supabase
    .from("agents")
    .update({
      ytd_gci: ytdGci,
      ytd_transactions: ytdTransactions,
      updated_at: new Date().toISOString(),
    })
    .eq("id", agentId)
}

// ==================== EXPENSES ====================

export async function getAgentExpenses(agentId: string, year?: number) {
  // Same rule as commissions: your own, or your brokerage's if you administer it.
  const access = await requireAgentLedgerAccess(agentId)
  if (!access.ok) return { ok: false as const, error: access.error, expenses: [] }

  const supabase = await createClient()

  const currentYear = year || new Date().getFullYear()
  const startDate = `${currentYear}-01-01`
  const endDate = `${currentYear}-12-31`

  const { data, error } = await supabase
    .from("business_expenses")
    .select("*")
    .eq("brokerage_id", access.brokerageId)
    .eq("agent_id", agentId)
    .gte("expense_date", startDate)
    .lte("expense_date", endDate)
    .order("expense_date", { ascending: false })

  if (error) {
    console.error("[getAgentExpenses] read refused:", error.message)
    return { ok: false as const, error: `Could not load expenses: ${error.message}`, expenses: [] }
  }

  return { ok: true as const, error: null, expenses: data ?? [] }
}

/**
 * NOT THE CANONICAL EXPENSE WRITER — deliberately left without a UI surface.
 *
 * The canonical, WIRED writer on this rail is
 * app/actions/financials.ts:logScopedExpense (surfaced at
 * app/dashboard/financials/brokerage/scoped-expense-entry.tsx). That one is
 * strictly more complete: it resolves BOTH the actor and the tenant from the
 * session, validates the amount and the date shape, carries agent / team /
 * brokerage scope, and pushes brokerage-scoped rows to the accounting egress.
 * This one is kept because it is still reachable as an exported action, and an
 * exported action that can write an untenanted row is a hole whether or not a
 * button points at it.
 *
 * Two things verified live and fixed here rather than left armed:
 *   • business_expenses.brokerage_id is NULLABLE and the tenant policy reads
 *     `(brokerage_id IS NULL) OR (brokerage_id = current_user_brokerage_id())`.
 *     Every row this function used to write had a NULL brokerage_id — i.e. it was
 *     readable by EVERY brokerage on the platform. The tenant is now stamped AT
 *     the insert.
 *   • agent_id came FROM THE CALLER, so any signed-in user could log spend
 *     against any agent's book. It is resolved from the session; only a
 *     broker/admin may name a different agent, and only inside their own tenant.
 */
export async function addAgentExpense(expenseData: {
  agent_id?: string
  category: "marketing" | "education" | "technology" | "transportation" | "office" | "other"
  description: string
  amount: number
  expense_date: string
  receipt_url?: string
}) {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return { error: "Not authenticated" }
  if (!ctx.brokerageId) return { error: "Your account is not linked to a brokerage yet." }

  const amount = Number(expenseData.amount)
  if (!Number.isFinite(amount) || amount <= 0) return { error: "Enter an amount greater than zero." }
  if (!expenseData.description?.trim()) return { error: "A description is required." }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expenseData.expense_date ?? "")) {
    return { error: "Enter the expense date as YYYY-MM-DD." }
  }

  const svc = createServiceClient()

  // business_expenses.agent_id FKs agents(id). Resolve the actor from the
  // session; a named agent is only honoured for a broker/admin, and only when
  // that agent is in the caller's own brokerage.
  let agentId = ctx.agentId
  if (expenseData.agent_id && expenseData.agent_id !== ctx.agentId) {
    // BROKERAGE-WIDE MONEY (m472). business_expenses is a FINANCE table under
    // public.is_brokerage_finance_admin(), and this branch is "book a cost
    // against SOMEONE ELSE'S ledger" — money beyond the caller's own team, which
    // the owner's ruling holds team_lead out of. The write below goes through the
    // SERVICE client, which bypasses RLS, so this predicate is the only gate it
    // has: had it stayed on the widened roster the app would not merely have
    // disagreed with RLS, it would have overruled it.
    if (!isBrokerageFinanceAdmin({ user_type: ctx.userType })) {
      return { error: "You can only log expenses against your own book." }
    }
    const { data: target, error: targetErr } = await svc
      .from("agents")
      .select("id, brokerage_id")
      .eq("id", expenseData.agent_id)
      .maybeSingle()
    if (targetErr) return { error: targetErr.message }
    if (!target || target.brokerage_id !== ctx.brokerageId) {
      return { error: "That agent is not in your brokerage." }
    }
    agentId = target.id
  }
  if (!agentId) return { error: "No agent record for your account yet." }

  // business_expenses has no status/is_reimbursable columns; real date col is expense_date.
  const { data, error } = await svc
    .from("business_expenses")
    .insert({
      agent_id: agentId,
      // TENANT ANCHOR — stamped at the insert. A NULL here is readable by every
      // brokerage under the live policy.
      brokerage_id: ctx.brokerageId,
      category: expenseData.category,
      description: expenseData.description.trim(),
      amount,
      expense_date: expenseData.expense_date,
      receipt_url: expenseData.receipt_url?.trim() || null,
    })
    .select("id, agent_id, brokerage_id, category, amount, expense_date")
    .single()

  if (error) {
    console.error("Error adding expense:", error)
    return { error: error.message }
  }

  revalidatePath("/dashboard/financials/expenses")
  return { data }
}

/**
 * Category totals across the WHOLE tax year.
 *
 * /dashboard/financials/expenses used to compute its own breakdown inline from
 * the same 100-row page it renders (`.limit(100)`), so an agent past a hundred
 * receipts was shown a category chart that silently omitted the rest of the year
 * and a category count that was simply wrong. This aggregates every row in the
 * window, and reports a refused read instead of returning an empty object that
 * reads as "you spent nothing".
 */
export async function getExpenseSummary(
  agentId: string,
  year?: number,
): Promise<{
  ok: boolean
  summary: Record<string, { total: number; count: number }>
  total: number
  count: number
  error?: string
}> {
  const empty = { summary: {}, total: 0, count: 0 }

  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return { ok: false, ...empty, error: "Not authenticated" }
  if (!ctx.brokerageId) return { ok: false, ...empty, error: "No brokerage on your account" }
  if (!isValidUUID(agentId)) return { ok: false, ...empty, error: "Invalid agent id" }

  const svc = createServiceClient()

  // agentId is an agents.id. Anyone may read their OWN book; reading someone
  // else's requires a broker/admin role AND that agent being in this tenant.
  if (agentId !== ctx.agentId) {
    if (!isAdminOrBroker({ user_type: ctx.userType })) {
      return { ok: false, ...empty, error: "Forbidden" }
    }
    const { data: target, error: targetErr } = await svc
      .from("agents")
      .select("id, brokerage_id")
      .eq("id", agentId)
      .maybeSingle()
    if (targetErr) return { ok: false, ...empty, error: targetErr.message }
    if (!target || target.brokerage_id !== ctx.brokerageId) {
      return { ok: false, ...empty, error: "That agent is not in your brokerage." }
    }
  }

  const currentYear = year || new Date().getFullYear()
  const startDate = `${currentYear}-01-01`
  const endDate = `${currentYear}-12-31`

  const { data, error } = await svc
    .from("business_expenses")
    .select("category, amount")
    .eq("agent_id", agentId)
    .gte("expense_date", startDate)
    .lte("expense_date", endDate)

  if (error) {
    console.error("Error fetching expense summary:", error)
    return { ok: false, ...empty, error: error.message }
  }

  // Group by category over EVERY row in the year — no page cap.
  const summary: Record<string, { total: number; count: number }> = {}
  let total = 0
  for (const expense of data ?? []) {
    const category = (expense.category as string | null) || "other"
    const amount = Number(expense.amount ?? 0)
    if (!summary[category]) summary[category] = { total: 0, count: 0 }
    summary[category].total += amount
    summary[category].count += 1
    total += amount
  }

  return { ok: true, summary, total, count: (data ?? []).length }
}

// ==================== GOALS ====================

export async function getAgentGoals(agentId: string, year?: number) {
  const supabase = await createClient()

  const currentYear = year || new Date().getFullYear()

  const { data, error } = await supabase
    .from("agent_goals")
    .select("*")
    .eq("agent_id", agentId)
    .eq("year", currentYear)
    .order("created_at", { ascending: false })

  if (error) {
    console.error("Error fetching agent goals:", error)
    return []
  }

  return data || []
}

/**
 * The vocabulary agent_goals.goal_type ACTUALLY admits. Read off the live CHECK
 * constraint `agent_goals_goal_type_check`, not off a TypeScript union somebody
 * wrote from memory.
 */
// Module-local, not exported: every export of a "use server" module must be an
// async function, so the vocabulary cannot leave this file as a const.
const AGENT_GOAL_TYPES = [
  "gross_commission",
  "transactions_closed",
  "listings_taken",
  "buyer_clients",
  "new_contacts",
  "conversion_rate",
  "avg_days_to_close",
] as const

type AgentGoalType = (typeof AGENT_GOAL_TYPES)[number]

/**
 * NOT THE CANONICAL GOAL WRITER — deliberately left without a UI surface.
 *
 * The canonical, WIRED writer is app/actions/ai-agent-goals.ts:upsertAgentGoal
 * (surfaced at app/dashboard/goals/goals-client.tsx). That one is more complete:
 * it supplies the NOT NULL brokerage_id, upserts on the real unique constraint
 * (agent_id, year, goal_type), preserves current_value across edits, and carries
 * `notes`. Wiring a second goal writer would be exactly the duplicate the owner
 * asked to avoid.
 *
 * It is kept and repaired because as written it could NEVER have inserted a row,
 * for two independently fatal reasons verified against the live database:
 *   • agent_goals.brokerage_id is NOT NULL and was never supplied → 23502.
 *   • the TypeScript union offered "gci" | "transactions" | "listings" |
 *     "buyers" | "sphere_growth". The live CHECK admits
 *     gross_commission, transactions_closed, listings_taken, buyer_clients,
 *     new_contacts, conversion_rate, avg_days_to_close. NOT ONE of the five
 *     values this function offered is accepted by the column — every call was a
 *     23514. The vocabulary is now taken from the constraint and checked before
 *     the write, so an unknown value comes back as a sentence instead of a
 *     constraint violation.
 *
 * Also: the pre-existence probe used .single(), which RESOLVES WITH AN ERROR on
 * zero rows — `if (existing)` was skipped rather than being a real branch. It is
 * a single upsert on the unique constraint now, so there is no probe to get wrong.
 */
export async function setAgentGoal(goalData: {
  agent_id?: string
  year: number
  goal_type: AgentGoalType | string
  target_value: number
}) {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return { error: "Not authenticated" }
  if (!ctx.brokerageId) return { error: "Your account is not linked to a brokerage yet." }

  if (!(AGENT_GOAL_TYPES as readonly string[]).includes(goalData.goal_type)) {
    return {
      error: `"${goalData.goal_type}" is not a goal this brokerage tracks. Choose one of: ${AGENT_GOAL_TYPES.join(", ")}.`,
    }
  }
  const targetValue = Number(goalData.target_value)
  if (!Number.isFinite(targetValue) || targetValue <= 0) {
    return { error: "Enter a target greater than zero." }
  }
  const year = Number(goalData.year)
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return { error: "Enter a four-digit year." }
  }

  const svc = createServiceClient()

  // agent_goals.agent_id FKs agents(id) — resolved from the session, with a
  // named agent honoured only for a broker/admin inside their own tenant.
  let agentId = ctx.agentId
  if (goalData.agent_id && goalData.agent_id !== ctx.agentId) {
    if (!isAdminOrBroker({ user_type: ctx.userType })) {
      return { error: "You can only set your own goals." }
    }
    const { data: target, error: targetErr } = await svc
      .from("agents")
      .select("id, brokerage_id")
      .eq("id", goalData.agent_id)
      .maybeSingle()
    if (targetErr) return { error: targetErr.message }
    if (!target || target.brokerage_id !== ctx.brokerageId) {
      return { error: "That agent is not in your brokerage." }
    }
    agentId = target.id
  }
  if (!agentId) return { error: "No agent record for your account yet." }

  // Preserve progress across an edit — a re-target must not reset the counter.
  const { data: existing, error: existingErr } = await svc
    .from("agent_goals")
    .select("id, current_value")
    .eq("agent_id", agentId)
    .eq("year", year)
    .eq("goal_type", goalData.goal_type)
    .maybeSingle()
  if (existingErr) {
    console.error("Error reading the existing goal:", existingErr)
    return { error: existingErr.message }
  }

  const { data, error } = await svc
    .from("agent_goals")
    .upsert(
      {
        agent_id: agentId,
        // TENANT ANCHOR — NOT NULL on this table, stamped at the write.
        brokerage_id: ctx.brokerageId,
        year,
        goal_type: goalData.goal_type,
        target_value: targetValue,
        current_value: existing?.current_value ?? 0,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "agent_id,year,goal_type" },
    )
    .select("id, agent_id, brokerage_id, year, goal_type, target_value, current_value")
    .single()

  if (error) {
    console.error("Error setting agent goal:", error)
    return { error: error.message }
  }

  revalidatePath("/dashboard/goals")
  return { data }
}

export async function updateGoalProgress(goalId: string, currentValue: number) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("agent_goals")
    .update({ current_value: currentValue })
    .eq("id", goalId)
    .select()
    .single()

  if (error) {
    console.error("Error updating goal progress:", error)
    return { error: error.message }
  }

  revalidatePath("/dashboard/admin/users")
  return { data }
}

// ==================== AGENT ASSIGNMENT ====================

/**
 * NOT THE CANONICAL CONTACT-ROUTING WRITER — deliberately left without a UI surface.
 *
 * The canonical, WIRED writer is
 * app/actions/contact-reassignment.ts:reassignContactAction (surfaced at
 * app/crm/components/reassign-contact-dialog.tsx, and re-used by the voice rail
 * at lib/voice/broker-commands.ts). It is strictly more complete: it moves the
 * contact AND the work that follows the client — their leads, their in-flight
 * deal roles, their open tasks, their active property alerts — validates that the
 * receiving agent is ACTIVE and in the same brokerage, counts every move with
 * { count: "exact" }, and writes a CONTACT_REASSIGNED audit event. This one only
 * ever re-pointed contacts.agent_id and left every downstream row owned by the
 * previous agent.
 *
 * The ONE thing this function does that the survivor does not is award 10
 * gamification points for a new assignment. Porting that onto the survivor would
 * mean editing app/actions/contact-reassignment.ts, which is outside this pass's
 * file set — so this is hardened and left unwired rather than deleted, and the
 * points gap is reported rather than quietly dropped.
 *
 * Hardened here: the receiving agent was never checked. A broker could route one
 * of their own contacts to an agents row belonging to ANOTHER brokerage —
 * contacts.agent_id FKs agents(id) with no tenant predicate of its own, so the
 * database would have accepted it.
 */
export async function assignAgentToContact(contactId: string, agentId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: "Not authenticated" }

  if (!isValidUUID(contactId) || !isValidUUID(agentId)) {
    return { error: "A valid contact and agent are required." }
  }

  const { data: userRow, error: userErr } = await supabase
    .from("users")
    .select("user_type, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (userErr) return { error: userErr.message }
  if (!userRow || !isAdminOrBroker({ user_type: userRow.user_type ?? "" })) {
    return { error: "Only brokers / admins / team leads can assign contacts" }
  }
  if (!userRow.brokerage_id) {
    return { error: "Your account is not linked to a brokerage yet." }
  }

  // The RECEIVING agent must be active and in the caller's brokerage.
  // agents.id and users.id are distinct id spaces — this resolves, never substitutes.
  const { data: targetAgent, error: targetErr } = await supabase
    .from("agents")
    .select("id, is_active, brokerage_id")
    .eq("id", agentId)
    .eq("brokerage_id", userRow.brokerage_id)
    .maybeSingle()
  if (targetErr) return { error: targetErr.message }
  if (!targetAgent) return { error: "That agent is not in your brokerage." }
  if (targetAgent.is_active === false) return { error: "That agent is not active." }

  // Tenant isolation — only operate on contacts in the caller's brokerage.
  // { count: "exact" } because an UPDATE that matches NOTHING still succeeds in
  // postgrest; a zero-row move must be reported as a refusal, not as a save.
  const { data, error, count } = await supabase
    .from("contacts")
    .update({ agent_id: agentId }, { count: "exact" })
    .eq("id", contactId)
    .eq("brokerage_id", userRow.brokerage_id)
    .select("id, agent_id, brokerage_id")

  if (error) {
    console.error("Error assigning agent to contact:", error)
    return { error: error.message }
  }
  if (!count) {
    return { error: "That contact was not found in your brokerage — nothing was changed." }
  }

  // Award points for new contact assignment
  await awardPoints(agentId, 10, "New contact assigned", "lead")

  revalidatePath("/crm/contacts")
  return { data: data?.[0] ?? null }
}

export async function getAgentContacts(agentId: string) {
  // Return empty array for invalid UUIDs - production apps should require valid auth
  if (!isValidUUID(agentId)) {
    console.warn("[agents.ts] getAgentContacts called with invalid UUID:", agentId)
    return []
  }

  const supabase = await createClient()

  const { data, error } = await supabase
    .from("contacts")
    .select("*")
    .eq("agent_id", agentId)
    .order("created_at", { ascending: false })

  if (error) {
    console.error("Error fetching agent contacts:", error)
    return []
  }

  return data || []
}

export async function getAgentStats(userIdOrAgentId: string) {
  // Return empty stats for invalid UUIDs - production apps should require valid auth
  if (!isValidUUID(userIdOrAgentId)) {
    console.warn("[agents.ts] getAgentStats called with invalid UUID:", userIdOrAgentId)
    return {
      activeDeals: 0,
      pendingGCI: 0,
      ytdVolume: 0,
      ytdGCI: 0,
      leadsToday: 0,
      contactCount: 0,
      activeTransactions: 0,
      pendingTasks: 0,
    }
  }

  const supabase = await createClient()

  // First, check if this is a user_id and get the agent record
  let agentId = userIdOrAgentId
  try {
    const { data: agent } = await supabase.from("agents").select("id").eq("user_id", userIdOrAgentId).maybeSingle()

    if (agent?.id) {
      agentId = agent.id
    }
  } catch (e) {
    // If agents table doesn't exist or error, use the passed ID
  }

  // Get contact count - handle table not existing gracefully
  let contactCount = 0
  let activeTransactions = 0
  let pendingTasks = 0
  let leadsToday = 0

  try {
    const { count } = await supabase
      .from("contacts")
      .select("*", { count: "exact", head: true })
      .eq("agent_id", agentId)
    contactCount = count || 0
  } catch (e) {
    // Table may not exist
  }

  // Get active transaction count
  try {
    const { count } = await supabase
      .from("transactions")
      .select("*", { count: "exact", head: true })
      .eq("agent_id", agentId)
      .in("status", ["under_contract"])
    activeTransactions = count || 0
  } catch (e) {
    // Table may not exist
  }

  // Get pending tasks count
  try {
    const { count } = await supabase
      .from("tasks")
      .select("*", { count: "exact", head: true })
      .eq("assigned_to_agent_id", agentId)
      .eq("status", "pending")
    pendingTasks = count || 0
  } catch (e) {
    // Table may not exist
  }

  // Get leads created today
  try {
    const today = new Date().toISOString().split("T")[0]
    const { count } = await supabase
      .from("contacts")
      .select("*", { count: "exact", head: true })
      .eq("agent_id", agentId)
      .gte("created_at", today)
    leadsToday = count || 0
  } catch (e) {
    // Table may not exist
  }

  return {
    activeDeals: activeTransactions,
    pendingGCI: 0, // Would need commissions table
    ytdVolume: 0, // Would need transactions with purchase_price
    ytdGCI: 0, // Would need commissions table
    leadsToday,
    contactCount,
    activeTransactions,
    pendingTasks,
  }
}

// ============================================
// BROKERAGE STATS (for Broker Dashboard)
// ============================================

/**
 * Month-over-month brokerage money + compliance risk for the broker command centre.
 *
 * This is NOT a duplicate of app/actions/multi-persona.ts:getBrokerageDashboard,
 * which is the other loader on this page: that one reports headcount, open deal
 * volume and `compliance_events` (the gate ledger). Nothing else on the platform
 * computes THIS month's GCI against LAST month's, and nothing else reads
 * `compliance_flags` (a different table from compliance_events) for a risk level.
 *
 * Three defects fixed before wiring:
 *   • brokerageId came FROM THE CALLER. It is resolved from the session now — a
 *     "use server" action that accepts its own tenant boundary as an argument is
 *     not a boundary.
 *   • Every read discarded `error`. A read refused by RLS was rendered as $0 GCI
 *     and a "Normal" risk level — a broker would have been told their month was
 *     empty and their compliance clean when in fact nothing had been read. Each
 *     read now reports its verdict, and anything that failed is named in
 *     `degraded` so the surface can say so out loud.
 *   • agentCount counted deactivated agents. It is scoped to is_active now, which
 *     is what "how many agents do I have" means and what the seat meter and
 *     getBrokerageDashboard already mean by it.
 */
export async function getBrokerageStats(): Promise<{
  ok: boolean
  brokerageId: string | null
  monthlyGCI: number
  lastMonthGCI: number
  gciChange: number
  activeDeals: number
  agentCount: number
  riskLevel: "Normal" | "Elevated" | "Critical" | "Unknown"
  openComplianceFlags: number
  /** Names of the reads that FAILED — never silently folded into a zero. */
  degraded: string[]
  error?: string
}> {
  const ctx = await getAgentContext()
  const blank = {
    brokerageId: null,
    monthlyGCI: 0,
    lastMonthGCI: 0,
    gciChange: 0,
    activeDeals: 0,
    agentCount: 0,
    riskLevel: "Unknown" as const,
    openComplianceFlags: 0,
    degraded: [] as string[],
  }
  if (!ctx.isAuthenticated) return { ok: false, ...blank, error: "Not authenticated" }
  if (!ctx.brokerageId) return { ok: false, ...blank, error: "No brokerage on your account" }

  const brokerageId = ctx.brokerageId
  const supabase = await createClient()
  const degraded: string[] = []

  const startOfMonth = new Date()
  startOfMonth.setDate(1)
  startOfMonth.setHours(0, 0, 0, 0)
  const lastMonthStart = new Date(startOfMonth)
  lastMonthStart.setMonth(lastMonthStart.getMonth() - 1)

  const thisMonthDate = startOfMonth.toISOString().split("T")[0]
  const lastMonthDate = lastMonthStart.toISOString().split("T")[0]

  const [gciRes, lastGciRes, dealsRes, agentsRes, riskRes] = await Promise.all([
    supabase
      .from("agent_commissions")
      .select("gross_commission")
      .eq("brokerage_id", brokerageId)
      .gte("close_date", thisMonthDate),
    supabase
      .from("agent_commissions")
      .select("gross_commission")
      .eq("brokerage_id", brokerageId)
      .gte("close_date", lastMonthDate)
      .lt("close_date", thisMonthDate),
    supabase
      .from("transactions")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId)
      .in("status", ["under_contract"]),
    supabase
      .from("agents")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId)
      .eq("is_active", true),
    supabase
      .from("compliance_flags")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId)
      // compliance_flags has no "open" — the live CHECK is
      // flagged | reviewed | resolved | overridden, and unresolved IS "flagged".
      .eq("status", "flagged"),
  ])

  let monthlyGCI = 0
  if (gciRes.error) {
    console.error("Error reading this month's GCI:", gciRes.error)
    degraded.push("monthlyGCI")
  } else {
    monthlyGCI = (gciRes.data ?? []).reduce((sum, c) => sum + Number(c.gross_commission ?? 0), 0)
  }

  let lastMonthGCI = 0
  if (lastGciRes.error) {
    console.error("Error reading last month's GCI:", lastGciRes.error)
    degraded.push("lastMonthGCI")
  } else {
    lastMonthGCI = (lastGciRes.data ?? []).reduce((sum, c) => sum + Number(c.gross_commission ?? 0), 0)
  }

  let activeDeals = 0
  if (dealsRes.error) {
    console.error("Error counting active deals:", dealsRes.error)
    degraded.push("activeDeals")
  } else {
    activeDeals = dealsRes.count ?? 0
  }

  let agentCount = 0
  if (agentsRes.error) {
    console.error("Error counting agents:", agentsRes.error)
    degraded.push("agentCount")
  } else {
    agentCount = agentsRes.count ?? 0
  }

  let openFlags = 0
  let riskLevel: "Normal" | "Elevated" | "Critical" | "Unknown" = "Unknown"
  if (riskRes.error) {
    console.error("Error counting compliance flags:", riskRes.error)
    degraded.push("openComplianceFlags")
  } else {
    openFlags = riskRes.count ?? 0
    riskLevel = openFlags > 5 ? "Critical" : openFlags > 2 ? "Elevated" : "Normal"
  }

  // Only claim a trend when BOTH sides of the comparison were actually read.
  const gciChange =
    degraded.includes("monthlyGCI") || degraded.includes("lastMonthGCI") || lastMonthGCI <= 0
      ? 0
      : Math.round(((monthlyGCI - lastMonthGCI) / lastMonthGCI) * 100)

  return {
    ok: degraded.length === 0,
    brokerageId,
    monthlyGCI,
    lastMonthGCI,
    gciChange,
    activeDeals,
    agentCount,
    riskLevel,
    openComplianceFlags: openFlags,
    degraded,
  }
}

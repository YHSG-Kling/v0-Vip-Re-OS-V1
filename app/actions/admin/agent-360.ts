"use server"

/**
 * Agent 360 — the manager's full view of one agent, assembled from the rails
 * that already exist (keep-one, no new pipelines):
 *
 *   production   — agents denormalized YTD stats (updateAgentYTDStats maintains
 *                  ytd_gci / ytd_transactions) + a live active-transactions
 *                  count + the CAP, read from `agent_cap_tracking`
 *
 * ── WHERE THE CAP COMES FROM, AND WHY IT MOVED ──────────────────────────────
 * This panel used to read `agents.cap_amount` and `agents.cap_progress`. Both
 * are the losing copy of a fact stored in three places, and neither is what the
 * commission engine acts on: `lib/commission/waterfall/07-apply-cap.ts` reads
 * `agent_cap_tracking` and nothing else, and
 * `app/actions/ai-financial-management.ts:291` had already declared that ledger
 * canonical.
 *
 * The gap was not academic. Measured on the live database before m461, four
 * agents carried `agents.cap_amount` and THREE had no `agent_cap_tracking` row
 * at all — so this panel showed a manager a cap that the payout engine had never
 * once enforced. The fourth disagreed with itself: `agents.cap_amount` said
 * 100,000 while the ledger said 80,000 with 72,500 collected. Two numbers, one
 * truth, and this screen was showing the one nobody was paid against.
 *
 * PROGRESS IS NOW `cap_paid_to_date / cap_amount` FROM THE LEDGER, and it is a
 * different quantity from the one it replaces in more than provenance: the old
 * `agents.cap_progress` was `ytd_gci / cap_amount`, i.e. what the AGENT KEPT
 * measured against a ceiling on what the BROKERAGE COLLECTS. The ledger's
 * `cap_paid_to_date` is the brokerage's side, which is the side the cap is about.
 *   goals        — agent_goals for the current year (target vs current;
 *                  syncGoalCurrentValues keeps current_value fresh)
 *   payments     — commissions ledger (the payouts flow's table): paid rows are
 *                  the receipts, pending rows show what's owed. NOTE: a legacy
 *                  agent_commissions twin also exists (agent-facing YTD/CSV
 *                  readers) — consolidating the pair needs its own dependency
 *                  sweep; this view reads the payout-lifecycle table.
 *   gamification — agents.gamification_points + tier (same thresholds as
 *                  getAgentPointsAndTier), earned badges, recent points log
 *
 * Authorization mirrors agent-profile.ts: broker / broker_admin / admin /
 * superadmin / team_lead, and the target must be in the caller's brokerage.
 * The commission-agreement e-sign status renders via the existing
 * CommissionAgreementCard on the same page.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"
import { TRANSACTION_STATUSES_OPEN } from "@/lib/transactions/transaction-status"
import {
  pickCapAmount,
  resolveAnniversaryWindow,
  windowContains,
  normalizeCapAnniversaryBasis,
  type CapSource,
} from "@/lib/commission/cap-resolver"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"
import { tierLabelForPoints } from "@/lib/gamification/tiers"

export interface Agent360Goal {
  goalType: string
  targetValue: number
  currentValue: number
  year: number
}

export interface Agent360Payment {
  id: string
  status: string
  agentCommission: number
  grossCommission: number
  depositReceivedAt: string | null
  createdAt: string
}

export interface Agent360Badge {
  name: string
  icon: string | null
  tier: string | null
  awardedAt: string
}

export interface Agent360 {
  agentId: string
  production: {
    ytdGci: number
    ytdTransactions: number
    /**
     * `agent_cap_tracking.cap_paid_to_date` — DOLLARS the brokerage has already
     * collected toward this agent's cap in the current anniversary window. NULL
     * when there is no ledger row, i.e. no cap in force.
     *
     * THE UNITS CHANGED AND THAT IS A FIX. `agents.cap_progress` was a
     * PERCENTAGE (0-100), while the panel that renders this
     * (app/dashboard/admin/users/[userId]/agent-360-panels.tsx:44) has always
     * printed it as `usd(capProgress) of usd(capAmount)` and computed its own
     * percentage from `capProgress / capAmount`. An agent 72.5% of the way to a
     * $100,000 cap therefore rendered as "$72.50 of $100,000" at 0%. Feeding it
     * the ledger's dollars makes the display it already had correct.
     */
    capProgress: number | null
    /** `agent_cap_tracking.cap_amount` for the window containing today — the cap
     *  the payout engine will actually apply. NULL means genuinely uncapped. */
    capAmount: number | null
    /**
     * TRUE when a ledger row covers today, i.e. the cap above is one the payout
     * engine can see. FALSE with a non-null `capConfigured` is the exact defect
     * this consolidation exists to end: a cap agreed with the agent that the
     * engine has never applied to a cheque.
     */
    capEnforced: boolean
    /**
     * What the CONFIGURED cap resolves to today — per-agent
     * `agent_commission_profiles.cap_amount`, else
     * `brokerages.default_cap_amount`, else null. Reported alongside the ledger
     * so a manager can see the two agree, or see that they do not.
     */
    capConfigured: number | null
    /** Where `capConfigured` came from, so the manager can go and change it. */
    capConfiguredSource: CapSource
    /** The anniversary window in force today, inclusive at both ends — the year
     *  the cap above is measured over. NULL when it could not be resolved. */
    capWindow: { start: string; end: string } | null
    activeTransactions: number
  }
  goals: Agent360Goal[]
  payments: {
    paid: Agent360Payment[]
    /** Genuinely OWED (status 'pending') — disputed rows are tracked separately. */
    pending: Agent360Payment[]
    disputed: Agent360Payment[]
    totalPaid: number
    totalPending: number
    totalDisputed: number
  }
  gamification: {
    points: number
    tier: string
    badges: Agent360Badge[]
    recentPoints: Array<{ points: number; reason: string | null; createdAt: string }>
  }
  /** agent_onboarding row (null = never started — "apply" creates it). */
  onboarding: {
    status: string
    completionPercentage: number
    currentDay: number | null
    certified: boolean
  } | null
  /** Agent-recruiting downline — the tenant decides the program via
   *  brokerages.recruiting_split_to_agent / recruiting_monthly_fee. */
  downline: {
    programOffered: boolean
    splitToAgent: number | null
    monthlyFee: number | null
    joinedCount: number
    recruits: Array<{ name: string; status: string; provisioned: boolean; createdAt: string }>
  }
  academy: {
    assignments: Array<{ moduleId: string; title: string; status: string }>
    availableModules: Array<{ id: string; title: string }>
  }
}

/**
 * THE ONE POINTS-TIER LADDER — lib/gamification/tiers.ts. This was a fourth
 * hand-written copy of the thresholds: three sites agreed on 500/2500/10000/25000
 * and the Motivation page used 0/1000/5000/15000, so a manager and the agent
 * themselves could be shown different tiers for the same number. The base rung was
 * also spelled three ways across those copies ("Rookie" here, "none" in
 * getAgentPointsAndTier and on /dashboard/intelligence); it is "Unranked" now, in
 * one place.
 */
const tierFor = tierLabelForPoints

export async function getAgent360Action(
  targetUserId: string,
): Promise<{ ok: true; data: Agent360 | null } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }
  const { data: caller } = await supabase
    .from("users")
    .select("user_type, role, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  const callerRole = (caller?.user_type ?? caller?.role ?? "") as string
  if (!isAdminOrBroker({ user_type: callerRole })) return { ok: false, error: "Forbidden" }
  if (!caller?.brokerage_id) return { ok: false, error: "No brokerage on your profile" }

  const svc = createServiceClient()

  // Resolve the target's agent row inside the caller's brokerage — non-agents
  // (TC, vendor, staff) simply have no 360; the page shows the base profile.
  const { data: agent } = await svc
    .from("agents")
    // `created_at` — NOT `start_date`, which does not exist on this table. It is
    // the anchor the anniversary window is rolled forward from.
    .select("id, created_at, ytd_gci, ytd_transactions, gamification_points")
    .eq("user_id", targetUserId)
    .eq("brokerage_id", caller.brokerage_id)
    .maybeSingle()
  if (!agent) return { ok: true, data: null }

  const year = new Date().getFullYear()
  const today = new Date().toISOString().slice(0, 10)
  const [goalsRes, commissionsRes, badgesRes, pointsLogRes, activeTxRes,
         onboardingRes, brokerageRes, recruitsRes, assignmentsRes, modulesRes,
         capRes, capProfileRes] = await Promise.all([
    svc.from("agent_goals")
      .select("goal_type, target_value, current_value, year")
      .eq("agent_id", agent.id)
      .eq("year", year)
      .order("goal_type"),
    // KEEP-ONE (m283): agent_commissions is the canonical commission ledger —
    // 25 consumers, the full dispute/approval lifecycle, and now a superset of
    // the retired `commissions` columns (fees/net/cap + deposit lifecycle).
    svc.from("agent_commissions")
      .select("id, status, agent_commission, gross_commission, deposit_received_at, created_at")
      .eq("agent_id", agent.id)
      .eq("brokerage_id", caller.brokerage_id)
      .order("created_at", { ascending: false })
      .limit(50),
    svc.from("agent_badges")
      .select("awarded_at, gamification_badges ( badge_name, badge_icon, badge_tier )")
      .eq("agent_id", agent.id)
      .order("awarded_at", { ascending: false })
      .limit(12),
    svc.from("agent_points_log")
      .select("points, reason, created_at")
      .eq("agent_id", agent.id)
      .order("created_at", { ascending: false })
      .limit(5),
    svc.from("transactions")
      .select("id", { count: "exact", head: true })
      .eq("agent_id", agent.id)
      .in("status", [...TRANSACTION_STATUSES_OPEN]),
    svc.from("agent_onboarding")
      .select("status, completion_percentage, current_day, certification_achieved")
      .eq("agent_id", agent.id)
      .eq("brokerage_id", caller.brokerage_id)
      .maybeSingle(),
    svc.from("brokerages")
      .select("created_at, recruiting_split_to_agent, recruiting_monthly_fee, default_cap_amount, default_cap_anniversary_basis")
      .eq("id", caller.brokerage_id)
      .maybeSingle(),
    svc.from("recruits")
      .select("first_name, last_name, status, provisioned, created_at")
      .eq("recruiter_agent_id", agent.id)
      .eq("brokerage_id", caller.brokerage_id)
      .order("created_at", { ascending: false })
      .limit(25),
    svc.from("learning_assignments")
      .select("module_id, status, learning_modules ( title )")
      .eq("agent_user_id", targetUserId)
      .eq("brokerage_id", caller.brokerage_id)
      .limit(50),
    svc.from("learning_modules")
      .select("id, title")
      .eq("brokerage_id", caller.brokerage_id)
      .eq("status", "published")
      .order("title")
      .limit(100),
    // THE CANONICAL CAP LEDGER, filtered exactly the way
    // lib/commission/waterfall/07-apply-cap.ts filters it — the window that
    // CONTAINS TODAY. Any other window is a closed year and would show a manager
    // last year's ceiling. Tenant-anchored on brokerage_id as well as agent_id.
    svc.from("agent_cap_tracking")
      .select("cap_amount, cap_paid_to_date, is_capped, anniversary_start, anniversary_end")
      .eq("brokerage_id", caller.brokerage_id)
      .eq("agent_id", agent.id)
      .lte("anniversary_start", today)
      .gte("anniversary_end", today)
      .limit(1),
    // THE CONFIGURED cap, so the panel can say when configuration and ledger
    // disagree. Same tenant anchor; same precedence the seeder uses, because it
    // is the same function.
    svc.from("agent_commission_profiles")
      .select("cap_amount, is_active, effective_date")
      .eq("brokerage_id", caller.brokerage_id)
      .eq("agent_id", agent.id),
  ])

  const allCommissions = (commissionsRes.data ?? []).map((c: any): Agent360Payment => ({
    id: c.id,
    status: c.status ?? "pending",
    agentCommission: Number(c.agent_commission) || 0,
    grossCommission: Number(c.gross_commission) || 0,
    depositReceivedAt: c.deposit_received_at ?? null,
    createdAt: c.created_at,
  }))
  // Live agent_commissions.status CHECK vocabulary is pending | approved | paid |
  // disputed, and the lifecycle is pending → approved → paid (lib/kernel/financial.ts:
  // COMMISSION_TRANSITIONS). BOTH pending and approved are genuinely OWED — 'approved'
  // means authorized to disburse but not yet disbursed, which is still money the agent
  // is due. Every other consumer already pairs them (financial-kernel's agent summary,
  // auto-dispute's eligibility filter, loadCommissionQueue's workflow list); this panel
  // was the outlier, and treating approved as neither owed nor paid dropped those rows
  // out of the manager's view entirely. A disputed commission is contested rather than
  // payable, so it keeps its own bucket and stays out of the owed total.
  const OWED_STATUSES = new Set(["pending", "approved"])
  const paid = allCommissions.filter(c => c.status === "paid")
  const pending = allCommissions.filter(c => OWED_STATUSES.has(c.status))
  const disputed = allCommissions.filter(c => c.status === "disputed")

  const badges = (badgesRes.data ?? []).map((b: any): Agent360Badge => {
    const def = Array.isArray(b.gamification_badges) ? b.gamification_badges[0] : b.gamification_badges
    return {
      name: def?.badge_name ?? "Badge",
      icon: def?.badge_icon ?? null,
      tier: def?.badge_tier ?? null,
      awardedAt: b.awarded_at,
    }
  })

  const points = Number(agent.gamification_points) || 0

  // supabase-js RESOLVES a refused read as an empty list, so "the ledger says
  // nothing" and "we were not allowed to look" would otherwise both render as
  // "no cap set" — and "no cap" is exactly the wrong thing to tell a manager
  // about an agent who has one. The refusal is logged and the values stay NULL,
  // which the panel renders as "no cap set" only when the read succeeded.
  if (capRes.error) {
    console.error(`[agent-360] agent_cap_tracking read refused for agent ${agent.id}: ${capRes.error.message}`)
  }
  const capRow = (capRes.data ?? [])[0] as
    | { cap_amount: unknown; cap_paid_to_date: unknown }
    | undefined
  // numeric arrives from PostgREST as a STRING, and Number("") is 0 — which
  // would report "capped, $0 ceiling" for an unreadable value.
  const capAmount = capRow?.cap_amount != null && capRow.cap_amount !== "" ? Number(capRow.cap_amount) : null
  const capPaid =
    capRow?.cap_paid_to_date != null && capRow.cap_paid_to_date !== "" ? Number(capRow.cap_paid_to_date) : null

  // ── CONFIGURED vs ENFORCED ────────────────────────────────────────────────
  // The whole reason this consolidation exists: a cap can be agreed, displayed
  // and believed while the payout engine never sees it. `capEnforced` is FALSE
  // exactly when there is no ledger row covering today, and `capConfigured` says
  // whether there was nevertheless a cap to enforce. On the live database before
  // m461 that pair read (false, 150000) for three of the four capped agents.
  //
  // Same precedence function the seeder uses — not a second copy of the rules.
  if (capProfileRes.error) {
    console.error(`[agent-360] agent_commission_profiles read refused for agent ${agent.id}: ${capProfileRes.error.message}`)
  }
  const brokerageRow = (brokerageRes.data ?? null) as {
    created_at?: string | null
    default_cap_amount?: unknown
    default_cap_anniversary_basis?: unknown
  } | null

  const configured = pickCapAmount({
    profiles: (capProfileRes.data ?? []) as unknown as Array<{ cap_amount: unknown; is_active: unknown; effective_date: unknown }>,
    brokerageDefaultCap: brokerageRow?.default_cap_amount ?? null,
    today,
  })

  // The window in force today. Prefer the LEDGER's own window when a row exists —
  // that is the year the engine is actually measuring against — and fall back to
  // the window the configured cap WOULD use, so a manager can see when an
  // unenforced cap would start counting.
  let capWindow: { start: string; end: string } | null = null
  const ledgerWindow = (capRes.data ?? [])[0] as { anniversary_start?: string; anniversary_end?: string } | undefined
  if (ledgerWindow?.anniversary_start && ledgerWindow?.anniversary_end) {
    capWindow = { start: ledgerWindow.anniversary_start, end: ledgerWindow.anniversary_end }
  } else {
    const resolved = resolveAnniversaryWindow({
      basis: normalizeCapAnniversaryBasis(brokerageRow?.default_cap_anniversary_basis),
      today,
      agentCreatedAt: (agent as { created_at?: string | null }).created_at ?? null,
      brokerageCreatedAt: brokerageRow?.created_at ?? null,
    })
    // Reported only if it really is the LIVE window. A window that does not
    // contain today is the closed-year bug in miniature, and showing one to a
    // manager as "this cap year" would be the same lie in a smaller font.
    capWindow = resolved.ok && windowContains(resolved.window, today)
      ? { start: resolved.window.start, end: resolved.window.end }
      : null
  }

  return {
    ok: true,
    data: {
      agentId: agent.id as string,
      production: {
        ytdGci: Number(agent.ytd_gci) || 0,
        ytdTransactions: Number(agent.ytd_transactions) || 0,
        // FROM THE LEDGER, never from agents.cap_progress / agents.cap_amount —
        // see the header. Those are the copies the payout engine has never read.
        capProgress: capPaid !== null && Number.isFinite(capPaid) ? capPaid : null,
        capAmount: capAmount !== null && Number.isFinite(capAmount) ? capAmount : null,
        capEnforced: !!capRow,
        capConfigured: configured.capAmount,
        capConfiguredSource: configured.source,
        capWindow,
        activeTransactions: activeTxRes.count ?? 0,
      },
      goals: (goalsRes.data ?? []).map((g: any): Agent360Goal => ({
        goalType: g.goal_type,
        targetValue: Number(g.target_value) || 0,
        currentValue: Number(g.current_value) || 0,
        year: g.year,
      })),
      payments: {
        paid,
        pending,
        disputed,
        totalPaid: paid.reduce((s, c) => s + c.agentCommission, 0),
        totalPending: pending.reduce((s, c) => s + c.agentCommission, 0),
        totalDisputed: disputed.reduce((s, c) => s + c.agentCommission, 0),
      },
      gamification: {
        points,
        tier: tierFor(points),
        badges,
        recentPoints: (pointsLogRes.data ?? []).map((p: any) => ({
          points: Number(p.points) || 0,
          reason: p.reason ?? null,
          createdAt: p.created_at,
        })),
      },
      onboarding: onboardingRes.data
        ? {
            status: (onboardingRes.data.status as string) ?? "in_progress",
            completionPercentage: Number(onboardingRes.data.completion_percentage) || 0,
            currentDay: onboardingRes.data.current_day != null ? Number(onboardingRes.data.current_day) : null,
            certified: !!onboardingRes.data.certification_achieved,
          }
        : null,
      downline: {
        // The tenant offers the program by setting a split — no split, no program.
        programOffered: brokerageRes.data?.recruiting_split_to_agent != null,
        splitToAgent: brokerageRes.data?.recruiting_split_to_agent != null
          ? Number(brokerageRes.data.recruiting_split_to_agent) : null,
        monthlyFee: brokerageRes.data?.recruiting_monthly_fee != null
          ? Number(brokerageRes.data.recruiting_monthly_fee) : null,
        joinedCount: (recruitsRes.data ?? []).filter((r: any) => r.provisioned || r.status === "joined").length,
        recruits: (recruitsRes.data ?? []).map((r: any) => ({
          name: `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim() || "Recruit",
          status: r.status ?? "new",
          provisioned: !!r.provisioned,
          createdAt: r.created_at,
        })),
      },
      academy: {
        assignments: (assignmentsRes.data ?? []).map((a: any) => {
          const mod = Array.isArray(a.learning_modules) ? a.learning_modules[0] : a.learning_modules
          return { moduleId: a.module_id as string, title: mod?.title ?? "Module", status: a.status ?? "open" }
        }),
        availableModules: (modulesRes.data ?? []).map((m: any) => ({ id: m.id as string, title: m.title as string })),
      },
    },
  }
}

// ── Mutations — assign academy classes + apply/pause onboarding ───────────────

async function requireManager(): Promise<
  | { ok: true; brokerageId: string; userId: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }
  const { data: caller } = await supabase
    .from("users").select("user_type, role, brokerage_id").eq("id", user.id).maybeSingle()
  const role = (caller?.user_type ?? caller?.role ?? "") as string
  if (!isAdminOrBroker({ user_type: role })) return { ok: false, error: "Forbidden" }
  if (!caller?.brokerage_id) return { ok: false, error: "No brokerage on your profile" }
  return { ok: true, brokerageId: caller.brokerage_id as string, userId: user.id }
}

/**
 * Assign a published academy module to the agent. Upsert on the live
 * UNIQUE(agent_user_id, module_id) — re-assigning an existing assignment is a
 * friendly no-op, never a duplicate row. Status vocabulary is the live CHECK:
 * new assignments open as 'open'.
 */
export async function assignAcademyModuleAction(
  input: { targetUserId: string; moduleId: string },
): Promise<{ ok: boolean; error?: string; duplicate?: boolean }> {
  const auth = await requireManager()
  if (!auth.ok) return auth
  const svc = createServiceClient()

  // CROSS-TENANT GUARD: the TARGET must belong to the caller's brokerage.
  // Verifying only the module let a manager write a learning_assignments row
  // for a user in another tenant (VADE security finding).
  const { data: targetUser } = await svc
    .from("users")
    .select("id, brokerage_id")
    .eq("id", input.targetUserId)
    .maybeSingle()
  if (!targetUser || targetUser.brokerage_id !== auth.brokerageId) {
    return { ok: false, error: "User not found in your brokerage" }
  }

  const { data: mod } = await svc
    .from("learning_modules")
    .select("id, brokerage_id, status")
    .eq("id", input.moduleId)
    .maybeSingle()
  if (!mod || mod.brokerage_id !== auth.brokerageId) return { ok: false, error: "Module not found in your academy" }
  if (mod.status !== "published") return { ok: false, error: "Module isn't published yet" }

  const { data: existing } = await svc
    .from("learning_assignments")
    .select("id")
    .eq("agent_user_id", input.targetUserId)
    .eq("module_id", input.moduleId)
    .maybeSingle()
  if (existing) return { ok: true, duplicate: true }

  const { error } = await svc.from("learning_assignments").insert({
    brokerage_id: auth.brokerageId,
    module_id: input.moduleId,
    agent_user_id: input.targetUserId,
    signal_source: "manager_assigned",
    status: "open",
  })
  if (error) return { ok: false, error: error.message }
  revalidatePath(`/dashboard/admin/users/${input.targetUserId}`)
  return { ok: true }
}

/**
 * Apply / pause / resume onboarding for the agent ("apply or remove
 * onboarding" — walkthrough [47]). Applying with no row creates one; the live
 * status vocabulary is in_progress | completed | paused, so "remove" is pause.
 */
export async function setAgentOnboardingStatusAction(
  input: { targetUserId: string; status: "in_progress" | "paused" },
): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireManager()
  if (!auth.ok) return auth
  const svc = createServiceClient()

  const { data: agent } = await svc
    .from("agents").select("id")
    .eq("user_id", input.targetUserId)
    .eq("brokerage_id", auth.brokerageId)
    .maybeSingle()
  if (!agent) return { ok: false, error: "No agent record for this user" }

  const { data: existing } = await svc
    .from("agent_onboarding")
    .select("id, status")
    .eq("agent_id", agent.id)
    .eq("brokerage_id", auth.brokerageId)
    .maybeSingle()

  if (!existing) {
    if (input.status === "paused") return { ok: false, error: "Onboarding was never started for this agent" }
    const { error } = await svc.from("agent_onboarding").insert({
      agent_id: agent.id,
      user_id: input.targetUserId,
      brokerage_id: auth.brokerageId,
      status: "in_progress",
      current_day: 1,
      completion_percentage: 0,
      start_date: new Date().toISOString(),
    })
    if (error) return { ok: false, error: error.message }
  } else {
    if (existing.status === "completed") return { ok: false, error: "Onboarding is already completed" }
    const { error } = await svc.from("agent_onboarding")
      .update({ status: input.status, updated_at: new Date().toISOString() })
      .eq("id", existing.id)
    if (error) return { ok: false, error: error.message }
  }
  revalidatePath(`/dashboard/admin/users/${input.targetUserId}`)
  return { ok: true }
}

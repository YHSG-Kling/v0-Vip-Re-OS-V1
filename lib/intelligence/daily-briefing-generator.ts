/**
 * Daily AI Briefing Generator — Layer 12 AI Intelligence Mesh
 * 
 * Generates personalized daily briefings for agents aggregating:
 * - Tasks (overdue and due today/tomorrow)
 * - Transactions (active deals)
 * - Leads (hot, new)
 * - Showings (next 2 days)
 * - Deal health scores
 * - Calendar events (today)
 * - Contacts (hot status)
 * 
 * Uses Claude to generate an action-oriented summary with priorities.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { generateTextRouted } from "@/lib/ai/models"
import { KernelEvent } from "@/lib/kernel/events"

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PriorityAction {
  priority: "high" | "medium" | "low"
  action: string
  context: string
  /** Claude manager (manager-registry key) that produced this item. */
  manager?: string
  /** Optional entity reference so the UI can build a deep link. */
  entity_type?: "contact" | "transaction" | "listing" | "task" | null
  entity_id?: string | null
  /** Optional action verb so the UI knows which sheet/modal to open. */
  action_type?:
    | "open_contact"
    | "draft_followup"
    | "schedule_appointment"
    | "view_transaction"
    | "view_listing"
    | "complete_task"
    | "view_lead"
    | null
}

export interface HotLead {
  name: string
  status: string
  suggested_action: string
  /**
   * The contact this lead IS, so the UI can act on it.
   *
   * Without this the "Draft Message" button on the Hot Leads card was
   * unwireable by construction — the card knew a NAME and nothing addressable,
   * so there was no contact to draft for. The data snapshot the model reads
   * already carries the ids (top_priority_actions is instructed to populate
   * entity_id from exactly that), so this costs nothing to fill.
   *
   * NULLABLE and treated as untrusted: it comes back from a model, so the UI
   * only offers the action when it is a well-formed id, and draftSmartEmail
   * re-checks the contact belongs to the caller's brokerage regardless.
   */
  contact_id?: string | null
}

export interface DealAtRisk {
  transaction_id: string
  address: string
  reason: string
}

export interface ListingAtRisk {
  listing_id: string
  address: string
  reason: string
  risk_level: "watch" | "at_risk" | "critical"
  score: number
}

export interface DailyBriefing {
  id: string
  /** users.id — the briefing key (FK→users). */
  user_id: string | null
  /** Legacy column (FK→agents.id) — null on rows written after the user_id fix. */
  agent_id: string | null
  brokerage_id: string
  briefing_date: string
  summary: string
  top_priority_actions: PriorityAction[]
  market_pulse: string
  hot_leads: HotLead[]
  todays_events: any[]
  tasks_overdue: number
  deals_at_risk: DealAtRisk[]
  listings_at_risk: ListingAtRisk[]
  /** AI ISA overnight section (m204): qualified handoffs awaiting first touch,
   *  escalations, hot ISA conversations. Built deterministically — see
   *  lib/intelligence/isa-overnight.ts. */
  isa_overnight: import("./isa-overnight").IsaOvernightSection | null
  /** "What the AI team did while you slept" — the newest autonomous systems
   *  (no-shows queued for re-book, reels awaiting approval, AI-Sentinel
   *  license-risk escalations). Deterministic — see lib/intelligence/overnight-ai-work.ts. */
  overnight_ai_work: import("./overnight-ai-work").OvernightAiWorkSection | null
  ai_model_used: string
  generated_at: string
  opened_at: string | null
}

// ─── Constants ────────────────────────────────────────────────────────────────

const AI_MODEL = "claude-sonnet-4-20250514"
const MAX_TOKENS = 1000

// ─── Main Generator Function ──────────────────────────────────────────────────

export async function generateDailyBriefing(
  agentId: string,
  brokerageId: string,
  forceRegenerate: boolean = false
): Promise<DailyBriefing> {
  const supabase = createServiceClient()
  const today = new Date().toISOString().split("T")[0]

  // pass 12: callers pass MIXED id classes — briefing-actions + the cron pass
  // agents.id, user-type-briefs passes users.id. ai_daily_briefings.user_id FKs
  // users(id) while tasks/deals/leads/listings key on agents(id), so a single
  // unresolved id breaks one side or the other (the agents.id save FK-THREW and
  // briefings never cached for dashboard callers). Resolve BOTH classes once.
  const { data: identityRow } = await supabase
    .from("agents")
    .select("id, user_id")
    .or(`user_id.eq.${agentId},id.eq.${agentId}`)
    .maybeSingle()
  const agentsId = identityRow?.id ?? agentId
  const briefingUserId = identityRow?.user_id ?? agentId

  // 1. Check for existing briefing today
  if (!forceRegenerate) {
    const { data: existing } = await supabase
      .from("ai_daily_briefings")
      .select("*")
      .eq("user_id", briefingUserId)
      .eq("briefing_date", today)
      .maybeSingle()

    if (existing) {
      return existing as DailyBriefing
    }
  }

  // 2. Fetch 7 data sources in PARALLEL
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  const tomorrowStr = tomorrow.toISOString().split("T")[0]

  const twoDaysOut = new Date()
  twoDaysOut.setDate(twoDaysOut.getDate() + 2)

  const [
    tasksResult,
    transactionsResult,
    leadsResult,
    showingsResult,
    calendarResult,
    contactsResult,
  ] = await Promise.all([
    // Tasks: overdue or due today/tomorrow
    supabase
      .from("tasks")
      .select("id, title, description, due_date, priority, status")
      .eq("assigned_to_agent_id", agentsId)
      .neq("status", "completed")
      .lte("due_date", tomorrowStr)
      .order("due_date", { ascending: true })
      .limit(20),

    // Transactions: active deals
    supabase
      .from("transactions")
      .select("id, deal_name, property_address, stage, purchase_price, close_date, health_score")
      .eq("agent_id", agentsId)
      .not("stage", "in", '("closed","cancelled")')
      .limit(10),

    // Leads: new leads by score
    supabase
      .from("leads")
      .select("id, first_name, last_name, lead_score, lead_stage, source, last_contacted_at")
      .eq("agent_id", agentsId)
      .eq("lead_stage", "new")
      .order("lead_score", { ascending: false })
      .limit(5),

    // Showings: next 2 days
    supabase
      .from("showings")
      .select("id, listing_id, contact_id, scheduled_at, status, notes")
      .eq("agent_id", agentsId)
      .gte("scheduled_at", new Date().toISOString())
      .lte("scheduled_at", twoDaysOut.toISOString())
      .order("scheduled_at", { ascending: true })
      .limit(10),

    // Calendar events: today. pass 12: the person-day column is agent_user_id
    // (USERS class) — entity_id holds lead/contact/transaction ids, so the old
    // filter never matched an agent's own day.
    supabase
      .from("calendar_events")
      .select("id, event_type, start_at, end_at, metadata")
      .eq("agent_user_id", briefingUserId)
      .gte("start_at", today)
      .lt("start_at", tomorrowStr)
      .order("start_at", { ascending: true })
      .limit(10),

    // Contacts: hot status
    supabase
      .from("contacts")
      .select("id, first_name, last_name, status, intent_score, last_scored_at")
      .eq("agent_id", agentsId)
      .eq("status", "hot")
      .limit(5),
  ])

  const tasks = tasksResult.data || []
  const transactions = transactionsResult.data || []
  const leads = leadsResult.data || []
  const showings = showingsResult.data || []
  const calendarEvents = calendarResult.data || []
  const hotContacts = contactsResult.data || []

  // Fetch deal health scores for active transactions
  const transactionIds = transactions.map((t) => t.id)
  let dealHealthScores: any[] = []
  if (transactionIds.length > 0) {
    const { data: healthData } = await supabase
      .from("deal_health_scores")
      .select("transaction_id, overall_score, risk_level, flags, ai_narrative")
      .in("transaction_id", transactionIds)

    dealHealthScores = healthData || []
  }

  // Calculate overdue tasks
  const tasksOverdue = tasks.filter((t) => {
    const dueDate = new Date(t.due_date)
    const todayDate = new Date(today)
    return dueDate < todayDate
  }).length

  // Identify deals at risk
  const dealsAtRisk: DealAtRisk[] = dealHealthScores
    .filter((h) => h.risk_level === "high" || h.risk_level === "critical")
    .map((h) => {
      const tx = transactions.find((t) => t.id === h.transaction_id)
      return {
        transaction_id: h.transaction_id,
        address: tx?.property_address || "Unknown",
        reason: h.ai_narrative || `Risk level: ${h.risk_level}`,
      }
    })

  // Fetch listing health for the agent's active listings — mirrors the
  // deal-health block above. Surfaces a "listings at risk" section so
  // the agent's morning briefing covers both sides of the lifecycle.
  let listingsAtRisk: ListingAtRisk[] = []
  try {
    const { data: agentListings } = await supabase
      .from("listings")
      .select("id, address, status")
      .eq("agent_id", agentsId)
      .in("status", ["active", "coming_soon"])

    const listingIds = (agentListings ?? []).map((l) => l.id)
    if (listingIds.length > 0) {
      const { data: lhRows } = await supabase
        .from("listing_health_scores")
        .select("listing_id, overall_score, risk_level, ai_narrative, flags, scored_at")
        .in("listing_id", listingIds)
        .order("scored_at", { ascending: false })
        .limit(50)

      const seen = new Set<string>()
      for (const row of (lhRows ?? []) as Array<{
        listing_id: string
        overall_score: number
        risk_level: string
        ai_narrative: string | null
        flags: string[] | null
      }>) {
        if (seen.has(row.listing_id)) continue
        seen.add(row.listing_id)
        if (row.risk_level !== "at_risk" && row.risk_level !== "critical") continue
        const listing = agentListings?.find((l) => l.id === row.listing_id)
        const topFlag = row.flags?.[0] ?? null
        listingsAtRisk.push({
          listing_id: row.listing_id,
          address:    listing?.address ?? "Unknown",
          reason:     row.ai_narrative ?? topFlag ?? `Health score ${row.overall_score}/100`,
          risk_level: row.risk_level as "at_risk" | "critical",
          score:      row.overall_score,
        })
      }
      // Cap at 5 for the briefing
      listingsAtRisk = listingsAtRisk.slice(0, 5)
    }
  } catch (err) {
    console.error("[DailyBriefing] listing-health fetch failed:", err)
  }

  // ── AI ISA overnight section ────────────────────────────────────────────────
  // What the ISA manager did while the agent slept: qualified handoffs (Engine 2
  // assignment_log, agents.id-keyed), unclaimed first-touches, escalations, and hot
  // conversations still in ISA ownership. Built deterministically (isa-overnight.ts)
  // and merged into top_priority_actions BELOW the AI call so a handoff can never be
  // dropped by a model's judgment.
  const { buildIsaOvernightSection, isaPriorityActions } = await import("./isa-overnight")
  let isaOvernight: import("./isa-overnight").IsaOvernightSection | null = null
  let isaActions: PriorityAction[] = []
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    // assignment_log.agent_id is agents.id; notifications.user_id is users.id —
    // both resolved once at the top of this function (pass 12).
    const [handoffLogs, escalationRows, hotIsaCount] = await Promise.all([
      supabase
        .from("assignment_log")
        .select("lead_id, claimed, assignment_method, created_at")
        .eq("agent_id", agentsId)
        .gte("created_at", since)
        .order("created_at", { ascending: true })
        .limit(20),
      supabase
        .from("notifications")
        .select("body, entity_id, priority")
        .eq("user_id", briefingUserId)
        .eq("type", "isa_escalation")
        .is("read_at", null)
        .gte("created_at", since)
        .limit(10),
      supabase
        .from("leads")
        .select("id", { count: "exact", head: true })
        .eq("brokerage_id", brokerageId)
        .eq("ai_isa_owner", true)
        .eq("lead_temperature", "hot"),
    ])

    const logRows = (handoffLogs.data ?? []) as Array<{ lead_id: string; claimed: boolean; assignment_method: string | null; created_at: string }>
    const leadIds = logRows.map((r) => r.lead_id)
    const leadNames = new Map<string, string>()
    const leadContacts = new Map<string, string | null>()
    if (leadIds.length > 0) {
      // contact_id: assignment CONVERTED the lead to a contact (canonical process) —
      // the briefing deep-links the agent to the CONTACT, not the retired lead row.
      const { data: leadRows } = await supabase
        .from("leads").select("id, first_name, last_name, contact_id").in("id", leadIds)
      for (const l of leadRows ?? []) {
        leadNames.set(l.id, `${l.first_name ?? ""} ${l.last_name ?? ""}`.trim() || "Unnamed lead")
        leadContacts.set(l.id, (l as any).contact_id ?? null)
      }
    }

    const escalations = ((escalationRows.data ?? []) as Array<{ body: string | null; entity_id: string | null; priority: string | null }>).map((n) => ({
      lead_id: n.entity_id,
      message: n.body ?? "Lead asked for a human",
      urgency: n.priority,
    }))

    isaOvernight = buildIsaOvernightSection({
      handoffs: logRows.map((r) => ({
        lead_id: r.lead_id,
        contact_id: leadContacts.get(r.lead_id) ?? null,
        lead_name: leadNames.get(r.lead_id) ?? "Unnamed lead",
        claimed: r.claimed,
        assignment_method: r.assignment_method,
        assigned_at: r.created_at,
      })),
      escalations,
      hotIsaLeadCount: hotIsaCount.count ?? 0,
    })
    isaActions = isaPriorityActions(isaOvernight, escalations)
  } catch (err) {
    console.error("[DailyBriefing] ISA-overnight fetch failed:", err)
  }

  // 2a-bis. ACADEMY → BRIEFING LOOP: a stale skill surfaces as a low-priority
  // sharpen nudge with the on-demand academy as the fix. Same signals as the
  // skill-freshness radar (objection drills, quizzes, PASSED courses) — the
  // briefing and the radar can never disagree. Honest-quiet when sharp/unproven.
  let skillActions: PriorityAction[] = []
  try {
    const { loadAgentSkillFreshness } = await import("@/lib/education/skill-freshness-radar")
    const freshness = await loadAgentSkillFreshness(supabase as any, { id: agentsId, user_id: briefingUserId })
    if (freshness.overall === "needs_refresh") {
      const stale = freshness.skills.find((s) => s.status === "stale")
      if (stale) {
        skillActions.push({
          priority: "low",
          action: `Sharpen a stale skill: ${stale.area.replace(/_/g, " ")}`,
          context: `${stale.reason} The academy has an on-demand refresher — 15 minutes keeps the edge you use on live clients.`,
          manager: "recruiting_manager",
          entity_type: null,
          entity_id: null,
        })
      }
    }
  } catch { /* the briefing stands without the skill line */ }

  // 2b. "What the AI team did while you slept" — the newest autonomous systems.
  //     Deterministic, brokerage-scoped + agent-scoped; honest empty. Never blocks.
  let overnightAiWork: import("./overnight-ai-work").OvernightAiWorkSection | null = null
  try {
    const { buildOvernightAiWork } = await import("./overnight-ai-work")
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    overnightAiWork = await buildOvernightAiWork(supabase, {
      agentUserId: briefingUserId, brokerageId, since: since24h,
    })
  } catch (err) {
    console.error("[DailyBriefing] overnight-AI-work fetch failed:", err)
  }

  // 2c. END-OF-DAY "I SAW YOU" — heavy client engagement yesterday (real
  //     client_portal_activity + property_views rows) becomes a recognition
  //     note the agent sends this morning. Deterministic (i-saw-you.ts),
  //     merged below the AI call so a heavy evening is never dropped by a
  //     model's judgment. Writers of client_portal_activity only reliably
  //     set contact_id — ownership is resolved through contacts, never
  //     trusted from the activity row.
  let iSawYouActions: PriorityAction[] = []
  try {
    const { composeISawYouActions, humanizePortalActivity } = await import("./i-saw-you")
    const { resolveAddressing } = await import("@/lib/kernel/addressing")
    const since24 = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const owningAgentId = agentsId

    // THE READ SIDE OF THE SAME TENANT DEFECT. This is a SERVICE-client read (RLS bypassed), and
    // it carried no tenant bound at all: it took the newest 500 activity rows PLATFORM-WIDE and
    // then narrowed by contacts this agent owns. Two consequences, one of them silent and bad —
    //   · it reads other brokerages' client engagement to build one agent's briefing; and
    //   · the 500-row cap is spent on rows that will be discarded, so a busy neighbouring tenant
    //     pushes this agent's OWN clients out of the window and their briefing quietly loses the
    //     signals it exists to surface. "Nothing came back" is never health.
    // Scoping by brokerage_id is only possible because the writers now stamp it; that is the
    // whole point of stamping them. The error is destructured for the same reason as everywhere
    // else: supabase-js RESOLVES a refused read, so a refusal arrived as "a quiet evening".
    const { data: acts, error: actsError } = await supabase
      .from("client_portal_activity")
      .select("contact_id, activity_type, created_at")
      .eq("brokerage_id", brokerageId)
      .gte("created_at", since24)
      .order("created_at", { ascending: false })
      .limit(500)
    if (actsError) {
      console.error("[DailyBriefing] portal-activity read refused — 'I saw you' is incomplete, not empty:", actsError.message)
    }
    const actsByContact = new Map<string, { count: number; latestType: string | null }>()
    for (const a of ((acts ?? []) as Array<{ contact_id: string | null; activity_type: string | null }>)) {
      if (!a.contact_id) continue
      const cur = actsByContact.get(a.contact_id) ?? { count: 0, latestType: null }
      cur.count += 1
      if (!cur.latestType) cur.latestType = a.activity_type ?? null
      actsByContact.set(a.contact_id, cur)
    }
    const activeIds = Array.from(actsByContact.keys()).slice(0, 100)
    if (activeIds.length > 0) {
      const [{ data: mine }, { data: views }] = await Promise.all([
        supabase
          .from("contacts")
          .select("id, first_name, last_name, preferred_name, salutation_style")
          .in("id", activeIds)
          .eq("agent_id", owningAgentId),
        supabase
          .from("property_views")
          .select("contact_id")
          .in("contact_id", activeIds)
          .gte("last_viewed_at", since24),
      ])
      const viewsByContact = new Map<string, number>()
      for (const v of ((views ?? []) as Array<{ contact_id: string | null }>)) {
        if (!v.contact_id) continue
        viewsByContact.set(v.contact_id, (viewsByContact.get(v.contact_id) ?? 0) + 1)
      }
      iSawYouActions = composeISawYouActions(
        ((mine ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null; preferred_name: string | null; salutation_style: string | null }>).map((c) => ({
          contactId: c.id,
          addressAs: resolveAddressing({
            firstName: c.first_name, lastName: c.last_name,
            preferredName: c.preferred_name, namePronunciation: null,
            salutationStyle: c.salutation_style,
          }).addressAs,
          portalActions: actsByContact.get(c.id)?.count ?? 0,
          homesViewed: viewsByContact.get(c.id) ?? 0,
          highlight: humanizePortalActivity(actsByContact.get(c.id)?.latestType),
        })),
      )
    }
  } catch (err) {
    console.error("[DailyBriefing] i-saw-you fetch failed:", err)
  }

  // 2d. SMALL-WINS CELEBRATION — yesterday's mid-deal wins (offer accepted,
  //     under contract, financing cleared, listing live) become a congrats
  //     note the agent sends this morning, drafted and addressed. Reads the
  //     projector's portal_event_stream (already contact+agent resolved,
  //     severity 'celebration'); closing + anniversary are owned by the
  //     Gift Studio queue / anniversary rail (pure exclusion). Deterministic.
  let smallWinActions: PriorityAction[] = []
  try {
    const { composeSmallWinActions } = await import("./small-wins")
    const { resolveAddressing } = await import("@/lib/kernel/addressing")
    const since24 = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    // portal_event_stream.agent_user_id is users.id — resolved once up top (pass 12).
    const agentUserIds = [briefingUserId]

    const { data: wins } = await supabase
      .from("portal_event_stream")
      .select("contact_id, event_type, occurred_at")
      .eq("severity", "celebration")
      .in("agent_user_id", agentUserIds)
      .gte("occurred_at", since24)
      .order("occurred_at", { ascending: false })
      .limit(20)
    const winRows = ((wins ?? []) as Array<{ contact_id: string | null; event_type: string | null }>)
      .filter((w) => w.contact_id && w.event_type)
    const winContactIds = Array.from(new Set(winRows.map((w) => w.contact_id as string)))
    if (winContactIds.length > 0) {
      const { data: winContacts } = await supabase
        .from("contacts")
        .select("id, first_name, last_name, preferred_name, salutation_style")
        .in("id", winContactIds)
      const nameById = new Map<string, string>()
      for (const c of ((winContacts ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null; preferred_name: string | null; salutation_style: string | null }>)) {
        nameById.set(c.id, resolveAddressing({
          firstName: c.first_name, lastName: c.last_name,
          preferredName: c.preferred_name, namePronunciation: null,
          salutationStyle: c.salutation_style,
        }).addressAs)
      }
      smallWinActions = composeSmallWinActions(winRows.map((w) => ({
        contactId: w.contact_id as string,
        addressAs: nameById.get(w.contact_id as string) ?? "your client",
        eventType: w.event_type as string,
      })))
    }
  } catch (err) {
    console.error("[DailyBriefing] small-wins fetch failed:", err)
  }

  // 2e. SERVICE RECOVERY — a client message that FAILED to send yesterday
  //     (agent_client_messages.send_error) gets a human recovery this
  //     morning with the apology already drafted. Deterministic; the
  //     failure never dies silently in a status column.
  let recoveryActions: PriorityAction[] = []
  try {
    const { composeRecoveryActions } = await import("@/lib/kernel/service-recovery")
    const { resolveAddressing } = await import("@/lib/kernel/addressing")
    const since24 = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const { data: failed } = await supabase
      .from("agent_client_messages")
      .select("recipient_contact_id, subject, send_error")
      .eq("brokerage_id", brokerageId)
      .not("send_error", "is", null)
      .gte("created_at", since24)
      .limit(20)
    const failRows = ((failed ?? []) as Array<{ recipient_contact_id: string | null; subject: string | null; send_error: string | null }>)
      .filter((f) => f.recipient_contact_id)
    const failIds = Array.from(new Set(failRows.map((f) => f.recipient_contact_id as string)))
    if (failIds.length > 0) {
      const { data: mine } = await supabase
        .from("contacts")
        .select("id, first_name, last_name, preferred_name, salutation_style")
        .in("id", failIds)
        .eq("agent_id", agentsId)
      const nameById = new Map(((mine ?? []) as any[]).map((c) => [c.id, resolveAddressing({
        firstName: c.first_name, lastName: c.last_name,
        preferredName: c.preferred_name, namePronunciation: null, salutationStyle: c.salutation_style,
      }).addressAs]))
      recoveryActions = composeRecoveryActions(
        failRows
          .filter((f) => nameById.has(f.recipient_contact_id as string))
          .map((f) => ({
            contactId: f.recipient_contact_id as string,
            addressAs: nameById.get(f.recipient_contact_id as string) ?? "your client",
            subject: f.subject, sendError: f.send_error,
          })),
      )
    }
  } catch (err) {
    console.error("[DailyBriefing] service-recovery fetch failed:", err)
  }

  // 2f. PROMISE AGING GUARD (concierge A.3) — an explicit promise to a
  //     client (contacts.last_promise, l50-s01) that's been open 3+ days
  //     surfaces HIGH until it's kept or rescheduled. The OS will not let
  //     a promise silently age out. Deterministic.
  let promiseActions: PriorityAction[] = []
  try {
    const { resolveAddressing } = await import("@/lib/kernel/addressing")
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
    const { data: aging } = await supabase
      .from("contacts")
      .select("id, first_name, last_name, preferred_name, salutation_style, last_promise, last_promise_at")
      .eq("agent_id", agentsId)
      .not("last_promise", "is", null)
      .lt("last_promise_at", threeDaysAgo)
      .order("last_promise_at", { ascending: true })
      .limit(3)
    promiseActions = ((aging ?? []) as any[]).map((c) => {
      const addressAs = resolveAddressing({
        firstName: c.first_name, lastName: c.last_name,
        preferredName: c.preferred_name, namePronunciation: null, salutationStyle: c.salutation_style,
      }).addressAs
      const days = c.last_promise_at ? Math.floor((Date.now() - new Date(c.last_promise_at).getTime()) / 86_400_000) : 0
      return {
        priority: "high" as const,
        action: `Keep your promise to ${addressAs} — open ${days} days`,
        context: `You promised: "${String(c.last_promise).slice(0, 160)}". Deliver it or reschedule it today — then clear the promise on their card so the team knows it's kept.`,
        manager: "sphere_of_influence",
        entity_type: "contact" as const,
        entity_id: c.id,
        action_type: "open_contact" as const,
      }
    })
  } catch (err) {
    console.error("[DailyBriefing] promise-aging fetch failed:", err)
  }

  // 2g. COVERAGE-AWARE BRIEFING — while I'm covering someone (l52-s01), the
  //     redirect handles their NEW leads; THIS is the second half: their
  //     aging promises and failed sends surface in MY briefing, labeled
  //     "(covering for X)", so the away agent's open work stays visible.
  let coverageActions: PriorityAction[] = []
  try {
    const { resolveAddressing } = await import("@/lib/kernel/addressing")
    const myAgentsId = agentsId
    if (myAgentsId) {
      const { data: covered } = await supabase
        .from("agents")
        .select("id, user_id")
        .eq("covering_agent_id", myAgentsId)
        .gt("coverage_until", new Date().toISOString())
        .limit(2)
      for (const away of ((covered ?? []) as Array<{ id: string; user_id: string | null }>)) {
        let awayName = "a teammate"
        if (away.user_id) {
          const { data: u } = await supabase.from("users").select("first_name, last_name").in("id", [away.user_id])
          const row = (u ?? [])[0] as any
          if (row) awayName = [row.first_name, row.last_name].filter(Boolean).join(" ") || awayName
        }
        const threeDaysAgo2 = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
        const { data: theirAging } = await supabase
          .from("contacts")
          .select("id, first_name, last_name, preferred_name, salutation_style, last_promise, last_promise_at")
          .eq("agent_id", away.id)
          .not("last_promise", "is", null)
          .lt("last_promise_at", threeDaysAgo2)
          .order("last_promise_at", { ascending: true })
          .limit(2)
        for (const c of ((theirAging ?? []) as any[])) {
          const addressAs = resolveAddressing({
            firstName: c.first_name, lastName: c.last_name,
            preferredName: c.preferred_name, namePronunciation: null, salutationStyle: c.salutation_style,
          }).addressAs
          coverageActions.push({
            priority: "high",
            action: `(Covering for ${awayName}) Keep their promise to ${addressAs}`,
            context: `${awayName} promised: "${String(c.last_promise).slice(0, 140)}" — it's aging while they're out. Deliver it, reschedule it, or tell ${addressAs} when ${awayName} is back.`,
            manager: "sphere_of_influence",
            entity_type: "contact",
            entity_id: c.id,
            action_type: "open_contact",
          })
        }
      }
      coverageActions = coverageActions.slice(0, 3)
    }
  } catch (err) {
    console.error("[DailyBriefing] coverage-aware fetch failed:", err)
  }

  // 3. Call Claude to generate briefing
  const dataSnapshot = {
    tasks: tasks.slice(0, 10),
    transactions: transactions.slice(0, 5),
    leads: leads.slice(0, 5),
    showings: showings.slice(0, 5),
    calendarEvents: calendarEvents.slice(0, 5),
    hotContacts: hotContacts.slice(0, 3),
    dealHealthScores: dealHealthScores.slice(0, 5),
    tasksOverdue,
    // ISA overnight summary so the AI's narrative reflects it (the actionable items
    // are merged deterministically below, never left to the model).
    isaOvernight: isaOvernight ? { summary: isaOvernight.summary_line, unclaimed: isaOvernight.handoffs_unclaimed } : null,
  }

  const systemPrompt = `You are an AI briefing generator for a real estate agent. Generate a concise daily briefing based on the data provided. Be action-oriented and prioritize the most urgent items.

Output ONLY valid JSON matching this exact schema (no markdown, no extra text):
{
  "summary": "2-3 sentence overview of the day",
  "top_priority_actions": [
    {
      "priority": "high" | "medium" | "low",
      "action": "specific action to take",
      "context": "why this matters",
      "entity_type": "contact" | "transaction" | "listing" | "task" | null,
      "entity_id": "<uuid from the data snapshot when known, otherwise null>",
      "action_type": "open_contact" | "draft_followup" | "schedule_appointment" | "view_transaction" | "view_listing" | "complete_task" | "view_lead" | null
    }
  ],
  "market_pulse": "1 sentence market observation based on the data",
  "hot_leads": [
    {"name": "lead name", "status": "current status", "suggested_action": "recommended next step", "contact_id": "uuid or null"}
  ],
  "deals_at_risk": [
    {"transaction_id": "uuid", "address": "property address", "reason": "why it's at risk"}
  ]
}

Rules:
- top_priority_actions: max 5 items, ordered by urgency
- For EVERY priority action, populate entity_type + entity_id by looking up
  the corresponding row in the data snapshot. If the action is about a
  contact, use that contact's id; if about a deal, the transaction id; etc.
  Use null only when no specific entity applies.
- Pick action_type based on what the agent should DO: 'draft_followup' if
  they should reply to a contact; 'view_transaction' if they should review
  a deal; 'complete_task' if they should mark a task done; etc.
- hot_leads: max 3 items. Populate contact_id from the matching contact row in
  the data snapshot so the agent can act on it; use null if the lead has no
  contact row. NEVER invent an id.
- deals_at_risk: only include transactions with health issues
- Be specific and actionable
- Focus on what needs attention TODAY`

  const userPrompt = `Generate today's briefing from this data:
${JSON.stringify(dataSnapshot, null, 2)}`

  let aiResponse: {
    summary: string
    top_priority_actions: PriorityAction[]
    market_pulse: string
    hot_leads: HotLead[]
    deals_at_risk: DealAtRisk[]
  }

  try {
    // generateTextRouted goes through the gateway + AI_TASK_ROUTING + auto-fallback + fair-use +
    // cost accounting. AI_MODEL is left as a label for `ai_model_used` below; the actual model is
    // chosen by AI_TASK_ROUTING['coaching_insight'].
    const result = await generateTextRouted({
      brokerageId,
      userId: briefingUserId,
      feature:     "coaching_insight",
      system:      systemPrompt,
      prompt:      userPrompt,
      maxTokens:   MAX_TOKENS,
      temperature: 0.3,
    })

    // Parse JSON response
    const cleanedText = result.text.replace(/```json\n?|\n?```/g, "").trim()
    aiResponse = JSON.parse(cleanedText)
  } catch (error) {
    console.error("[DailyBriefing] AI generation failed:", error)
    // Fallback to basic briefing
    aiResponse = {
      summary: `You have ${tasks.length} pending tasks and ${transactions.length} active deals. ${tasksOverdue > 0 ? `${tasksOverdue} tasks are overdue.` : ""}`,
      top_priority_actions: tasks.slice(0, 3).map((t) => ({
        priority: t.priority === "high" ? "high" : "medium",
        action: t.title,
        context: t.description || "Task requires attention",
      })) as PriorityAction[],
      market_pulse: "Review your active pipeline for opportunities.",
      hot_leads: leads.slice(0, 3).map((l) => ({
        name: `${l.first_name || ""} ${l.last_name || ""}`.trim() || "Unknown",
        status: l.lead_stage || "new",
        suggested_action: "Follow up within 24 hours",
      })),
      deals_at_risk: dealsAtRisk.slice(0, 3),
    }
  }

  // Merge AI-identified deals at risk with our calculation
  const finalDealsAtRisk = [
    ...aiResponse.deals_at_risk,
    ...dealsAtRisk.filter(
      (d) => !aiResponse.deals_at_risk.some((a) => a.transaction_id === d.transaction_id)
    ),
  ].slice(0, 5)

  // ISA handoffs awaiting first touch lead the list DETERMINISTICALLY — an unclaimed
  // qualified lead is never left to the model's judgment. "I saw you" recognition
  // notes ride next (same rule: a heavy client evening is a fact, not a model call).
  // AI items fill the rest.
  const deterministicActions = [...promiseActions, ...coverageActions, ...recoveryActions, ...isaActions, ...iSawYouActions, ...smallWinActions, ...skillActions]
  const finalPriorityActions = [
    ...deterministicActions,
    ...(aiResponse.top_priority_actions ?? []).filter(
      (a) => !deterministicActions.some((i) => i.entity_id && i.entity_id === a.entity_id),
    ),
  ].slice(0, 7)

  // 4. UPSERT ai_daily_briefings
  const briefingData = {
    // user_id (FK→users.id) is the briefing key. The legacy agent_id column has
    // FK→agents.id — writing users.id there violated the FK, the upsert THREW, and
    // briefings never cached (full regeneration + AI spend on every page view).
    user_id: briefingUserId,
    brokerage_id: brokerageId,
    briefing_date: today,
    summary: aiResponse.summary,
    top_priority_actions: finalPriorityActions,
    hot_leads: aiResponse.hot_leads,
    todays_events: calendarEvents,
    market_pulse: aiResponse.market_pulse,
    deals_at_risk: finalDealsAtRisk,
    listings_at_risk: listingsAtRisk,
    isa_overnight: isaOvernight,
    overnight_ai_work: overnightAiWork,
    tasks_overdue: tasksOverdue,
    ai_model_used: AI_MODEL,
    generated_at: new Date().toISOString(),
    active_transactions_summary: transactions.slice(0, 5),
  }

  // Try to update the existing briefing for today first, then insert if none exists.
  // This avoids relying on a named unique constraint for upsert conflict resolution.
  const { data: existingForUpsert } = await supabase
    .from("ai_daily_briefings")
    .select("id")
    .eq("user_id", briefingUserId)
    .eq("briefing_date", today)
    .maybeSingle()

  let upsertedBriefing: any
  let upsertError: any

  if (existingForUpsert?.id) {
    const { data, error } = await supabase
      .from("ai_daily_briefings")
      .update(briefingData)
      .eq("id", existingForUpsert.id)
      .select()
      .single()
    upsertedBriefing = data
    upsertError = error
  } else {
    const { data, error } = await supabase
      .from("ai_daily_briefings")
      .insert(briefingData)
      .select()
      .single()
    upsertedBriefing = data
    upsertError = error
  }

  if (upsertError) {
    console.error("[DailyBriefing] Save failed:", upsertError)
    throw new Error(`Failed to save briefing: ${upsertError.message}`)
  }

  // 5. DELIVER IT. Merged in from copilot.ts:handleMorningKickoff, which was an
  // orphan whose ONLY unique contribution was this notification — the rest of it
  // read one task list where this function reads seven sources, so the reading
  // half died and the delivery half moved here.
  //
  // Until now this function wrote the briefing and emitted
  // DAILY_BRIEFING_GENERATED, and that event has ZERO consumers — no
  // notification-engine mapping, no handler anywhere in the tree. So a briefing
  // was generated every morning and the agent was never told it existed.
  //
  // user_id is briefingUserId (users.id), NOT agentsId — notifications.user_id
  // FKs users and the two id spaces are disjoint (pass 12 resolved both above;
  // sending the agents.id here is the FK throw that kept briefings uncached).
  //
  // A failed delivery is LOGGED, not thrown: the briefing itself is saved and
  // returning it is still correct. What must not happen is the silent discard
  // the orphan did — it swallowed the insert error and reported success either
  // way, so nobody could tell a delivered briefing from an undelivered one.
  const { error: notifyError } = await supabase
    .from("notifications")
    .insert({
      user_id:     briefingUserId,
      brokerage_id: brokerageId,
      type:        "daily_briefing",
      title:       "Your morning briefing is ready",
      body:        `${tasks.length} task${tasks.length === 1 ? "" : "s"} today` +
                   (finalDealsAtRisk.length > 0 ? ` · ${finalDealsAtRisk.length} deal${finalDealsAtRisk.length === 1 ? "" : "s"} needing attention` : ""),
      entity_type: "ai_daily_briefing",
      entity_id:   upsertedBriefing.id,
      priority:    finalDealsAtRisk.length > 0 ? "high" : "medium",
      is_read:     false,
    })
  if (notifyError) {
    console.error(
      `[DailyBriefing] briefing ${upsertedBriefing.id} saved but NOT delivered to ${briefingUserId}: ${notifyError.message}`,
    )
  }

  // 6. INSERT lifecycle_events
  await supabase
    .from("lifecycle_events")
    .insert({
      brokerage_id: brokerageId,
      entity_type: "ai_daily_briefing",
      entity_id: upsertedBriefing.id,
      event_type: KernelEvent.DAILY_BRIEFING_GENERATED,
      metadata: {
        agent_id: agentsId,
        briefing_date: today,
        tasks_count: tasks.length,
        transactions_count: transactions.length,
        deals_at_risk_count: finalDealsAtRisk.length,
        listings_at_risk_count: listingsAtRisk.length,
      },
    })

  // 7. Return briefing data
  return upsertedBriefing as DailyBriefing
}

// ─── Mark Briefing as Opened ──────────────────────────────────────────────────

export async function markBriefingOpened(agentId: string): Promise<void> {
  const supabase = createServiceClient()
  const today = new Date().toISOString().split("T")[0]

  // pass 12: callers pass agents.id (briefing-actions) — resolve to the users.id
  // key the briefing rows are stored under, tolerating either class.
  const { data: idRow } = await supabase
    .from("agents").select("user_id").or(`user_id.eq.${agentId},id.eq.${agentId}`).maybeSingle()
  const briefingUserId = idRow?.user_id ?? agentId

  await supabase
    .from("ai_daily_briefings")
    .update({ opened_at: new Date().toISOString() })
    .eq("user_id", briefingUserId)
    .eq("briefing_date", today)
    .is("opened_at", null)
}

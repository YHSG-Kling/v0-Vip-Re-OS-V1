import { createClient } from "@/lib/supabase/server"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { createServiceClient } from "@/lib/supabase/service"
import { streamText, convertToModelMessages, tool, stepCountIs } from "ai"
import { resolveModel } from "@/lib/ai/resolve-model"
import { z } from "zod"
import { NextRequest, NextResponse } from "next/server"

// Roles that are permitted to use the internal AI assistant.
// Uses canonical role values from lib/security/types.ts.
// Legacy DB values (e.g. "transaction_coordinator") are normalised below.
const PERMITTED_ROLES = new Set([
  "agent", "broker", "admin", "tc", "transaction_coordinator",
  "lender", "vendor", "title", "title_agent",
  "compliance_officer", "compliance_manager",
  "superadmin", "platform_admin", "super_admin",
  "isa", "team_lead",
])

// ─── Role-scoped context loaders ────────────────────────────────────────────

async function loadAgentContext(service: ReturnType<typeof createServiceClient>, userId: string, brokerageId: string) {
  const today = new Date().toISOString().split("T")[0]

  // pass 11: contacts/transactions/leads.agent_id + tasks.assigned_to_agent_id
  // FK agents(id), NOT users(id) — filtering by the raw userId returned EMPTY
  // for every agent, so the AI chat saw no book of business. Resolve the
  // agents.id first (honest empty when the user has no agent profile).
  const { resolveAgentId } = await import("@/lib/kernel/agent-identity")
  const agentId = await resolveAgentId(service as any, userId)
  if (!agentId) return { contacts: [], transactions: [], tasks: [], leads: [], today }

  const [{ data: contacts }, { data: transactions }, { data: tasks }, { data: leads }] = await Promise.all([
    service.from("contacts")
      .select("id, first_name, last_name, email, phone, contact_persona, status, buyer_stage, engagement_score, intent_score")
      .eq("agent_id", agentId).eq("brokerage_id", brokerageId)
      .order("updated_at", { ascending: false }).limit(20),
    service.from("transactions")
      .select("id, deal_name, property_address, status, stage, close_date, purchase_price, health_score")
      .eq("agent_id", agentId).eq("brokerage_id", brokerageId)
      .not("status", "eq", "closed").limit(10),
    service.from("tasks")
      .select("id, title, status, priority, due_date, transaction_id, contact_id")
      .eq("assigned_to_agent_id", agentId)
      .lte("due_date", new Date(Date.now() + 7 * 86400000).toISOString().split("T")[0])
      .neq("status", "completed").limit(15),
    service.from("leads")
      .select("id, first_name, last_name, lead_stage, lead_score, lifecycle_state, created_at")
      .eq("agent_id", agentId).eq("brokerage_id", brokerageId)
      .order("created_at", { ascending: false }).limit(10),
  ])

  return { contacts, transactions, tasks, leads, today }
}

async function loadBrokerContext(service: ReturnType<typeof createServiceClient>, brokerageId: string) {
  const [{ data: agents }, { data: transactions }, { data: activeLeads }] = await Promise.all([
    service.from("agents")
      .select("id, user_id, ytd_gci, ytd_transactions, cap_progress, is_active")
      .eq("brokerage_id", brokerageId).eq("is_active", true).limit(30),
    service.from("transactions")
      .select("id, deal_name, status, stage, close_date, purchase_price, health_score, agent_id")
      .eq("brokerage_id", brokerageId).not("status", "eq", "closed").limit(20),
    service.from("leads")
      .select("id, lifecycle_state, lead_score")
      .eq("brokerage_id", brokerageId).eq("is_active", true).limit(50),
  ])
  return { agents, transactions, activeLeads }
}

async function loadLenderContext(service: ReturnType<typeof createServiceClient>, userId: string) {
  // Lenders are vendors — resolve the lender vendor, then its assigned deals.
  const { lenderVendorForUser, lenderVendorTransactionIds, lenderFilterIds } =
    await import("@/lib/kernel/lender-linkage")
  const lenderVendor = await lenderVendorForUser(service, userId)
  const txnIds = lenderFilterIds(lenderVendor ? await lenderVendorTransactionIds(service, lenderVendor.vendorId) : [])
  const { data: lenderTxns } = await service
    .from("transaction_lenders")
    .select(`
      transaction_id, lender_name, underwriting_status, clear_to_close_date,
      transactions!inner (id, deal_name, property_address, status, close_date, buyer_contact_id,
        contacts!buyer_contact_id(first_name, last_name))
    `)
    .in("transaction_id", txnIds)
    .limit(20)

  return { lenderTxns }
}

async function loadVendorContext(service: ReturnType<typeof createServiceClient>, userId: string, brokerageId: string) {
  // Get vendor_id via vendors table (not vendor_directory)
  const { data: vendor } = await service
    .from("vendors")
    .select("id, name, category")
    .eq("brokerage_id", brokerageId)
    .limit(1)
    .maybeSingle()

  // Fallback: check user_role_assignments for vendor_id
  const { data: roleRow } = await service
    .from("user_role_assignments")
    .select("vendor_id")
    .eq("user_id", userId)
    .maybeSingle()

  const vendorId = vendor?.id ?? roleRow?.vendor_id
  if (!vendorId) return { jobs: [], bookings: [] }

  const [{ data: jobs }, { data: bookings }] = await Promise.all([
    service.from("vendor_jobs")
      .select("id, job_title, status, cost_estimate, cost_actual, scheduled_date: created_at, transaction_id")
      .eq("vendor_id", vendorId).limit(15),
    service.from("vendor_bookings")
      .select("id, service_type, status, scheduled_date, cost, transaction_id")
      .eq("vendor_id", vendorId).order("scheduled_date", { ascending: true }).limit(15),
  ])

  return { jobs, bookings, vendorName: vendor?.name }
}

async function loadTCContext(service: ReturnType<typeof createServiceClient>, userId: string, brokerageId: string) {
  const { data: tc } = await service
    .from("transaction_coordinators")
    .select("id")
    .eq("user_id", userId)
    .eq("is_active", true)
    .maybeSingle()

  if (!tc) return { assignments: [], tasks: [], deadlines: [] }

  const [{ data: assignments }, { data: tasks }, { data: deadlines }] = await Promise.all([
    service.from("transaction_assignments")
      .select("transaction_id, transactions(id, deal_name, status, stage, close_date, health_score)")
      .eq("coordinator_id", tc.id).eq("brokerage_id", brokerageId).limit(20),
    service.from("transaction_tasks")
      .select("id, title, status, priority, due_date, transaction_id")
      .eq("brokerage_id", brokerageId).neq("status", "completed")
      .lte("due_date", new Date(Date.now() + 7 * 86400000).toISOString().split("T")[0]).limit(20),
    service.from("transaction_deadlines")
      .select("id, deadline_type, deadline_date, status, transaction_id")
      .eq("brokerage_id", brokerageId).neq("status", "completed")
      .lte("deadline_date", new Date(Date.now() + 14 * 86400000).toISOString().split("T")[0]).limit(15),
  ])

  return { assignments, tasks, deadlines }
}

async function loadTitleContext(service: ReturnType<typeof createServiceClient>, userId: string) {
  const { data: titleTxns } = await service
    .from("title_company_users")
    .select(`
      transaction_id,
      transactions(id, deal_name, property_address, status, close_date,
        transaction_title_escrow(title_search_ordered_date, title_commitment_date, closing_scheduled_date, title_issues))
    `)
    .eq("user_id", userId)
    .limit(20)

  return { titleTxns }
}

async function loadComplianceContext(service: ReturnType<typeof createServiceClient>, brokerageId: string) {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString()

  const [
    { data: violations, count: violationCount },
    { data: pendingApprovals, count: pendingCount },
    { data: recentAuditLogs },
    { data: agentSummary },
  ] = await Promise.all([
    // compliance_flags is the correct table (compliance_violations doesn't exist)
    service.from("compliance_flags")
      .select("id, violation_type, severity, status, created_at, user_id", { count: "exact" })
      .neq("status", "resolved")
      .order("created_at", { ascending: false })
      .limit(15),
    // approval_items is the correct table for pending approvals
    service.from("approval_items")
      .select("id, item_type, status, submitted_at, agent_id", { count: "exact" })
      .eq("brokerage_id", brokerageId)
      .eq("status", "pending")
      .limit(20),
    // audit_log (singular) is the correct table
    service.from("audit_log")
      .select("id, action, entity_type, created_at, user_id")
      .order("created_at", { ascending: false })
      .limit(25),
    service.from("agents")
      .select("id, user_id, is_active")
      .eq("brokerage_id", brokerageId)
      .eq("is_active", true)
      .limit(50),
  ])

  return {
    activeViolations: { count: violationCount ?? 0, recent: violations },
    pendingApprovals: { count: pendingCount ?? 0, items: pendingApprovals },
    recentAuditLogs,
    activeAgentCount: agentSummary?.length ?? 0,
    windowStart: thirtyDaysAgo,
  }
}

async function loadSuperadminContext(service: ReturnType<typeof createServiceClient>) {
  const [
    { data: brokerages, count: brokerageCount },
    { data: systemErrors },
    { data: recentUsers },
    { data: aiAuditSample },
  ] = await Promise.all([
    // brokerages table: no subscription_tier or is_active columns — use name + slug
    service.from("brokerages")
      .select("id, name, slug, city, state, created_at", { count: "exact" })
      .order("created_at", { ascending: false })
      .limit(20),
    service.from("automation_errors")
      .select("id, workflow_name, error_message, status, severity, created_at, brokerage_id")
      .order("created_at", { ascending: false })
      .limit(15),
    // users table: no last_sign_in_at column
    service.from("users")
      .select("id, email, user_type, created_at")
      .order("created_at", { ascending: false })
      .limit(10),
    service.from("ai_feedback_log")
      .select("id, source_record_type, rating, feedback_text, created_at")
      .order("created_at", { ascending: false })
      .limit(20),
  ])

  return {
    brokerages: { count: brokerageCount ?? 0, recent: brokerages },
    systemErrors,
    recentUsers,
    aiAuditSample,
  }
}

// ─── Build system prompt from role + context ─────────────────────────────────

interface AIIdentity {
  assistant_name: string
  persona_label: string
  tone: string
  formality_level: string
}

function buildSystemPrompt(role: string, ctx: Record<string, unknown>, identity?: AIIdentity): string {
  const name = identity?.assistant_name ?? "AI-ISA"
  const persona = identity?.persona_label ?? "internal assistant"
  const tone = identity?.tone ?? "professional"
  const formality = identity?.formality_level ?? "formal"

  const base = `You are ${name}, a ${persona} embedded in the Kernel OS real estate platform.
Role: ${role} | Tone: ${tone} | Formality: ${formality}
Date: ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}

TOOLS — use these when staff explicitly asks you to take an action:
  Read tools (information lookup):
  - lookup_contact: Search for contacts by name, email, or phone
  - get_today_schedule: Return today's showings and scheduled activities

  Write tools (mutating actions — call only when staff explicitly requests):
  - create_task: Create and assign a task
  - schedule_follow_up: Schedule a follow-up activity with a contact
  - send_portal_message: Send a message to a client through the portal
  - update_contact_status: Update a contact's CRM status
  - log_activity: Log a completed call, meeting, or interaction
  - draft_ai_reply: Generate a brand-voice reply DRAFT for review (does NOT auto-send)
  - advance_listing_stage: Move a listing forward in its lifecycle when prerequisites are met
  - advance_transaction_stage: Move a transaction forward through inspection / appraisal / financing / closing
  - stage_listing_packet: Runs the canonical voice → listing intake pipeline (multi-turn extract → fill → generate). Pass the agent's full transcript as voice_input. If intake is incomplete the tool returns follow-up questions for the next turn. When complete it returns open_url to the FormWizard.
  - stage_offer_packet: Same canonical pipeline for offers. Pass full transcript; supports multi-turn.
  - stage_newsletter_draft: Canonical createNewsletterCampaign (feature gate + brand voice intact)
  - stage_email_campaign: Canonical createEmailCampaign
  - stage_open_house: Schedule an open house on a listing (date + start_time + end_time)
  - stage_blog_draft: Canonical saveBlogPost
  - stage_podcast_episode: Canonical createPodcastEpisode (provider resolution + feature gate)
  - stage_video_project: Canonical createVideoProject
  - stage_direct_mail_campaign: Canonical createDirectMailCampaign (QR tracking + feature gate)
  - stage_ad_campaign: Canonical createAdCampaign from lib/ads (Facebook / Instagram / Google / LinkedIn / TikTok). Returns open_url to ads dashboard where agent generates AI creative + launches.

For all stage_* tools: when the result has open_url, speak it back so the agent knows where to navigate. If a stage_listing_packet or stage_offer_packet result has needs_more_info=true, relay the questions to the agent and call the same tool again on the next turn with the same session_id.

Only call a write tool when the instruction is clear and explicit. If you're missing a key parameter (contact name, listing id, date, target stage), ask one clarifying question first.

CAPABILITIES:
- Use tools above when staff explicitly asks ("create a task for...", "draft a reply to...", "advance the listing to active")
- Answer questions and summarize entities from the context below
- Explain processes, real estate terms, and platform features
- Suggest next actions based on context data and upcoming dates
- Flag urgency from dates and statuses
- Help draft notes for entities (shown as a draft card for human review before saving)
- Auto-suggest note drafts after high-signal exchanges (see NOTE_AUTO_DRAFT below)

RESTRICTIONS — never do any of these:
- Never take an action unless explicitly instructed — wait for the staff member to ask
- Never auto-send a message — always use draft_ai_reply so the agent can review and send
- Never access data outside the role-scoped context below
- Never give legal, financial, or tax advice
- Never reference other users' private data not in context
- Never save notes silently — always surface as a draft for human approval

NOTE_AUTO_DRAFT:
After responding to a genuinely high-signal exchange — such as a call outcome being discussed, a decision or agreement reached, an important fact shared (timeline, budget, motivation), or a follow-up promised — you MAY append the following marker ONCE at the very end of your response (after your main answer text).
Only emit this for genuinely noteworthy exchanges. Do NOT emit for routine questions or data lookups.
Format (flat JSON, no nested objects, no line breaks inside the JSON):
[NOTE_DRAFT:{"noteText":"brief clear note text","noteType":"general|call_outcome|meeting_outcome|follow_up|decision|action_item|observation","entityType":"contact|transaction|lead|general","entityId":"uuid_or_null","entityLabel":"name_or_null","confidence":"high|low","hasActionItem":false,"suggestedTaskTitle":null}]

When discussing outreach options for leads or contacts, note that direct mail is valid for leads with verified mailing addresses.
Use "AI-ISA" for AI operations — never "human ISA" unless referring to a human role.

ROLE-SCOPED CONTEXT:
${JSON.stringify(ctx, null, 2)}`

  return base
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  // Resolve role
  const { data: roleRow } = await supabase
    .from("user_role_assignments")
    .select("role, brokerage_id")
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle()

  const { data: userData } = await supabase
    .from("users")
    .select("role, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  const rawRole = (roleRow?.role ?? userData?.role ?? "agent").toLowerCase()
  // Normalise legacy role strings to canonical values
  const ROLE_ALIASES: Record<string, string> = {
    transaction_coordinator: "tc",
    compliance_manager: "compliance_officer",
    title: "title_agent",
    super_admin: "superadmin",
    platform_admin: "superadmin",
  }
  const role = ROLE_ALIASES[rawRole] ?? rawRole
  const brokerageId = (roleRow?.brokerage_id ?? userData?.brokerage_id) as string

  if (!PERMITTED_ROLES.has(role)) {
    return NextResponse.json({ error: "Role not permitted" }, { status: 403 })
  }

  const { messages } = await req.json()
  if (!messages || !Array.isArray(messages)) {
    return NextResponse.json({ error: "messages required" }, { status: 400 })
  }

  // Load role-scoped context + AI identity profile in parallel
  const service = createServiceClient()
  let ctx: Record<string, unknown> = {}
  let identity: AIIdentity | undefined

  // Load identity: agent-scope first, brokerage-scope fallback
  const [contextResult, agentIdentityResult] = await Promise.allSettled([
    (async () => {
      if (role === "agent" || role === "isa" || role === "team_lead") return loadAgentContext(service, user.id, brokerageId)
      else if (role === "broker" || role === "admin") return loadBrokerContext(service, brokerageId)
      else if (role === "lender") return loadLenderContext(service, user.id)
      else if (role === "vendor") return loadVendorContext(service, user.id, brokerageId)
      else if (role === "tc") return loadTCContext(service, user.id, brokerageId)
      else if (role === "title_agent") return loadTitleContext(service, user.id)
      else if (role === "compliance_officer") return loadComplianceContext(service, brokerageId)
      else if (role === "superadmin") return loadSuperadminContext(service)
      return {}
    })(),
    // scope_id at scope_type 'agent' is an agents.id (the editor writes it, and the
    // widget / voice / video / ISA readers all resolve it that way) — filtering by
    // the raw auth user id, as this did, could never match a saved persona.
    (async () => {
      const scopeAgentId = await resolveAgentId(service as any, user.id)
      if (!scopeAgentId) return { data: null }
      return service
        .from("ai_identity_profiles")
        .select("assistant_name, persona_label, tone, formality_level")
        .eq("scope_type", "agent")
        .eq("scope_id", scopeAgentId)
        .eq("active", true)
        .maybeSingle()
    })(),
  ])

  if (contextResult.status === "fulfilled") ctx = contextResult.value ?? {}

  if (agentIdentityResult.status === "fulfilled" && agentIdentityResult.value.data) {
    identity = agentIdentityResult.value.data as AIIdentity
  } else if (brokerageId) {
    // Fall back to brokerage-scope identity
    const { data: brokerageProfile } = await service
      .from("ai_identity_profiles")
      .select("assistant_name, persona_label, tone, formality_level")
      .eq("scope_type", "brokerage")
      .eq("scope_id", brokerageId)
      .eq("active", true)
      .maybeSingle()
    if (brokerageProfile) identity = brokerageProfile as AIIdentity
  }

  const systemPrompt = buildSystemPrompt(role, ctx, identity)

  // Persist session for this role if not yet created
  const sessionId = req.headers.get("x-internal-session-id")
  let newSessionId: string | null = null
  if (!sessionId) {
    const { data: newSession } = await service
      .from("chat_sessions")
      .insert({
        contact_id: null,
        brokerage_id: brokerageId,
        agent_id: await resolveAgentId(service as any, user.id),
        source: "internal",
        session_type: `internal_${role}`,
        status: "active",
        metadata: { role, user_id: user.id },
      })
      .select("id")
      .single()
    newSessionId = newSession?.id ?? null
  }

  // Persist the last user message
  if (sessionId) {
    const lastMsg = messages[messages.length - 1]
    if (lastMsg?.role === "user") {
      const textContent =
        Array.isArray(lastMsg.parts)
          ? lastMsg.parts.filter((p: { type: string }) => p.type === "text").map((p: { text: string }) => p.text).join("")
          : (lastMsg.content as string ?? "")

      service.from("chat_messages").insert({
        session_id: sessionId,
        role: "user",
        content: textContent,
        metadata: { source: "internal", role },
      }).then(() => {}, () => {})
    }
  }

  // ── Kernel OS action tools ──────────────────────────────────────────────────
  // Each tool writes to Supabase and returns a confirmation object.
  // The AI uses these when the staff member asks it to complete a task.

  const agentTools = {
    create_task: tool({
      description: "Create a task and assign it to the current agent. Use when staff asks to create or add a task.",
      inputSchema: z.object({
        title: z.string().describe("Short task title"),
        description: z.string().nullable().describe("Optional longer description"),
        priority: z.enum(["low", "normal", "high", "urgent"]).describe("Task priority"),
        due_date: z.string().nullable().describe("ISO date string YYYY-MM-DD or null"),
        contact_id: z.string().nullable().describe("UUID of related contact, or null"),
        transaction_id: z.string().nullable().describe("UUID of related transaction, or null"),
      }),
      execute: async ({ title, description, priority, due_date, contact_id, transaction_id }) => {
        const { data, error } = await service
          .from("tasks")
          .insert({
            brokerage_id: brokerageId,
            assigned_to_agent_id: await resolveAgentId(service as any, user.id),
            created_by_agent_id: await resolveAgentId(service as any, user.id),
            title,
            description: description ?? undefined,
            priority,
            due_date: due_date ?? undefined,
            contact_id: contact_id ?? undefined,
            transaction_id: transaction_id ?? undefined,
            status: "pending",
          })
          .select("id, title, due_date, priority")
          .maybeSingle()

        if (error || !data) return { success: false, error: error?.message ?? "Insert failed" }
        return { success: true, task_id: data.id, title: data.title, due_date: data.due_date, priority: data.priority }
      },
    }),

    schedule_follow_up: tool({
      description: "Schedule a follow-up activity with a contact. Use when staff says to follow up, call, or check in.",
      inputSchema: z.object({
        contact_id: z.string().describe("UUID of the contact to follow up with"),
        activity_type: z.enum(["call", "email", "text", "meeting", "check_in"]).describe("Type of follow-up"),
        scheduled_at: z.string().describe("ISO datetime string for when to follow up"),
        notes: z.string().nullable().describe("Optional notes about the follow-up"),
        title: z.string().describe("Short title, e.g. 'Follow-up call with John'"),
      }),
      execute: async ({ contact_id, activity_type, scheduled_at, notes, title }) => {
        const { data, error } = await service
          .from("activities")
          .insert({
            brokerage_id: brokerageId,
            agent_id: await resolveAgentId(service as any, user.id),
            contact_id,
            activity_type,
            scheduled_at,
            notes: notes ?? undefined,
            title,
            status: "scheduled",
          })
          .select("id, title, scheduled_at")
          .maybeSingle()

        if (error || !data) return { success: false, error: error?.message ?? "Insert failed" }
        return { success: true, activity_id: data.id, title: data.title, scheduled_at: data.scheduled_at }
      },
    }),

    send_portal_message: tool({
      description: "Send a message to a client via the portal. Use when staff asks to message or notify a client.",
      inputSchema: z.object({
        contact_id: z.string().describe("UUID of the contact"),
        message_body: z.string().describe("The message to send"),
      }),
      execute: async ({ contact_id, message_body }) => {
        // Verify contact belongs to this brokerage
        const { data: contact } = await service
          .from("contacts")
          .select("id, brokerage_id, agent_id")
          .eq("id", contact_id)
          .eq("brokerage_id", brokerageId)
          .maybeSingle()

        if (!contact) return { success: false, error: "Contact not found" }

        const { data, error } = await service
          .from("client_portal_messages")
          .insert({
            contact_id,
            // contact.agent_id IS an agents.id; the old `?? user.id` fallback was the
            // wrong class on a NOT NULL agents(id) FK. Resolve instead.
            agent_id: contact.agent_id ?? (await resolveAgentId(service as any, user.id)),
            brokerage_id: brokerageId,
            direction: "agent_to_client",
            channel: "portal",
            read: false,
            body: message_body,
            read_at: null,
          })
          .select("id")
          .maybeSingle()

        if (error || !data) return { success: false, error: error?.message ?? "Insert failed" }
        return { success: true, message_id: data.id, preview: message_body.slice(0, 80) }
      },
    }),

    update_contact_status: tool({
      description: "Update a contact's status in the CRM. Use when staff says to mark, update, or change a contact's status.",
      inputSchema: z.object({
        contact_id: z.string().describe("UUID of the contact"),
        status: z.string().describe("New status value, e.g. 'active', 'inactive', 'closed', 'prospect'"),
        notes: z.string().nullable().describe("Optional reason for the status change"),
      }),
      execute: async ({ contact_id, status, notes }) => {
        const { data, error } = await service
          .from("contacts")
          .update({ status, notes: notes ?? undefined, updated_at: new Date().toISOString() })
          .eq("id", contact_id)
          .eq("brokerage_id", brokerageId)
          .select("id, first_name, last_name, status")
          .maybeSingle()

        if (error || !data) return { success: false, error: error?.message ?? "Update failed" }
        return { success: true, contact_id: data.id, name: `${data.first_name ?? ""} ${data.last_name ?? ""}`.trim(), new_status: data.status }
      },
    }),

    log_activity: tool({
      description: "Log a completed activity or interaction. Use when staff reports a call outcome, meeting result, or any completed action.",
      inputSchema: z.object({
        contact_id: z.string().nullable().describe("UUID of related contact, or null"),
        transaction_id: z.string().nullable().describe("UUID of related transaction, or null"),
        activity_type: z.string().describe("Type: call, email, meeting, note, showing, etc."),
        title: z.string().describe("Brief title of the activity"),
        notes: z.string().describe("What happened — the outcome or result"),
      }),
      execute: async ({ contact_id, transaction_id, activity_type, title, notes }) => {
        const { data, error } = await service
          .from("activities")
          .insert({
            brokerage_id: brokerageId,
            agent_id: await resolveAgentId(service as any, user.id),
            contact_id: contact_id ?? undefined,
            transaction_id: transaction_id ?? undefined,
            activity_type,
            title,
            notes,
            status: "completed",
            completed_at: new Date().toISOString(),
          })
          .select("id, title")
          .maybeSingle()

        if (error || !data) return { success: false, error: error?.message ?? "Insert failed" }
        return { success: true, activity_id: data.id, title: data.title }
      },
    }),

    lookup_contact: tool({
      description: "Search for contacts by name, email, or phone. Returns up to 5 matches scoped to the current brokerage.",
      inputSchema: z.object({
        query: z.string().describe("Free-text search — name (full or partial), email, or phone digits"),
      }),
      execute: async ({ query }) => {
        const q = query.trim()
        if (q.length < 2) return { matches: [] }

        const phoneDigits = q.replace(/\D/g, "")
        const isPhone = phoneDigits.length >= 7

        let builder = service
          .from("contacts")
          .select("id, first_name, last_name, email, phone, contact_type, contact_persona, last_contacted_at")
          .eq("brokerage_id", brokerageId)
          .limit(5)

        if (isPhone) {
          builder = builder.ilike("phone", `%${phoneDigits.slice(-7)}%`)
        } else if (q.includes("@")) {
          builder = builder.ilike("email", `%${q}%`)
        } else {
          builder = builder.or(`first_name.ilike.%${q}%,last_name.ilike.%${q}%`)
        }

        const { data } = await builder
        return {
          matches: (data ?? []).map((c) => ({
            contact_id: c.id,
            name: `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || "(no name)",
            email: c.email,
            phone: c.phone,
            type: c.contact_type,
            persona: c.contact_persona,
            last_contact: c.last_contacted_at,
          })),
        }
      },
    }),

    get_today_schedule: tool({
      description: "Return today's showings and scheduled activities for the current agent.",
      inputSchema: z.object({}),
      execute: async () => {
        const startOfDay = new Date()
        startOfDay.setHours(0, 0, 0, 0)
        const endOfDay = new Date(startOfDay)
        endOfDay.setHours(23, 59, 59, 999)
        const startIso = startOfDay.toISOString()
        const endIso = endOfDay.toISOString()

        // pass 11: showings/activities.agent_id FK agents(id) — resolve first.
        const { resolveAgentId: _resolveAgentId } = await import("@/lib/kernel/agent-identity")
        const toolAgentId = (await _resolveAgentId(service as any, user.id)) ?? user.id
        const [showings, activities] = await Promise.all([
          service
            .from("showings")
            .select("id, scheduled_at, listing_id, contact_id, notes, status")
            .eq("agent_id", toolAgentId)
            .gte("scheduled_at", startIso)
            .lt("scheduled_at", endIso)
            .order("scheduled_at", { ascending: true }),
          service
            .from("activities")
            .select("id, scheduled_at, activity_type, title, contact_id, transaction_id")
            .eq("agent_id", toolAgentId)
            .eq("status", "scheduled")
            .gte("scheduled_at", startIso)
            .lt("scheduled_at", endIso)
            .order("scheduled_at", { ascending: true }),
        ])

        const appointments = [
          ...((showings.data ?? []).map((s) => ({
            time: s.scheduled_at,
            type: "showing" as const,
            title: s.notes ?? "Showing",
            status: s.status,
            listing_id: s.listing_id,
            contact_id: s.contact_id,
          }))),
          ...((activities.data ?? []).map((a) => ({
            time: a.scheduled_at,
            type: a.activity_type ?? "activity",
            title: a.title,
            contact_id: a.contact_id,
            transaction_id: a.transaction_id,
          }))),
        ].sort((a, b) => (a.time && b.time ? (a.time < b.time ? -1 : 1) : 0))

        return { count: appointments.length, appointments }
      },
    }),

    draft_ai_reply: tool({
      description:
        "Generate a brand-voice reply DRAFT for a contact. Looks up the contact's most recent inbound message and produces a draft for agent review. Does NOT auto-send.",
      inputSchema: z.object({
        contact_id: z.string().describe("UUID of the contact"),
      }),
      execute: async ({ contact_id }) => {
        // Verify contact in brokerage
        const { data: contact } = await service
          .from("contacts")
          .select("id, first_name, last_name")
          .eq("id", contact_id)
          .eq("brokerage_id", brokerageId)
          .maybeSingle()
        if (!contact) return { success: false, error: "Contact not found in your brokerage" }

        // Find most recent conversation for this contact
        const { data: convo } = await service
          .from("conversations")
          .select("id, type")
          .eq("contact_id", contact_id)
          .eq("brokerage_id", brokerageId)
          .order("last_message_at", { ascending: false })
          .limit(1)
          .maybeSingle()

        if (!convo) {
          return {
            success: false,
            error:
              "No conversation yet with this contact — start one in the inbox first, then ask me to draft a reply.",
          }
        }

        const rawChannel = (convo.type ?? "").toLowerCase()
        const draftChannel: "email" | "sms" | "in_app" =
          rawChannel === "email" ? "email" : rawChannel === "sms" ? "sms" : "in_app"

        const { data: lastInbound } = await service
          .from("messages")
          .select("id, body")
          .eq("conversation_id", convo.id)
          .eq("direction", "inbound")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle()

        const { generateAIReplyDraft } = await import("@/app/actions/ai-reply-coach")
        const result = await generateAIReplyDraft({
          brokerageId,
          agentUserId: user.id,
          conversationId: convo.id,
          contactId: contact_id,
          inboundMessageId: lastInbound?.id ?? null,
          inboundBody: lastInbound?.body ?? "",
          channel: draftChannel,
        })

        if (!result.success || !result.draftBody) {
          return { success: false, error: result.error ?? "Draft generation failed" }
        }
        return {
          success: true,
          draft_id: result.draftId,
          channel: draftChannel,
          conversation_id: convo.id,
          contact_name: `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim(),
          draft_body: result.draftBody,
          subject: result.draftSubject ?? null,
          tone: result.suggestedTone ?? null,
          note: "Draft saved for review. Open the inbox and tap Send when ready.",
        }
      },
    }),

    advance_listing_stage: tool({
      description:
        "Advance a listing to the next stage in its lifecycle (e.g. coming_soon → active, active → under_contract). Validates prerequisites via the listing-lifecycle kernel.",
      inputSchema: z.object({
        listing_id: z.string().describe("UUID of the listing"),
        target_stage: z.string().describe("The lifecycle stage key to advance to (e.g. 'mls_active', 'under_contract')"),
        notes: z.string().nullable().describe("Optional notes about the advance"),
      }),
      execute: async ({ listing_id, target_stage, notes }) => {
        // Verify listing belongs to brokerage
        const { data: listing } = await service
          .from("listings")
          .select("id, agent_id, address, lifecycle_stage")
          .eq("id", listing_id)
          .eq("brokerage_id", brokerageId)
          .maybeSingle()
        if (!listing) return { success: false, error: "Listing not found in your brokerage" }

        try {
          const { advanceListingStage } = await import("@/app/actions/listing-lifecycle")
          const result = await advanceListingStage(
            listing_id,
            target_stage,
            listing.agent_id ?? user.id,
            notes ?? undefined,
          )
          return {
            success: true,
            listing_id,
            from_stage: listing.lifecycle_stage,
            to_stage: target_stage,
            address: listing.address,
            result,
          }
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : "Stage advance failed",
          }
        }
      },
    }),

    advance_transaction_stage: tool({
      description:
        "Advance a transaction to the next stage (inspection → appraisal → financing → closing_prep → closed). Runs the transaction orchestrator which validates blockers before moving.",
      inputSchema: z.object({
        transaction_id: z.string().describe("UUID of the transaction"),
        target_stage: z
          .enum([
            "under_contract",
            "inspection",
            "appraisal",
            "financing",
            "closing_prep",
            "closed",
            "cancelled",
          ])
          .describe("The stage to advance to"),
        reason: z.string().nullable().describe("Optional reason for the stage change"),
      }),
      execute: async ({ transaction_id, target_stage, reason }) => {
        // Verify transaction belongs to brokerage
        const { data: txn } = await service
          .from("transactions")
          .select("id, stage, status, deal_name, property_address")
          .eq("id", transaction_id)
          .eq("brokerage_id", brokerageId)
          .maybeSingle()
        if (!txn) return { success: false, error: "Transaction not found in your brokerage" }

        try {
          const { advanceTransactionStage } = await import("@/app/actions/transaction-stage-machine")
          const result = await advanceTransactionStage({
            transactionId: transaction_id,
            brokerageId,
            targetStage: target_stage as never,
            reason: reason ?? undefined,
          })
          if (!result.success) {
            return {
              success: false,
              error: result.error ?? "Stage advance blocked",
              blockers: result.blockers ?? [],
            }
          }
          return {
            success: true,
            transaction_id,
            deal_name: txn.deal_name,
            address: txn.property_address,
            from_stage: txn.stage,
            to_stage: result.newStage,
          }
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : "Stage advance failed",
          }
        }
      },
    }),

    stage_listing_packet: tool({
      description:
        "Stage a NEW listing-agreement packet from what the agent just said or typed. Runs the canonical voice → listing intake pipeline (multi-turn extract → fill → generate). On first call the AI passes the whole transcript; if intake is incomplete the tool returns follow-up questions for the agent to answer in the next turn. When complete it returns open_url to the FormWizard. Use when the agent says 'create a listing', 'start a new listing at...', or 'list a property at...'.",
      inputSchema: z.object({
        voice_input: z.string().describe("The full transcript / typed text the agent gave — pass it through unchanged. The canonical extractor parses address, price, seller, terms, marketing obligations with per-field confidence."),
        session_id: z.string().nullable().describe("Continue a prior intake session (multi-turn)"),
        contact_id: z.string().nullable().describe("Linked seller contact UUID if known"),
      }),
      execute: async ({ voice_input, session_id, contact_id }) => {
        const { stageListingFromVoice } = await import("@/app/actions/wizard-staging")
        const result = await stageListingFromVoice({
          voiceInput: voice_input,
          sessionId: session_id ?? undefined,
          contactId: contact_id ?? undefined,
        })
        return result
      },
    }),

    stage_offer_packet: tool({
      description:
        "Stage a NEW offer packet from what the agent just said. Runs the canonical voice → offer intake pipeline (multi-turn extract → fill → generate). Use when the agent says 'write an offer for [contact] on [property] at [price]'. If intake is incomplete the tool returns follow-up questions; when complete it returns open_url to the FormWizard.",
      inputSchema: z.object({
        voice_input: z.string().describe("The full transcript / typed text — pass through unchanged."),
        session_id: z.string().nullable().describe("Continue a prior intake session"),
        contact_id: z.string().nullable().describe("Buyer contact UUID — find via lookup_contact first if needed"),
      }),
      execute: async ({ voice_input, session_id, contact_id }) => {
        const { stageOfferFromVoice } = await import("@/app/actions/wizard-staging")
        const result = await stageOfferFromVoice({
          voiceInput: voice_input,
          sessionId: session_id ?? undefined,
          contactId: contact_id ?? undefined,
        })
        return result
      },
    }),

    stage_newsletter_draft: tool({
      description:
        "Stage a NEW newsletter draft via the canonical createNewsletterCampaign pipeline (feature gate + brand voice intact). Use when the agent says 'create a newsletter', 'send a newsletter about X'. Returns open_url to the newsletter editor.",
      inputSchema: z.object({
        title: z.string().describe("Newsletter campaign name (e.g. 'October Market Update')"),
        subject_line: z.string().nullable().describe("Email subject line — defaults to title"),
        topic: z.string().nullable().describe("What the newsletter should be about — used to seed the intro section"),
        audience: z.string().nullable().describe("all | buyers | sellers | lifetime_customers | sphere"),
      }),
      execute: async ({ title, subject_line, topic, audience }) => {
        const { stageNewsletterDraft } = await import("@/lib/wizard-staging/content-staging")
        return stageNewsletterDraft(
          { brokerageId, userId: user.id },
          {
            title,
            subjectLine: subject_line ?? undefined,
            topic: topic ?? undefined,
            audience: audience ?? undefined,
          },
        )
      },
    }),

    stage_email_campaign: tool({
      description:
        "Stage a NEW email campaign draft via canonical createEmailCampaign (kernel feature gate + compliance pipeline). Use when the agent says 'send an email blast', 'create an email campaign about X'. Returns open_url.",
      inputSchema: z.object({
        campaign_name: z.string().describe("Internal campaign name"),
        subject_line: z.string().nullable().describe("Email subject line"),
        content: z.string().nullable().describe("Initial body copy if dictated"),
        send_date: z.string().nullable().describe("Scheduled send date/time ISO string"),
      }),
      execute: async ({ campaign_name, subject_line, content, send_date }) => {
        const { stageEmailCampaign } = await import("@/lib/wizard-staging/content-staging")
        return stageEmailCampaign(
          { brokerageId, userId: user.id },
          {
            campaignName: campaign_name,
            subjectLine: subject_line ?? undefined,
            content: content ?? undefined,
            sendDate: send_date ?? undefined,
          },
        )
      },
    }),

    stage_open_house: tool({
      description:
        "Schedule an open house on a specific listing. Use when the agent says 'schedule an open house for [listing] on [date]'. Requires listing_id, date, start_time, end_time. Look up the listing via get_active_listings first if you don't have the listing_id.",
      inputSchema: z.object({
        listing_id: z.string().describe("UUID of the listing"),
        date: z.string().describe("YYYY-MM-DD"),
        start_time: z.string().describe("HH:MM (24-hour)"),
        end_time: z.string().describe("HH:MM (24-hour)"),
        max_attendees: z.number().nullable().describe("Cap on attendees"),
        notes: z.string().nullable().describe("Agent-internal notes"),
        public_description: z.string().nullable().describe("Public-facing description for invites"),
      }),
      execute: async ({ listing_id, date, start_time, end_time, max_attendees, notes, public_description }) => {
        const { stageOpenHouse } = await import("@/lib/wizard-staging/content-staging")
        return stageOpenHouse(
          { brokerageId, userId: user.id },
          {
            listingId: listing_id,
            date,
            startTime: start_time,
            endTime: end_time,
            maxAttendees: max_attendees ?? undefined,
            notes: notes ?? undefined,
            publicDescription: public_description ?? undefined,
          },
        )
      },
    }),

    stage_blog_draft: tool({
      description:
        "Stage a NEW blog post draft via canonical saveBlogPost (feature gate + brand voice). Use when the agent says 'write a blog post about X'. Returns open_url to the blog editor.",
      inputSchema: z.object({
        title: z.string().describe("Blog post title"),
        topic: z.string().nullable().describe("What the post should cover — seeded into the body"),
        category: z.string().nullable().describe("market_insights | buyer_guides | seller_guides | local_lifestyle | community"),
      }),
      execute: async ({ title, topic, category }) => {
        const { stageBlogDraft } = await import("@/lib/wizard-staging/content-staging")
        return stageBlogDraft(
          { brokerageId, userId: user.id },
          { title, topic: topic ?? undefined, category: category ?? undefined },
        )
      },
    }),

    stage_podcast_episode: tool({
      description:
        "Stage a NEW podcast episode via canonical createPodcastEpisode (feature gate + provider resolution). Use when the agent says 'start a podcast on X'. Returns open_url to the podcast studio.",
      inputSchema: z.object({
        title: z.string().describe("Episode title"),
        description: z.string().nullable().describe("Show notes / episode description"),
        script: z.string().nullable().describe("Initial script if dictated"),
        category: z.string().nullable().describe("market_update | how_to | interview | story | educational"),
        keywords: z.array(z.string()).nullable().describe("Keywords for SEO + categorization"),
      }),
      execute: async ({ title, description, script, category, keywords }) => {
        const { stagePodcastEpisode } = await import("@/lib/wizard-staging/content-staging")
        return stagePodcastEpisode(
          { brokerageId, userId: user.id },
          {
            title,
            description: description ?? undefined,
            script: script ?? undefined,
            category: category ?? undefined,
            keywords: keywords ?? undefined,
          },
        )
      },
    }),

    stage_video_project: tool({
      description:
        "Stage a NEW video project via canonical createVideoProject. Use when the agent says 'create a video about X'. Returns open_url to the video studio.",
      inputSchema: z.object({
        title: z.string().describe("Video title"),
        script: z.string().nullable().describe("Initial script if dictated"),
        video_type: z.string().nullable().describe("listing_walkthrough | market_update | testimonial | educational"),
        format: z.enum(["vertical", "horizontal", "square"]).nullable().describe("Aspect ratio"),
        duration_seconds: z.number().nullable().describe("Target duration"),
        listing_id: z.string().nullable().describe("Linked listing UUID for walkthroughs"),
      }),
      execute: async ({ title, script, video_type, format, duration_seconds, listing_id }) => {
        const { stageVideoProject } = await import("@/lib/wizard-staging/content-staging")
        return stageVideoProject(
          { brokerageId, userId: user.id },
          {
            title,
            script: script ?? undefined,
            videoType: video_type ?? undefined,
            format: format ?? undefined,
            durationSeconds: duration_seconds ?? undefined,
            listingId: listing_id ?? undefined,
          },
        )
      },
    }),

    stage_direct_mail_campaign: tool({
      description:
        "Stage a NEW direct mail campaign via canonical createDirectMailCampaign (feature gate + QR tracking). Use when the agent says 'send postcards to past clients', 'mail thank-you notes'. Returns open_url.",
      inputSchema: z.object({
        campaign_name: z.string().describe("Internal name"),
        target_audience: z.string().describe("Who to send to — past_clients, sphere, farm_zip_xxxx, etc."),
        piece_type: z
          .enum(["postcard_4x6", "postcard_6x9", "postcard_6x11", "letter", "handwritten", "thank_you_note"])
          .nullable()
          .describe("Mail piece type"),
        budget: z.number().nullable().describe("Budget in dollars (determines quantity)"),
        send_date: z.string().nullable().describe("Mailing date (YYYY-MM-DD)"),
        copy_text: z.string().nullable().describe("Initial copy if dictated"),
      }),
      execute: async ({ campaign_name, target_audience, piece_type, budget, send_date, copy_text }) => {
        const { stageDirectMailCampaign } = await import("@/lib/wizard-staging/content-staging")
        return stageDirectMailCampaign(
          { brokerageId, userId: user.id },
          {
            campaignName: campaign_name,
            targetAudience: target_audience,
            pieceType: piece_type ?? undefined,
            budget: budget ?? undefined,
            sendDate: send_date ?? undefined,
            copyText: copy_text ?? undefined,
          },
        )
      },
    }),

    stage_ad_campaign: tool({
      description:
        "Stage a NEW ad campaign via canonical createAdCampaign from lib/ads (feature gate + lifecycle event). Use when the agent says 'launch a Facebook ad for [listing]', 'run a lead-gen ad on Google'. Returns open_url to the ads dashboard where the agent generates AI creative variations and launches.",
      inputSchema: z.object({
        campaign_name: z.string().describe("Internal campaign name"),
        platform: z.enum(["facebook", "instagram", "google", "linkedin", "tiktok"]).describe("Ad platform"),
        objective: z.enum(["awareness", "traffic", "leads", "conversions"]).describe("Campaign objective"),
        daily_budget: z.number().nullable().describe("Daily budget in dollars"),
        lifetime_budget: z.number().nullable().describe("Lifetime budget cap"),
        start_date: z.string().nullable().describe("Start date YYYY-MM-DD"),
        end_date: z.string().nullable().describe("End date YYYY-MM-DD"),
        city: z.string().nullable().describe("Target city"),
        state: z.string().nullable().describe("Target state"),
        age_min: z.number().nullable().describe("Minimum target age"),
        age_max: z.number().nullable().describe("Maximum target age"),
      }),
      execute: async ({ campaign_name, platform, objective, daily_budget, lifetime_budget, start_date, end_date, city, state, age_min, age_max }) => {
        const { stageAdCampaign } = await import("@/lib/wizard-staging/content-staging")
        return stageAdCampaign(
          { brokerageId, userId: user.id },
          {
            campaignName: campaign_name,
            platform,
            objective,
            dailyBudget: daily_budget ?? undefined,
            lifetimeBudget: lifetime_budget ?? undefined,
            startDate: start_date ?? undefined,
            endDate: end_date ?? undefined,
            city: city ?? undefined,
            state: state ?? undefined,
            ageMin: age_min ?? undefined,
            ageMax: age_max ?? undefined,
          },
        )
      },
    }),
  }

  const result = streamText({
      model: resolveModel("openai/gpt-4o-mini"),
    system: systemPrompt,
    messages: await convertToModelMessages(messages),
    maxOutputTokens: 1024,
    tools: agentTools,
    stopWhen: stepCountIs(5),
    onFinish: async ({ text }) => {
      if (!sessionId) return
      await service.from("chat_messages").insert({
        session_id: sessionId,
        role: "assistant",
        content: text,
        metadata: { source: "internal", role },
      }).then(() => {}, () => {})
    },
  })

  const streamResponse = result.toUIMessageStreamResponse()
  const resolvedSessionId = sessionId ?? newSessionId
  if (resolvedSessionId && !sessionId) {
    streamResponse.headers.set("x-session-id", resolvedSessionId)
  }
  return streamResponse
}

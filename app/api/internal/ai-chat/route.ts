import { createClient } from "@/lib/supabase/server"
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

  const [{ data: contacts }, { data: transactions }, { data: tasks }, { data: leads }] = await Promise.all([
    service.from("contacts")
      .select("id, first_name, last_name, email, phone, contact_persona, status, buyer_stage, engagement_score, intent_score")
      .eq("agent_id", userId).eq("brokerage_id", brokerageId)
      .order("updated_at", { ascending: false }).limit(20),
    service.from("transactions")
      .select("id, deal_name, property_address, status, stage, close_date, purchase_price, health_score")
      .eq("agent_id", userId).eq("brokerage_id", brokerageId)
      .not("status", "eq", "closed").limit(10),
    service.from("tasks")
      .select("id, title, status, priority, due_date, transaction_id, contact_id")
      .eq("assigned_to_agent_id", userId)
      .lte("due_date", new Date(Date.now() + 7 * 86400000).toISOString().split("T")[0])
      .neq("status", "completed").limit(15),
    service.from("leads")
      .select("id, first_name, last_name, lead_stage, lead_score, lifecycle_state, created_at")
      .eq("agent_id", userId).eq("brokerage_id", brokerageId)
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
  const { data: lenderTxns } = await service
    .from("lender_portal_users")
    .select(`
      transaction_id, lender_company,
      transactions (id, deal_name, property_address, status, close_date, buyer_contact_id,
        contacts!buyer_contact_id(first_name, last_name)),
      transaction_lenders!inner (lender_name, underwriting_status, clear_to_close_date)
    `)
    .eq("user_id", userId)
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

You can take real actions on behalf of staff when asked. Available tools:
- create_task: Create and assign a task
- schedule_follow_up: Schedule a follow-up activity with a contact
- send_portal_message: Send a message to a client through the portal
- update_contact_status: Update a contact's CRM status
- log_activity: Log a completed call, meeting, or interaction

When staff asks you to DO something (not just explain), use the appropriate tool. Confirm back with the result. Only call a tool when the instruction is clear — ask for clarification if you need a contact name or date.

CAPABILITIES:
- Answer questions and summarize entities from the context below
- Draft messages/emails for review (always label as DRAFT — never auto-send or auto-update records)
- Explain processes, real estate terms, and platform features
- Suggest next actions based on context data and upcoming dates
- Flag urgency from dates and statuses
- Help draft notes for entities (shown as a draft card for human review before saving)
- Auto-suggest note drafts after high-signal exchanges (see NOTE_AUTO_DRAFT below)

RESTRICTIONS — never do any of these:
- Take actions (send emails, update records, approve documents)
- Access data outside the role-scoped context below
- Give legal, financial, or tax advice
- Reference other users' private data not in context
- Save notes silently — always surface as a draft for human approval

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
    service
      .from("ai_identity_profiles")
      .select("assistant_name, persona_label, tone, formality_level")
      .eq("scope_type", "agent")
      .eq("scope_id", user.id)
      .eq("active", true)
      .maybeSingle(),
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

  // Persist session for this role if not yet created (fire-and-forget)
  const sessionId = req.headers.get("x-internal-session-id")
  if (!sessionId) {
    service.from("chat_sessions").insert({
      contact_id: null,
      brokerage_id: brokerageId,
      agent_id: user.id,
      source: "internal",
      session_type: `internal_${role}`,
      status: "active",
      metadata: { role, user_id: user.id },
    }).then(({ data }) => {
      if (data) {
        // Return session ID via header on first message handled by client
      }
    }).catch(() => {})
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
      }).catch(() => {})
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
            assigned_to_agent_id: user.id,
            created_by_agent_id: user.id,
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
            agent_id: user.id,
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
            agent_id: contact.agent_id ?? user.id,
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
            agent_id: user.id,
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
      }).catch(() => {})
    },
  })

  return result.toUIMessageStreamResponse()
}

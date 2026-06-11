import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { generateText } from "ai"
import { resolveModel } from "@/lib/ai/resolve-model"
import { NextRequest, NextResponse } from "next/server"

// ─── Intent types the voice assistant understands ────────────────────────────
type VoiceIntent =
  | "query_showings"
  | "query_hot_contacts"
  | "query_tasks"
  | "query_transactions"
  | "query_pipeline"
  | "create_task"
  | "schedule_followup"
  | "team_query"
  | "general_query"

interface CallQueueItem {
  contactId: string
  name: string
  phone: string
  score: number
  reason: string
}

interface VoiceCommandResponse {
  spokenResponse: string
  intent: VoiceIntent
  action: string | null
  callQueue: CallQueueItem[]
  data: Record<string, unknown>
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { transcript, sessionId } = await req.json()
  if (!transcript || typeof transcript !== "string") {
    return NextResponse.json({ error: "transcript required" }, { status: 400 })
  }

  const service = createServiceClient()

  // Get user profile for brokerage_id and agent record
  const { data: profile } = await service
    .from("users")
    .select("id, user_type, brokerage_id, first_name")
    .eq("id", user.id)
    .maybeSingle()

  if (!profile) return NextResponse.json({ error: "User not found" }, { status: 404 })

  const brokerageId = profile.brokerage_id
  const today = new Date().toISOString().slice(0, 10)
  const startOfWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

  // ── Classify intent using AI ──────────────────────────────────────────────
  const classifyResult = await generateText({
      model: resolveModel("openai/gpt-4o-mini"),
    system: `Classify the real estate assistant voice command into one of these intents:
- query_showings: asking about today's or upcoming showings
- query_hot_contacts: asking about hot leads, top contacts, who to call
- query_tasks: asking about tasks, to-dos, overdue items
- query_transactions: asking about active deals or transactions
- query_pipeline: asking about leads in pipeline or follow-ups needed
- create_task: asking to create, add, or set a task reminder
- schedule_followup: asking to schedule a follow-up
- team_query: addressing the whole team ("hey team", "ask the team") OR asking what's happening with a SPECIFIC named person/client/family
- general_query: anything else

Respond with ONLY the intent string, nothing else.`,
    messages: [{ role: "user", content: transcript }],
    maxOutputTokens: 20,
  })

  const intent = (classifyResult.text.trim().toLowerCase() as VoiceIntent) ?? "general_query"

  let spokenResponse = ""
  let callQueue: CallQueueItem[] = []
  let data: Record<string, unknown> = {}
  let action: string | null = null

  // ── Resolve data by intent ────────────────────────────────────────────────
  try {
    if (intent === "query_showings") {
      const { data: showings } = await service
        .from("showings")
        .select("id, scheduled_at, scheduled_date, scheduled_time, status, contacts(first_name, last_name), listings(address, city)")
        .eq("agent_id", user.id)
        .gte("scheduled_date", today)
        .lte("scheduled_date", new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10))
        .order("scheduled_date", { ascending: true })
        .limit(10)

      const todayShowings = (showings ?? []).filter((s) => s.scheduled_date === today)
      const upcomingShowings = (showings ?? []).filter((s) => s.scheduled_date !== today)
      data = { todayShowings, upcomingShowings }

      if (todayShowings.length === 0 && upcomingShowings.length === 0) {
        spokenResponse = "You have no showings scheduled for today or the next three days."
      } else if (todayShowings.length > 0) {
        const names = todayShowings.map((s) => {
          const c = s.contacts as { first_name?: string; last_name?: string } | null
          const l = s.listings as { address?: string; city?: string } | null
          const name = c ? `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() : "a client"
          const addr = l?.address ?? "unknown address"
          return `${name} at ${addr} at ${s.scheduled_time ?? "TBD"}`
        })
        spokenResponse = `You have ${todayShowings.length} showing${todayShowings.length > 1 ? "s" : ""} today. ${names.join(". ")}.`
      } else {
        spokenResponse = `No showings today, but you have ${upcomingShowings.length} coming up this week.`
      }
    } else if (intent === "query_hot_contacts") {
      // Pull contacts with highest intent_score or engagement_score, with phone numbers
      const { data: contacts } = await service
        .from("contacts")
        .select("id, first_name, last_name, phone, intent_score, engagement_score, buyer_stage, status")
        .eq("agent_id", user.id)
        .eq("brokerage_id", brokerageId)
        .neq("phone", null)
        .neq("call_stop_flag", true)
        .neq("dnc_status", true)
        .order("intent_score", { ascending: false, nullsFirst: false })
        .limit(5)

      callQueue = (contacts ?? [])
        .filter((c) => c.phone)
        .map((c) => ({
          contactId: c.id,
          name: `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || "Unknown",
          phone: c.phone!,
          score: c.intent_score ?? c.engagement_score ?? 0,
          reason: c.buyer_stage ? `Stage: ${c.buyer_stage.replace(/_/g, " ")}` : "High intent score",
        }))

      data = { contacts: callQueue }

      if (callQueue.length === 0) {
        spokenResponse = "You have no hot contacts with phone numbers right now."
      } else {
        const names = callQueue.slice(0, 3).map((c) => c.name).join(", ")
        spokenResponse = `Your top ${Math.min(callQueue.length, 5)} hot contacts are ${names}${callQueue.length > 3 ? `, and ${callQueue.length - 3} more` : ""}. I've queued their numbers for you.`
      }
    } else if (intent === "query_tasks") {
      const { data: tasks } = await service
        .from("tasks")
        .select("id, title, due_date, priority, status, contacts(first_name, last_name)")
        .eq("assigned_to_agent_id", user.id)
        .eq("brokerage_id", brokerageId)
        .neq("status", "completed")
        .order("due_date", { ascending: true, nullsFirst: false })
        .limit(5)

      const overdue = (tasks ?? []).filter((t) => t.due_date && t.due_date < today)
      const dueToday = (tasks ?? []).filter((t) => t.due_date === today)
      data = { overdue, dueToday, total: tasks?.length ?? 0 }

      if (!tasks?.length) {
        spokenResponse = "You have no pending tasks."
      } else if (overdue.length > 0) {
        spokenResponse = `You have ${overdue.length} overdue task${overdue.length > 1 ? "s" : ""} and ${dueToday.length} due today. Your most urgent is: ${overdue[0].title}.`
      } else if (dueToday.length > 0) {
        spokenResponse = `You have ${dueToday.length} task${dueToday.length > 1 ? "s" : ""} due today. First up: ${dueToday[0].title}.`
      } else {
        spokenResponse = `You have ${tasks.length} upcoming task${tasks.length > 1 ? "s" : ""}. Next: ${tasks[0].title}.`
      }
    } else if (intent === "query_transactions") {
      const { data: transactions } = await service
        .from("transactions")
        .select("id, deal_name, status, stage, close_date, purchase_price, contacts(first_name, last_name)")
        .eq("agent_id", user.id)
        .eq("brokerage_id", brokerageId)
        .not("status", "eq", "closed")
        .order("close_date", { ascending: true, nullsFirst: false })
        .limit(5)

      data = { transactions: transactions ?? [] }

      if (!transactions?.length) {
        spokenResponse = "You have no active transactions right now."
      } else {
        spokenResponse = `You have ${transactions.length} active deal${transactions.length > 1 ? "s" : ""}. ${transactions.slice(0, 2).map((t) => `${t.deal_name ?? "Untitled"} in ${t.stage ?? "unknown stage"}`).join(". ")}.`
      }
    } else if (intent === "query_pipeline") {
      const { data: leads } = await service
        .from("contacts")
        .select("id, first_name, last_name, intent_score, buyer_stage, last_contacted_at")
        .eq("agent_id", user.id)
        .eq("brokerage_id", brokerageId)
        .not("buyer_stage", "is", null)
        .order("intent_score", { ascending: false, nullsFirst: false })
        .limit(5)

      const needFollowup = (leads ?? []).filter(
        (l) => !l.last_contacted_at || new Date(l.last_contacted_at) < new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      )
      data = { leads: leads ?? [], needFollowup }
      spokenResponse = needFollowup.length > 0
        ? `${needFollowup.length} contact${needFollowup.length > 1 ? "s" : ""} in your pipeline haven't been contacted in over a week. Top one is ${needFollowup[0].first_name ?? "Unknown"}.`
        : `You have ${leads?.length ?? 0} active leads in your pipeline. All have been contacted recently.`
    } else if (intent === "team_query") {
      // "HEY TEAM—" — the bullpen question: every manager contributes what its own
      // tables know about the named person; one manager-attributed spoken answer.
      // Read-only: the team reports, acting still goes through the gate.
      const extract = await generateText({
        model: resolveModel("openai/gpt-4o-mini"),
        system: `Extract the person/family name the user is asking about. Respond with ONLY the name (e.g. "Henderson" or "Jordan Henderson"). If no name is present, respond with NONE.`,
        messages: [{ role: "user", content: transcript }],
        maxOutputTokens: 12,
      })
      const personQuery = extract.text.trim()
      if (!personQuery || personQuery.toUpperCase() === "NONE" || !brokerageId) {
        spokenResponse = "Who should I ask the team about? Give me a name and I'll pull everything the managers know."
      } else {
        const { runTeamQuery } = await import("@/lib/kernel/team-query")
        const tq = await runTeamQuery(brokerageId, personQuery, {}, service)
        spokenResponse = tq.spoken
        data = { contactId: tq.contactId, contributions: tq.contributions }
        action = tq.found ? "team_query_answered" : null
      }
    } else {
      // General query — pass to the main AI chat endpoint context
      spokenResponse = "Got it. I'm sending that to the assistant for you."
      action = "forward_to_chat"
    }
  } catch {
    spokenResponse = "I ran into an issue getting that data. Please try again."
  }

  // ── Log to voice_commands ────────────────────────────────────────────────
  await service
    .from("voice_commands")
    .insert({
      user_id: user.id,
      brokerage_id: brokerageId,
      raw_transcript: transcript,
      parsed_intent: intent,
      command_type: intent,
      entities: data,
      action_taken: action ?? intent,
      action_result: { spokenResponse, callQueueCount: callQueue.length },
      success: true,
      source: "voice_assistant",
    })
    .then(() => {}, () => {}) // non-fatal

  const response: VoiceCommandResponse = {
    spokenResponse,
    intent,
    action,
    callQueue,
    data,
  }

  return NextResponse.json(response)
}

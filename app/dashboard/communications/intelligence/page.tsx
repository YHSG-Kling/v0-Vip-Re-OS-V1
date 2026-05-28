import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import IntelligenceClient from "./IntelligenceClient"

export const metadata = {
  title: "Communication Intelligence | VIP Real Estate OS",
  description: "Conversation health scores, audit flags, and AI-driven insights.",
}

export default async function IntelligencePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const service = createServiceClient()

  // Resolve user profile
  const { data: profile } = await service
    .from("users")
    .select("id, brokerage_id, user_type")
    .eq("id", user.id)
    .single()

  if (!profile?.brokerage_id) redirect("/dashboard/onboarding")

  const brokerageId: string = profile.brokerage_id
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const todayISO = today.toISOString()
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

  // ── KPI queries (all parallel) ──────────────────────────────────────────────
  const [
    healthScoreRes,
    pendingTodayRes,
    fairHousingRes,
    escalationsRes,
    chartRawRes,
    insightsRes,
    auditFlagsRes,
    agentInsightsRes,
    voiceInsightsRes,
  ] = await Promise.all([
    // 1. avg health_score from conversation_insights (joined to conversations scoped by brokerage)
    service
      .from("conversation_insights")
      .select("health_score, conversations!inner(brokerage_id)")
      .eq("conversations.brokerage_id", brokerageId),

    // 2. pending flags today — conversation_audit_flags → conversation_logs
    service
      .from("conversation_audit_flags")
      .select("id", { count: "exact", head: true })
      .eq("review_status", "pending")
      .gte("created_at", todayISO),

    // 3. fair housing pending
    service
      .from("conversation_audit_flags")
      .select("id", { count: "exact", head: true })
      .eq("risk_type", "fair_housing")
      .eq("review_status", "pending"),

    // 4. escalations recommended last 7 days
    service
      .from("conversation_insights")
      .select("id", { count: "exact", head: true })
      .eq("escalation_recommended", true)
      .gte("updated_at", sevenDaysAgo),

    // 5. chart data — last 30 days health scores grouped by date + voice flag
    service
      .from("conversation_insights")
      .select("health_score, is_voice_conversation, updated_at, conversations!inner(brokerage_id)")
      .eq("conversations.brokerage_id", brokerageId)
      .gte("updated_at", thirtyDaysAgo),

    // 6. health tab insights table
    // NOTE: actual columns are sentiment_trajectory (not trajectory) and
    //       response_time_avg_seconds (not response_time_avg)
    service
      .from("conversation_insights")
      .select(`
        id,
        health_score,
        overall_sentiment,
        sentiment_trajectory,
        response_time_avg_seconds,
        unanswered_questions_count,
        escalation_recommended,
        updated_at,
        key_topics,
        conversations!inner(
          id,
          brokerage_id,
          contacts(id, first_name, last_name, email),
          agents(id, users(first_name, last_name))
        )
      `)
      .eq("conversations.brokerage_id", brokerageId)
      .order("updated_at", { ascending: false })
      .limit(100),

    // 7. audit flags — conversation_audit_flags → conversation_logs
    service
      .from("conversation_audit_flags")
      .select(`
        id,
        conversation_id,
        risk_type,
        risk_score,
        explanation,
        flagged_text,
        recommended_action,
        review_status,
        created_at,
        conversation:conversation_logs(
          contact_id,
          agent_id,
          start_time,
          topics_discussed
        )
      `)
      .order("risk_score", { ascending: false })
      .limit(100),

    // 8. coaching — per-agent aggregated insights
    // NOTE: DB column is response_time_avg_seconds (not response_time_avg)
    service
      .from("conversation_insights")
      .select(`
        agent_id,
        health_score,
        overall_sentiment,
        response_time_avg_seconds,
        objections_raised,
        buying_signals,
        conversations!inner(
          brokerage_id,
          agents(id, users(first_name, last_name))
        )
      `)
      .eq("conversations.brokerage_id", brokerageId)
      .gte("updated_at", thirtyDaysAgo),

    // 9. voice insights — is_voice_conversation = true
    // NOTE: voice_calls FK is via vapi_call_id on conversation_insights, not a direct conversations FK.
    // We fetch contact + agent from conversations, then join voice_calls separately below.
    service
      .from("conversation_insights")
      .select(`
        id,
        conversation_id,
        health_score,
        overall_sentiment,
        voice_quality_score,
        interruption_count,
        silence_duration_seconds,
        call_completion_status,
        updated_at,
        conversations!inner(
          id,
          brokerage_id,
          contacts(id, first_name, last_name),
          agents(id, users(first_name, last_name))
        )
      `)
      .eq("is_voice_conversation", true)
      .eq("conversations.brokerage_id", brokerageId)
      .order("updated_at", { ascending: false })
      .limit(50),
  ])

  // ── Compute KPI values ──────────────────────────────────────────────────────
  const healthRows = healthScoreRes.data ?? []
  const avgHealthScore =
    healthRows.length > 0
      ? healthRows.reduce((s: number, r: any) => s + (r.health_score ?? 0), 0) / healthRows.length
      : 0

  const pendingFlagsToday       = pendingTodayRes.count ?? 0
  const fairHousingPending      = fairHousingRes.count ?? 0
  const escalationsLast7Days    = escalationsRes.count ?? 0

  // ── Build chart data (bucket by day) ────────────────────────────────────────
  const chartRaw = chartRawRes.data ?? []
  const dayMap = new Map<string, { text: number[]; voice: number[] }>()

  for (const row of chartRaw) {
    const d = new Date(row.updated_at)
    const key = `${d.getMonth() + 1}/${d.getDate()}`
    if (!dayMap.has(key)) dayMap.set(key, { text: [], voice: [] })
    const bucket = dayMap.get(key)!
    if (row.is_voice_conversation) bucket.voice.push(row.health_score ?? 0)
    else bucket.text.push(row.health_score ?? 0)
  }

  const avg = (arr: number[]) => arr.length > 0 ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 100) : 0

  const chartData = Array.from(dayMap.entries())
    .sort(([a], [b]) => new Date(`2024/${a}`).getTime() - new Date(`2024/${b}`).getTime())
    .map(([date, { text, voice }]) => ({
      date,
      text_score: avg(text),
      voice_score: avg(voice),
    }))

  // ── Shape health table rows ──────────────────────────────────────────────────
  const healthInsights = (insightsRes.data ?? []).map((row: any) => {
    const conv    = row.conversations
    const contact = conv?.contacts
    const agent   = conv?.agents
    return {
      id:                          row.id,
      contact_name:                contact ? `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim() || "Unknown" : "Unknown",
      agent_name:                  agent?.users ? `${agent.users.first_name ?? ""} ${agent.users.last_name ?? ""}`.trim() || "—" : "—",
      overall_sentiment:           row.overall_sentiment ?? "neutral",
      // DB column: sentiment_trajectory (not trajectory)
      trajectory:                  row.sentiment_trajectory ?? "stable",
      health_score:                row.health_score ?? 0,
      // DB column: response_time_avg_seconds (not response_time_avg)
      response_time_avg:           row.response_time_avg_seconds ?? null,
      unanswered_questions_count:  row.unanswered_questions_count ?? 0,
      escalation_recommended:      row.escalation_recommended ?? false,
      updated_at:                  row.updated_at,
    }
  })

  // ── Coaching: group by agent_id ──────────────────────────────────────────────
  type AgentBucket = {
    agent_id: string
    agent_name: string
    health_scores: number[]
    sentiment_scores: number[]
    response_times: number[]
    objections: string[]
    signals: string[]
  }
  const agentMap = new Map<string, AgentBucket>()

  for (const row of (agentInsightsRes.data ?? []) as any[]) {
    const conv = row.conversations
    const agent = conv?.agents
    const aid: string = row.agent_id ?? agent?.id ?? "unknown"
    const aname: string = agent?.users
      ? `${agent.users.first_name ?? ""} ${agent.users.last_name ?? ""}`.trim() || "Unknown Agent"
      : "Unknown Agent"
    if (!agentMap.has(aid)) {
      agentMap.set(aid, { agent_id: aid, agent_name: aname, health_scores: [], sentiment_scores: [], response_times: [], objections: [], signals: [] })
    }
    const bucket = agentMap.get(aid)!
    if (row.health_score != null) bucket.health_scores.push(row.health_score * 100)
    // DB column: response_time_avg_seconds
    if (row.response_time_avg_seconds != null) bucket.response_times.push(row.response_time_avg_seconds)
    if (Array.isArray(row.objections_raised)) bucket.objections.push(...row.objections_raised)
    if (Array.isArray(row.buying_signals)) bucket.signals.push(...row.buying_signals)
    // Map sentiment string to 0-100 numeric score
    const sentMap: Record<string, number> = { positive: 80, neutral: 50, negative: 20 }
    bucket.sentiment_scores.push(sentMap[row.overall_sentiment ?? "neutral"] ?? 50)
  }

  const avgArr = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0

  const agentInsights = Array.from(agentMap.values()).map(b => ({
    agent_id:                 b.agent_id,
    agent_name:               b.agent_name,
    avg_sentiment_score:      Math.round(avgArr(b.sentiment_scores)),
    avg_health_score:         Math.round(avgArr(b.health_scores)),
    objections_raised:        b.objections,
    buying_signals:           b.signals,
    response_time_avg_seconds: b.response_times.length > 0 ? avgArr(b.response_times) : null,
    conversation_count:       b.health_scores.length,
  }))

  const allResponseTimes = agentInsights.flatMap(a => a.response_time_avg_seconds != null ? [a.response_time_avg_seconds] : [])
  const teamAvgResponseTime = allResponseTimes.length > 0 ? avgArr(allResponseTimes) : 0

  // ── Topic frequency from key_topics jsonb[] ───────────────────────────────
  const topicFreqMap: Record<string, number> = {}
  for (const row of (insightsRes.data ?? []) as any[]) {
    if (Array.isArray(row.key_topics)) {
      for (const t of row.key_topics) {
        if (typeof t === "string") topicFreqMap[t] = (topicFreqMap[t] ?? 0) + 1
      }
    }
  }
  const topicFrequency = Object.entries(topicFreqMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([topic, count]) => ({ topic, count }))

  // ── Voice insights ────────────────────────────────────────────────────────
  // Fetch voice_calls separately — there is no direct FK from conversations to voice_calls.
  // voice_calls links to conversation_insights via vapi_call_id (stored on voice_calls).
  // We fetch by contact_id overlap for the same brokerage.
  const voiceInsightRows = voiceInsightsRes.data ?? []
  const voiceConversationIds = voiceInsightRows.map((r: any) => r.conversations?.id).filter(Boolean)

  const voiceCallMap: Record<string, { recording_url: string | null; transcription: string | null }> = {}
  if (voiceConversationIds.length > 0) {
    // voice_calls does not have a direct conversation_id FK; join via agent_id + contact_id proximity.
    // Best available match: fetch voice_calls for the brokerage, match by contact_id from the conversation.
    const contactIds = voiceInsightRows
      .map((r: any) => r.conversations?.contacts?.id)
      .filter(Boolean)
    if (contactIds.length > 0) {
      const { data: vcRows } = await service
        .from("voice_calls")
        .select("id, contact_id, recording_url, transcription")
        .eq("brokerage_id", brokerageId)
        .in("contact_id", contactIds)
      for (const vc of vcRows ?? []) {
        if (!voiceCallMap[vc.contact_id]) {
          voiceCallMap[vc.contact_id] = { recording_url: vc.recording_url ?? null, transcription: vc.transcription ?? null }
        }
      }
    }
  }

  const voiceInsights = voiceInsightRows.map((row: any) => {
    const conv = row.conversations
    const contact = conv?.contacts
    const agent = conv?.agents
    const vc = contact?.id ? (voiceCallMap[contact.id] ?? null) : null
    return {
      id:                       row.id,
      conversation_id:          conv?.id ?? row.id,
      contact_name:             contact ? `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim() || "Unknown" : "Unknown",
      agent_name:               agent?.users ? `${agent.users.first_name ?? ""} ${agent.users.last_name ?? ""}`.trim() || "—" : "—",
      voice_quality_score:      row.voice_quality_score ?? null,
      interruption_count:       row.interruption_count ?? null,
      silence_duration_seconds: row.silence_duration_seconds ?? null,
      call_completion_status:   row.call_completion_status ?? null,
      overall_sentiment:        row.overall_sentiment ?? null,
      recording_url:            vc?.recording_url ?? null,
      // DB column is transcription (not transcript) — mapped here
      transcript:               vc?.transcription ?? null,
      updated_at:               row.updated_at,
    }
  })

  return (
    <IntelligenceClient
      kpi={{ avgHealthScore, pendingFlagsToday, fairHousingPending, escalationsLast7Days }}
      chartData={chartData}
      healthInsights={healthInsights}
      auditFlags={(auditFlagsRes.data ?? []) as any}
      agentInsights={agentInsights}
      teamAvgResponseTime={teamAvgResponseTime}
      topicFrequency={topicFrequency}
      voiceInsights={voiceInsights}
      userId={user.id}
    />
  )
}

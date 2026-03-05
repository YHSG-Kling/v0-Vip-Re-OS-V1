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

  if (!profile?.brokerage_id) redirect("/onboarding")

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
    service
      .from("conversation_insights")
      .select(`
        id,
        health_score,
        overall_sentiment,
        trajectory,
        response_time_avg,
        unanswered_questions_count,
        escalation_recommended,
        updated_at,
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
    const conv = row.conversations
    const contact = conv?.contacts
    const agent = conv?.agents
    return {
      id: row.id,
      contact_name: contact ? `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim() || "Unknown" : "Unknown",
      agent_name: agent?.users ? `${agent.users.first_name ?? ""} ${agent.users.last_name ?? ""}`.trim() || "—" : "—",
      overall_sentiment: row.overall_sentiment ?? "neutral",
      trajectory: row.trajectory ?? "stable",
      health_score: row.health_score ?? 0,
      response_time_avg: row.response_time_avg,
      unanswered_questions_count: row.unanswered_questions_count ?? 0,
      escalation_recommended: row.escalation_recommended ?? false,
      updated_at: row.updated_at,
    }
  })

  // ── Shape insight records tab ────────────────────────────────────────────────
  const insightRecords = (insightsRes.data ?? []).map((row: any) => {
    const conv = row.conversations
    const contact = conv?.contacts
    const agent = conv?.agents
    return {
      id: row.id,
      conversation_id: row.conversations?.id ?? row.id,
      contact_name: contact ? `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim() || "Unknown" : "Unknown",
      contact_email: contact?.email ?? null,
      agent_name: agent?.users ? `${agent.users.first_name ?? ""} ${agent.users.last_name ?? ""}`.trim() || "—" : "—",
      overall_sentiment: row.overall_sentiment ?? "neutral",
      health_score: row.health_score ?? 0,
      top_topics: row.top_topics ?? [],
      key_questions: row.key_questions ?? [],
      unanswered_questions_count: row.unanswered_questions_count ?? 0,
      escalation_recommended: row.escalation_recommended ?? false,
      next_best_action: row.next_best_action ?? null,
      updated_at: row.updated_at,
    }
  })

  return (
    <IntelligenceClient
      kpi={{ avgHealthScore, pendingFlagsToday, fairHousingPending, escalationsLast7Days }}
      chartData={chartData}
      healthInsights={healthInsights}
      auditFlags={(auditFlagsRes.data ?? []) as any}
      insightRecords={insightRecords}
      userId={user.id}
    />
  )
}

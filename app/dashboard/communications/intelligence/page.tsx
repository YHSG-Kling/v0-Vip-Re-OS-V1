import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import IntelligenceClient from "./IntelligenceClient"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"

export const metadata = {
  title: "Communication Intelligence",
  description: "Conversation health scores, audit flags, and AI-driven insights.",
}

export default async function IntelligencePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")


  // Self-healing identity: provision a missing brokerage/agents row IN PLACE before
  // reading the profile, so an incomplete account renders this page instead of being
  // bounced away (the "bounce" class in the live walkthrough). The redirect below now
  // only fires for an account that genuinely cannot self-provision — a pending
  // brokerage invite, or a staff user whose brokerage comes from their org.
  await ensureAgentContextInPlace()
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

    // ── 9. VOICE INSIGHTS — READ FROM THE CALL LEDGER, NOT THE THREAD ANALYSER
    //
    // This query used to read `conversation_insights` filtered on
    // `is_voice_conversation = true`, selecting `voice_quality_score`,
    // `interruption_count`, `silence_duration_seconds` and
    // `call_completion_status`. All four were READ BY CODE AND WRITTEN BY NOBODY
    // (census 1b), and the filter itself could never match: the ONE writer of
    // that table stamps `is_voice_conversation: false` on both its insert and
    // its update paths, and says why in a ruling that stands
    // (lib/intelligence/conversation-insights.ts:205-214) —
    //
    //   "This writer analyzes a TEXT thread. The voice metrics have no honest
    //    source yet (no per-utterance timestamps anywhere) and stay NULL."
    //
    // So the Voice tab was structurally empty on every tenant, forever, and its
    // own empty state read "Insights are generated automatically after calls are
    // analyzed" — a promise about a pipeline that did not exist.
    //
    // A CONVERSATION AND A CALL ARE DIFFERENT THINGS. `conversations` is the
    // message-thread spine; a dialled call lives on `voice_calls`, and its
    // analysis on `call_analyses`. The page even admitted the mismatch — it
    // reached voice_calls afterwards "by contact_id overlap", a guess. So the
    // voice board now reads the voice ledger directly, and the four columns
    // above are gone from this file:
    //
    //   voice_quality_score      → SURVIVOR call_analyses.coaching_score, the
    //                              0-100 "did this conversation serve the
    //                              caller" reading, written on every analysed
    //                              call at lib/voice/call-analysis.ts:97.
    //   call_completion_status   → SURVIVOR voice_calls.status + outcome,
    //                              written by the Twilio status callback — the
    //                              provider's own account of how the call ended.
    //   interruption_count       → NO SURVIVOR. Deriving either needs
    //   silence_duration_seconds   per-utterance timestamps, and
    //                              call_transcriptions.speaker_turns is written
    //                              as `[]` (app/actions/ai-voice-transcription.ts:545).
    //                              They are DROPPED rather than shown as 0 —
    //                              a zero here reads as "a flawless call".
    //
    // Analysed calls only (`call_analyses` is an inner embed): an unanalysed
    // call has no quality reading and belongs on the calls list, not on an
    // intelligence board.
    service
      .from("voice_calls")
      .select(`
        id,
        status,
        outcome,
        recording_url,
        transcription,
        started_at,
        contacts(id, first_name, last_name),
        agents(id, users(first_name, last_name)),
        call_analyses!inner(coaching_score, sentiment, analyzed_at)
      `)
      .eq("brokerage_id", brokerageId)
      .order("started_at", { ascending: false })
      .limit(50),
  ])

  // ── Contacts for the Fair-Housing Review card (lane F2 2026-08-28) ─────────
  // Brokerage-scoped names only — the picker for the restored contact-linked
  // post-hoc review (analyzeFairHousingRisk). The action re-verifies the
  // contact's tenant server-side; this list is just the affordance.
  const { data: reviewContactRows, error: reviewContactsError } = await service
    .from("contacts")
    .select("id, first_name, last_name")
    .eq("brokerage_id", brokerageId)
    .order("first_name", { ascending: true })
    .limit(500)
  if (reviewContactsError) {
    console.error("[intelligence] contacts read refused for fair-housing review picker:", reviewContactsError.message)
  }
  const reviewContacts = (reviewContactRows ?? []).map((c: any) => ({
    id: c.id as string,
    name: `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || "Unnamed contact",
  }))

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
  // One row per ANALYSED call, straight off the voice ledger. The whole
  // contact_id-overlap lookup that used to live here is gone with the
  // conversation_insights read it existed to patch up: voice_calls.id is now the
  // row's own primary key, so the recording no longer has to be guessed at by
  // matching contacts (which handed every one of a contact's calls the FIRST
  // call's recording).
  //
  // recording_url is still carried alongside voice_call_id because the UI cannot
  // play it directly: it is the api.twilio.com media URL, behind HTTP Basic
  // auth, and the browser plays the authenticated same-origin proxy keyed by
  // voice_calls.id.
  if (voiceInsightsRes.error) {
    console.error("[intelligence] voice call ledger read refused — the Voice tab will read as empty:", voiceInsightsRes.error.message)
  }
  const voiceInsights = (voiceInsightsRes.data ?? []).map((row: any) => {
    const contact = row.contacts
    const agent = row.agents
    // `call_analyses` is an inner embed and PostgREST returns it as an array;
    // the newest analysis is the current reading of the call.
    const analyses = Array.isArray(row.call_analyses) ? row.call_analyses : row.call_analyses ? [row.call_analyses] : []
    const analysis = analyses
      .slice()
      .sort((a: any, b: any) => new Date(b.analyzed_at ?? 0).getTime() - new Date(a.analyzed_at ?? 0).getTime())[0] ?? null
    return {
      id:                     row.id,
      contact_name:           contact ? `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim() || "Unknown" : "Unknown",
      agent_name:             agent?.users ? `${agent.users.first_name ?? ""} ${agent.users.last_name ?? ""}`.trim() || "—" : "—",
      // 0-100 on this scale — see the note on query 9. Not rescaled to 0-1:
      // the old column was 0-1 and the tab multiplied by 100, which is why
      // VoiceTab now takes it as a percentage outright.
      coaching_score:         typeof analysis?.coaching_score === "number" ? analysis.coaching_score : null,
      // The provider's own account of how the call ended. `outcome` carries the
      // real disposition when it exists (voice_calls.status is "completed" on
      // every terminated leg — stated at app/dashboard/voice/isa/page.tsx:158-163);
      // status is the fallback.
      call_completion_status: (row.outcome as string | null) ?? (row.status as string | null) ?? null,
      overall_sentiment:      (analysis?.sentiment as string | null) ?? null,
      voice_call_id:          row.id,
      recording_url:          row.recording_url ?? null,
      // DB column is transcription (not transcript) — mapped here
      transcript:             row.transcription ?? null,
      updated_at:             (analysis?.analyzed_at as string | null) ?? row.started_at,
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
      reviewContacts={reviewContacts}
    />
  )
}

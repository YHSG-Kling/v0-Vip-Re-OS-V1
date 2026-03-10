import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { redirect } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { 
  Phone, 
  CheckCircle2, 
  Clock, 
  Users, 
  TrendingUp,
  PhoneOff,
  ArrowRight
} from "lucide-react"
import { ISACallsTable } from "./isa-calls-table"
import { ISACampaignsPanel } from "./isa-campaigns-panel"
import { CoachingInsightsPanel } from "./coaching-insights-panel"
import { HandoffQueuePanel } from "./handoff-queue-panel"
import { ContactHistorySheet } from "./contact-history-sheet"
import { ISAConfigSummary } from "./isa-config-summary"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Voice ISA Dashboard | VIP-OS",
  description: "AI Inside Sales Agent call management and monitoring",
}

export default async function VoiceISAPage() {
  const supabase = await createClient()
  const { agentId, brokerageId } = await getAgentContext()

  // Get today's date at midnight
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const todayISO = today.toISOString()

  // Fetch KPI metrics
  const [
    { count: callsToday },
    { data: weekCalls },
    { data: voiceCallsDuration },
  ] = await Promise.all([
    // Calls today
    supabase
      .from("ai_isa_calls")
      .select("*", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId)
      .gte("created_at", todayISO),
    // Week calls for answer rate
    supabase
      .from("ai_isa_calls")
      .select("id, voice_call_id, appointment_set")
      .eq("brokerage_id", brokerageId)
      .gte("created_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()),
    // Voice calls for duration average
    supabase
      .from("voice_calls")
      .select("duration_seconds")
      .eq("brokerage_id", brokerageId)
      .gte("started_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
      .not("duration_seconds", "is", null),
  ])

  // Calculate KPIs
  const totalWeekCalls = weekCalls?.length || 0
  const answeredCalls = weekCalls?.filter(c => c.voice_call_id)?.length || 0
  const answerRate = totalWeekCalls > 0 ? Math.round((answeredCalls / totalWeekCalls) * 100) : 0
  
  const qualifiedCalls = weekCalls?.filter(c => c.appointment_set)?.length || 0
  const qualificationRate = answeredCalls > 0 ? Math.round((qualifiedCalls / answeredCalls) * 100) : 0

  const avgDuration = voiceCallsDuration?.length 
    ? Math.round(voiceCallsDuration.reduce((sum, c) => sum + (c.duration_seconds || 0), 0) / voiceCallsDuration.length)
    : 0
  const avgDurationFormatted = `${Math.floor(avgDuration / 60)}:${String(avgDuration % 60).padStart(2, '0')}`

  // Fetch today's calls for table
  const { data: todaysCalls } = await supabase
    .from("ai_isa_calls")
    .select(`
      id,
      voice_call_id,
      appointment_set,
      appointment_datetime,
      lead_quality_score,
      ai_response_summary,
      created_at,
      contact_id,
      contacts (
        id,
        first_name,
        last_name,
        phone,
        buyer_stage
      )
    `)
    .eq("brokerage_id", brokerageId)
    .gte("created_at", todayISO)
    .order("created_at", { ascending: false })

  // Fetch completed calls
  const { data: completedCalls } = await supabase
    .from("ai_isa_calls")
    .select(`
      id,
      voice_call_id,
      appointment_set,
      appointment_datetime,
      lead_quality_score,
      ai_response_summary,
      created_at,
      contact_id,
      contacts (
        id,
        first_name,
        last_name,
        phone,
        buyer_stage
      )
    `)
    .eq("brokerage_id", brokerageId)
    .not("voice_call_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(50)

  // Fetch failed/no answer calls
  const { data: failedCalls } = await supabase
    .from("voice_calls")
    .select(`
      id,
      contact_id,
      status,
      outcome,
      started_at,
      duration_seconds,
      contacts (
        id,
        first_name,
        last_name,
        phone,
        buyer_stage
      )
    `)
    .eq("brokerage_id", brokerageId)
    .in("status", ["no_answer", "failed", "busy"])
    .order("started_at", { ascending: false })
    .limit(50)

  // Fetch active campaigns
  const { data: activeCampaigns } = await supabase
    .from("ai_isa_campaigns")
    .select("*")
    .eq("brokerage_id", brokerageId)
    .eq("is_active", true)
    .order("created_at", { ascending: false })

  // Fetch coaching insights
  const { data: coachingInsights } = await supabase
    .from("call_coaching_insights")
    .select(`
      id,
      insight_type,
      priority,
      content,
      dismissed,
      created_at,
      call_analysis_id,
      call_analyses (
        voice_call_id
      )
    `)
    .eq("brokerage_id", brokerageId)
    .eq("agent_id", agentId)
    .eq("dismissed", false)
    .order("created_at", { ascending: false })
    .limit(5)

  // Fetch handoff queue (qualified leads ready for agent)
  const { data: handoffQueue } = await supabase
    .from("ai_isa_qualifications")
    .select(`
      id,
      contact_id,
      qualification_score,
      qualification_result,
      notes,
      qualified_at,
      contacts (
        id,
        first_name,
        last_name,
        phone,
        buyer_stage
      )
    `)
    .eq("brokerage_id", brokerageId)
    .eq("qualification_result", "qualified")
    .is("assigned_to_agent_id", null)
    .order("qualified_at", { ascending: false })

  // Fetch voice assistant config
  const { data: voiceConfig } = await supabase
    .from("voice_assistant_config")
    .select("*")
    .eq("agent_id", agentId)
    .single()

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Voice ISA Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            AI Inside Sales Agent call management and monitoring
          </p>
        </div>
      </div>

      {/* Summary KPI Row */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Calls Today</CardTitle>
            <Phone className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{callsToday || 0}</div>
            <p className="text-xs text-muted-foreground">AI-initiated calls</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Answer Rate</CardTitle>
            <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{answerRate}%</div>
            <p className="text-xs text-muted-foreground">This week</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Qualification Rate</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{qualificationRate}%</div>
            <p className="text-xs text-muted-foreground">Qualified / Answered</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Avg Duration</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{avgDurationFormatted}</div>
            <p className="text-xs text-muted-foreground">Minutes:Seconds</p>
          </CardContent>
        </Card>
      </div>

      {/* Main Tabs */}
      <Tabs defaultValue="active" className="w-full">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="active">Active / Queued</TabsTrigger>
          <TabsTrigger value="today">Today&apos;s Calls</TabsTrigger>
          <TabsTrigger value="completed">Completed</TabsTrigger>
          <TabsTrigger value="failed">Failed / No Answer</TabsTrigger>
        </TabsList>

        <TabsContent value="active" className="mt-4">
          <ISACampaignsPanel 
            campaigns={activeCampaigns || []} 
            brokerageId={brokerageId}
          />
        </TabsContent>

        <TabsContent value="today" className="mt-4">
          <ISACallsTable 
            calls={todaysCalls || []} 
            emptyMessage="No calls today yet"
            showRetry={false}
          />
        </TabsContent>

        <TabsContent value="completed" className="mt-4">
          <ISACallsTable 
            calls={completedCalls || []} 
            emptyMessage="No completed calls"
            showRetry={false}
          />
        </TabsContent>

        <TabsContent value="failed" className="mt-4">
          <ISACallsTable 
            calls={failedCalls?.map(c => ({
              id: c.id,
              voice_call_id: c.id,
              appointment_set: false,
              appointment_datetime: null,
              lead_quality_score: null,
              ai_response_summary: null,
              created_at: c.started_at,
              contact_id: c.contact_id,
              contacts: c.contacts,
              call_status: c.status,
              call_outcome: c.outcome,
              duration_seconds: c.duration_seconds,
            })) || []} 
            emptyMessage="No failed calls"
            showRetry={true}
            brokerageId={brokerageId}
          />
        </TabsContent>
      </Tabs>

      {/* Bottom Panels */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Coaching Insights Panel */}
        <CoachingInsightsPanel 
          insights={coachingInsights || []} 
          agentId={agentId}
        />

        {/* Handoff Queue */}
        <HandoffQueuePanel 
          queue={handoffQueue || []} 
          brokerageId={brokerageId}
          agentId={agentId}
        />
      </div>

      {/* ISA Configuration Summary */}
      <ISAConfigSummary config={voiceConfig} agentId={agentId} />
    </div>
  )
}

import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { redirect, notFound } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { TranscriptViewer } from "@/components/voice/TranscriptViewer"
import { CoachingInsightCard } from "@/components/voice/CoachingInsightCard"
import { CallRecordingPlayer } from "@/components/voice/CallRecordingPlayer"
import { recordingPlaybackPath } from "@/lib/voice/recording-playback-path"
import {
  Phone,
  PhoneIncoming,
  PhoneOutgoing,
  Clock,
  Calendar,
  User,
  ArrowLeft,
  Volume2,
} from "lucide-react"
import Link from "next/link"
import { CallReviewActionsBar } from "./call-review-actions-bar"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Call Review | Voice Dashboard | VIP-OS",
  description: "Review call transcript, AI analysis, and coaching insights",
}

interface PageProps {
  params: Promise<{ callId: string }>
}

export default async function VoiceCallReviewPage({ params }: PageProps) {
  const { callId } = await params
  const supabase = await createClient()
  
  // Get agent context and check role
  let agentContext
  try {
    agentContext = await getAgentContext()
  } catch {
    redirect("/login")
  }

  const { agentId, brokerageId } = agentContext

  // Get user role for RBAC
  const { data: user } = await supabase.auth.getUser()
  const { data: userData } = await supabase
    .from("users")
    .select("user_type")
    .eq("id", user.user?.id)
    .single()

  const userRole = userData?.user_type || "agent"
  // SCOPE LADDER (kept inline — admits compliance_officer): 'superadmin'
  // removed — dead as users.user_type (0 live rows store it).
  const canViewAllCalls = ["team_lead", "broker", "broker_owner", "admin", "compliance_officer"].includes(userRole)

  // Fetch voice call with contact and agent info
  const { data: voiceCall, error: voiceCallError } = await supabase
    .from("voice_calls")
    .select(`
      id,
      agent_id,
      contact_id,
      status,
      direction,
      started_at,
      ended_at,
      duration_seconds,
      recording_url,
      contacts (
        id,
        first_name,
        last_name,
        phone
      ),
      agents (
        id,
        users(first_name, last_name)
      )
    `)
    .eq("id", callId)
    .eq("brokerage_id", brokerageId)
    .single()

  if (voiceCallError || !voiceCall) {
    notFound()
  }

  // RBAC: agents can only view their own calls
  if (!canViewAllCalls && voiceCall.agent_id !== agentId) {
    redirect("/dashboard/voice/isa")
  }

  // Fetch ai_isa_calls for outcome if exists
  const { data: isaCall } = await supabase
    .from("ai_isa_calls")
    .select("id, voice_call_id, contact_id, appointment_set, lead_quality_score")
    .eq("voice_call_id", callId)
    .single()

  // Call cost — the canonical billing rail is usage_logs (the Twilio status
  // route writes one 'voice_call' row per completed call, tagged with the
  // voice_call_id). The retired vapi_voice_calls table no longer carries it.
  const { data: vendorCall } = await supabase
    .from("usage_logs")
    .select("id, cost_cents")
    .eq("usage_type", "voice_call")
    .contains("metadata", { voice_call_id: callId })
    .maybeSingle()

  // Fetch transcription
  const { data: transcription } = await supabase
    .from("call_transcriptions")
    .select("id, speaker_turns, full_text, word_count, language, transcribed_at")
    .eq("voice_call_id", callId)
    .single()

  // Fetch call analysis
  const { data: analysis } = await supabase
    .from("call_analyses")
    .select("id, sentiment, objections, next_steps, coaching_score, analyzed_at")
    .eq("voice_call_id", callId)
    .single()

  // Fetch coaching insights if analysis exists
  let coachingInsights: Array<{
    id: string
    insight_type: string
    content: string
    priority: string
    dismissed: boolean
  }> = []
  if (analysis) {
    const { data: insights } = await supabase
      .from("call_coaching_insights")
      .select("id, insight_type, content, priority, dismissed")
      .eq("call_analysis_id", analysis.id)
      .eq("dismissed", false)
      .order("priority", { ascending: true })

    coachingInsights = insights || []
  }

  // Fetch whisper logs
  const { data: whisperLogs } = await supabase
    .from("call_whisper_logs")
    .select("id, whisper_text, delivered_at, agent_heard")
    .eq("voice_call_id", callId)
    .order("delivered_at", { ascending: true })

  // Format duration as MM:SS
  const formatDuration = (seconds: number | null) => {
    if (!seconds) return "0:00"
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins}:${secs.toString().padStart(2, "0")}`
  }

  // Get outcome badge color
  const getOutcomeBadgeColor = (score: number | null) => {
    if (!score) return "bg-muted text-muted-foreground"
    if (score >= 80) return "bg-green-500/10 text-green-700"
    if (score >= 50) return "bg-amber-500/10 text-amber-700"
    return "bg-red-500/10 text-red-700"
  }

  // Get sentiment badge color
  const getSentimentBadgeColor = (sentiment: string | null) => {
    switch (sentiment?.toLowerCase()) {
      case "positive":
        return "bg-green-500/10 text-green-700"
      case "negative":
        return "bg-red-500/10 text-red-700"
      case "mixed":
        return "bg-amber-500/10 text-amber-700"
      default:
        return "bg-muted text-muted-foreground"
    }
  }

  const contact = voiceCall.contacts as unknown as { id: string; first_name: string; last_name: string; phone: string } | null
  // agents carries no name columns — they live on users, reached through agents.user_id.
  const agent = voiceCall.agents as unknown as { id: string; users?: { first_name: string | null; last_name: string | null } | null } | null

  return (
    <div className="container max-w-5xl py-6 space-y-6">
      {/* Back Link */}
      <Link
        href="/dashboard/voice/isa"
        className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to ISA Dashboard
      </Link>

      {/* Section 1: Call Header */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between">
            <div className="space-y-1">
              <div className="flex items-center gap-3">
                {voiceCall.direction === "inbound" ? (
                  <PhoneIncoming className="h-5 w-5 text-green-600" />
                ) : (
                  <PhoneOutgoing className="h-5 w-5 text-blue-600" />
                )}
                <CardTitle className="text-xl">
                  {contact
                    ? `${contact.first_name} ${contact.last_name}`
                    : "Unknown Contact"}
                </CardTitle>
              </div>
              <CardDescription className="flex items-center gap-4">
                <span className="flex items-center gap-1">
                  <Phone className="h-4 w-4" />
                  {contact?.phone || "No phone"}
                </span>
                <span className="flex items-center gap-1">
                  <Calendar className="h-4 w-4" />
                  {voiceCall.started_at
                    ? new Date(voiceCall.started_at).toLocaleDateString()
                    : "N/A"}
                </span>
                <span className="flex items-center gap-1">
                  <Clock className="h-4 w-4" />
                  {voiceCall.started_at
                    ? new Date(voiceCall.started_at).toLocaleTimeString()
                    : "N/A"}
                </span>
              </CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline">
                {voiceCall.direction === "inbound" ? "Inbound" : "Outbound"}
              </Badge>
              <Badge variant="outline">{voiceCall.status}</Badge>
              {isaCall && (
                <Badge className={getOutcomeBadgeColor(isaCall.lead_quality_score)}>
                  {isaCall.appointment_set ? "Qualified" : "Unqualified"}
                </Badge>
              )}
            </div>
          </div>
          <div className="flex items-center gap-6 pt-4 text-sm text-muted-foreground">
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4" />
              <span className="font-medium">
                {formatDuration(voiceCall.duration_seconds)}
              </span>
            </div>
            {agent && (
              <div className="flex items-center gap-2">
                <User className="h-4 w-4" />
                <span>
                  {agent.users?.first_name} {agent.users?.last_name}
                </span>
              </div>
            )}
            {vendorCall?.cost_cents && (
              <div className="flex items-center gap-2">
                <span>Cost: ${(vendorCall.cost_cents / 100).toFixed(2)}</span>
              </div>
            )}
          </div>
        </CardHeader>
      </Card>

      {/* Section 2: Recording Player */}
      {voiceCall.recording_url && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Volume2 className="h-5 w-5" />
              Call Recording
            </CardTitle>
          </CardHeader>
          <CardContent>
            {/* The SRC is the authenticated same-origin proxy, never
                voiceCall.recording_url — that is the api.twilio.com URL, which
                is behind HTTP Basic auth and 401s in a browser. */}
            <CallRecordingPlayer src={recordingPlaybackPath(voiceCall.id)} />
          </CardContent>
        </Card>
      )}

      {/* Section 3: Transcript Viewer */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Transcript</CardTitle>
          {transcription && (
            <CardDescription>
              {transcription.word_count} words | {transcription.language || "en"} |
              Transcribed{" "}
              {transcription.transcribed_at
                ? new Date(transcription.transcribed_at).toLocaleString()
                : "N/A"}
            </CardDescription>
          )}
        </CardHeader>
        <CardContent>
          <TranscriptViewer
            fullText={transcription?.full_text || ""}
            speakerTurns={transcription?.speaker_turns as Array<{speaker: "agent" | "contact" | "ai"; text: string; timestamp?: string}> || null}
            whisperTimestamps={
              whisperLogs?.map((w) => ({
                deliveredAt: w.delivered_at,
                text: w.whisper_text,
              })) || []
            }
          />
        </CardContent>
      </Card>

      {/* Section 4: Whisper Log Timeline */}
      {whisperLogs && whisperLogs.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Whisper Log</CardTitle>
            <CardDescription>
              Real-time coaching hints delivered during the call
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {whisperLogs.map((whisper) => (
                <div
                  key={whisper.id}
                  className="flex items-start gap-4 p-3 rounded-lg bg-muted/50"
                >
                  <div className="text-xs text-muted-foreground whitespace-nowrap">
                    {new Date(whisper.delivered_at).toLocaleTimeString()}
                  </div>
                  <div className="flex-1">
                    <p className="text-sm">{whisper.whisper_text}</p>
                  </div>
                  <Badge
                    variant="outline"
                    className={
                      whisper.agent_heard
                        ? "bg-green-500/10 text-green-700"
                        : "bg-muted text-muted-foreground"
                    }
                  >
                    {whisper.agent_heard ? "Heard" : "Not Heard"}
                  </Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Section 5: AI Analysis Card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">AI Analysis</CardTitle>
          <CardDescription>
            AI Generated Analysis — for internal use
          </CardDescription>
        </CardHeader>
        <CardContent>
          {analysis ? (
            <div className="space-y-6">
              <div className="flex flex-wrap gap-4">
                <div className="space-y-1">
                  <span className="text-xs text-muted-foreground">Sentiment</span>
                  <Badge className={getSentimentBadgeColor(analysis.sentiment)}>
                    {analysis.sentiment || "Unknown"}
                  </Badge>
                </div>
                {analysis.coaching_score !== null && (
                  <div className="space-y-1">
                    <span className="text-xs text-muted-foreground">
                      Coaching Score
                    </span>
                    <Badge className={getOutcomeBadgeColor(analysis.coaching_score)}>
                      {analysis.coaching_score}/100
                    </Badge>
                  </div>
                )}
              </div>

              <Separator />

              {/* Objections */}
              {analysis.objections &&
                Array.isArray(analysis.objections) &&
                analysis.objections.length > 0 && (
                  <div className="space-y-2">
                    <h4 className="text-sm font-medium">Objections Raised</h4>
                    <ul className="list-disc list-inside text-sm text-muted-foreground space-y-1">
                      {(analysis.objections as string[]).map((obj, i) => (
                        <li key={i}>{obj}</li>
                      ))}
                    </ul>
                  </div>
                )}

              {/* Next Steps */}
              {analysis.next_steps &&
                Array.isArray(analysis.next_steps) &&
                analysis.next_steps.length > 0 && (
                  <div className="space-y-2">
                    <h4 className="text-sm font-medium">Next Steps</h4>
                    <ul className="list-disc list-inside text-sm text-muted-foreground space-y-1">
                      {(analysis.next_steps as string[]).map((step, i) => (
                        <li key={i}>{step}</li>
                      ))}
                    </ul>
                  </div>
                )}

              <p className="text-xs text-muted-foreground">
                Analyzed{" "}
                {analysis.analyzed_at
                  ? new Date(analysis.analyzed_at).toLocaleString()
                  : "N/A"}
              </p>
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              AI analysis pending — typically ready shortly after call completion
            </div>
          )}
        </CardContent>
      </Card>

      {/* Section 6: Coaching Insight Cards */}
      <div className="space-y-4">
        <h3 className="text-lg font-semibold">Coaching Insights</h3>
        {coachingInsights.length > 0 ? (
          <div className="grid gap-4">
            {coachingInsights.map((insight) => (
              <CoachingInsightCard
                key={insight.id}
                id={insight.id}
                insightType={insight.insight_type}
                content={insight.content}
                priority={insight.priority}
                dismissed={insight.dismissed}
              />
            ))}
          </div>
        ) : (
          <Card>
            <CardContent className="py-8 text-center text-muted-foreground">
              No coaching insights for this call
            </CardContent>
          </Card>
        )}
      </div>

      {/* Section 7: Action Row */}
      <Card>
        <CardContent className="py-4">
          <div className="flex flex-wrap gap-3">
            <CallReviewActionsBar callId={callId} />
            <Link href="/dashboard/voice/isa" className="ml-auto">
              <Button variant="ghost" className="gap-2">
                <ArrowLeft className="h-4 w-4" />
                Back to ISA Dashboard
              </Button>
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

// The recording player used to live here as AudioPlayer + AudioSpeedControls.
// It was defined in THIS file — an async SERVER component — while attaching an
// onClick handler to its speed buttons, which React cannot serialize onto a host
// element in a server component. It never threw only because voice_calls.recording_url
// had no writer, so the branch that renders it was unreachable. Now that recordings
// land it is a real client component: @/components/voice/CallRecordingPlayer.

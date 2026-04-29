import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { VoiceCommandCenterClient } from "./VoiceCommandCenterClient"
import type { VoiceCommandRequest } from "@/app/actions/voice-assistant/handle-voice-command"
import type { VoiceCommandRow } from "@/app/components/dashboard/voice/RecentCommandsFeed"
import type { VoiceCallRow } from "@/app/components/dashboard/voice/VoiceCallHistoryTable"

export const metadata = {
  title: "Voice Command Center | VIP Real Estate AI OS",
  description: "AI-powered voice command center for your real estate business",
}

export default async function VoiceDashboardPage() {
  const supabase = await createClient()

  // ── Auth ───────────────────────────────────────────────────────────────────
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser()

  if (!authUser) redirect("/login")

  // ── Fetch user row ─────────────────────────────────────────────────────────
  const { data: userRow } = await supabase
    .from("users")
    .select("id, user_type, brokerage_id, first_name, last_name, assistant_wake_name")
    .eq("id", authUser.id)
    .maybeSingle()

  if (!userRow) redirect("/login")

  const wakeName: string = (userRow.assistant_wake_name as string | null) ?? "VIP"
  const brokerageId: string = userRow.brokerage_id ?? ""
  const userRole = (userRow.user_type as VoiceCommandRequest["user_role"]) ?? "agent"

  // ── Fetch recent voice commands ────────────────────────────────────────────
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

  const [
    { data: recentCommands },
    { data: todayCommands },
    { data: commandsByType },
    { data: callsToday },
    { data: callHistory },
    { data: contacts },
    { data: scripts },
  ] = await Promise.all([
    // Last 10 voice commands for this user
    supabase
      .from("voice_commands")
      .select("id, command_type, raw_transcript, action_taken, success, confidence_score, created_at")
      .eq("user_id", authUser.id)
      .order("created_at", { ascending: false })
      .limit(10),

    // Today's commands for summary
    supabase
      .from("voice_commands")
      .select("id, success")
      .eq("user_id", authUser.id)
      .gte("created_at", today.toISOString()),

    // Last 7 days commands grouped by type
    supabase
      .from("voice_commands")
      .select("command_type")
      .eq("user_id", authUser.id)
      .gte("created_at", sevenDaysAgo.toISOString()),

    // Today's calls
    supabase
      .from("voice_calls")
      .select("id, duration_seconds")
      .eq("brokerage_id", brokerageId)
      .gte("created_at", today.toISOString()),

    // Voice call history with contact join
    supabase
      .from("voice_calls")
      .select(`
        id, direction, call_type, duration_seconds, outcome, sentiment,
        recording_url, compliance_passed, transcription, phone_to, phone_from,
        created_at,
        contacts (first_name, last_name)
      `)
      .eq("brokerage_id", brokerageId)
      .order("created_at", { ascending: false })
      .limit(20),

    // Contacts for VAPI call panel
    supabase
      .from("contacts")
      .select("id, first_name, last_name, phone")
      .eq("brokerage_id", brokerageId)
      .not("phone", "is", null)
      .order("first_name")
      .limit(200),

    // Approved scripts
    supabase
      .from("scripts")
      .select("id, title")
      .eq("status", "approved")
      .order("title")
      .limit(50),
  ])

  // ── Build analytics data ───────────────────────────────────────────────────
  const commandsToday = todayCommands?.length ?? 0
  const successToday = todayCommands?.filter((c) => c.success).length ?? 0
  const successRate =
    commandsToday > 0 ? Math.round((successToday / commandsToday) * 100) + "%" : "—"
  const callsTodayCount = callsToday?.length ?? 0
  const avgCallDuration =
    callsToday && callsToday.length > 0
      ? formatDuration(
          Math.round(
            callsToday.reduce((sum, c) => sum + (c.duration_seconds ?? 0), 0) / callsToday.length
          )
        )
      : "—"

  // Command type breakdown
  const typeMap: Record<string, number> = {}
  for (const row of commandsByType ?? []) {
    const t = row.command_type ?? "unknown"
    typeMap[t] = (typeMap[t] ?? 0) + 1
  }
  const commandTypeData = Object.entries(typeMap).map(([name, value]) => ({ name, value }))

  // Average confidence last 7 days
  const { data: confData } = await supabase
    .from("voice_commands")
    .select("confidence_score")
    .eq("user_id", authUser.id)
    .gte("created_at", sevenDaysAgo.toISOString())
    .not("confidence_score", "is", null)

  const avgConfidence =
    confData && confData.length > 0
      ? confData.reduce((s, r) => s + (r.confidence_score ?? 0), 0) / confData.length
      : 0

  // ── Shape data ─────────────────────────────────────────────────────────────
  const shapedCommands: VoiceCommandRow[] = (recentCommands ?? []).map((r) => ({
    id: r.id,
    command_type: r.command_type ?? null,
    raw_transcript: r.raw_transcript ?? null,
    action_taken: r.action_taken ?? null,
    success: r.success ?? null,
    confidence_score: r.confidence_score ?? null,
    created_at: r.created_at,
  }))

  const shapedCallHistory: VoiceCallRow[] = (callHistory ?? []).map((r: any) => ({
    id: r.id,
    contact_name: r.contacts
      ? `${r.contacts.first_name ?? ""} ${r.contacts.last_name ?? ""}`.trim() || null
      : null,
    phone_to: r.phone_to ?? null,
    phone_from: r.phone_from ?? null,
    direction: r.direction ?? null,
    call_type: r.call_type ?? null,
    duration_seconds: r.duration_seconds ?? null,
    outcome: r.outcome ?? null,
    sentiment: r.sentiment ?? null,
    recording_url: r.recording_url ?? null,
    compliance_passed: r.compliance_passed ?? null,
    transcription: r.transcription ?? null,
    created_at: r.created_at,
  }))

  const summaryCards = [
    { label: "Commands today", value: commandsToday },
    { label: "Success rate", value: successRate },
    { label: "Calls today", value: callsTodayCount },
    { label: "Avg call duration", value: avgCallDuration },
  ]

  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        {/* Page header */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-foreground text-balance">
            Voice Command Center{" "}
            <span className="text-muted-foreground font-normal text-lg">
              — Your assistant:{" "}
              <span className="text-primary font-semibold">{wakeName}</span>
            </span>
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Hands-free control of your real estate OS. Say &ldquo;Hey {wakeName}&rdquo; to get started.
          </p>
        </div>

        <VoiceCommandCenterClient
          wakeName={wakeName}
          userId={authUser.id}
          userRole={userRole}
          brokerageId={brokerageId}
          initialCommands={shapedCommands}
          contacts={contacts ?? []}
          scripts={scripts ?? []}
          summaryCards={summaryCards}
          commandTypeData={commandTypeData}
          avgConfidence={avgConfidence}
          callHistory={shapedCallHistory}
        />
      </div>
    </main>
  )
}

function formatDuration(secs: number): string {
  if (secs === 0) return "0:00"
  const m = Math.floor(secs / 60).toString().padStart(2, "0")
  const s = (secs % 60).toString().padStart(2, "0")
  return `${m}:${s}`
}

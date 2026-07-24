import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { redirect } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Mic, MicOff, Phone, PhoneIncoming, PhoneOutgoing, Clock, Search, User, CheckCircle, XCircle } from "lucide-react"
import { formatDistanceToNow, format } from "date-fns"
import Link from "next/link"
import { VoiceSessionButton } from "./voice-session-button"
import { QuickDialSearch } from "./quick-dial-search"
import { MobileCommandStrip, QuickContactPanel } from "../components/os"
import { VoiceAssistantPanel } from "@/app/components/ai-copilot"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Voice Assistant | VIP-OS",
  description: "Voice commands and calls",
}

export default async function MobileVoicePage() {
  const supabase = await createClient()

  let agentContext
  try {
    agentContext = await getAgentContext()
  } catch {
    redirect("/login")
  }

  const { agentId, brokerageId, userId } = agentContext

  // Fetch voice assistant config
  const { data: voiceConfig } = await supabase
    .from("voice_assistant_config")
    .select("*")
    .eq("agent_id", agentId)
    .single()

  // Check for active voice session
  const { data: activeSession } = await supabase
    .from("voice_assistant_sessions")
    .select("*")
    .eq("agent_id", agentId)
    .is("session_end", null)
    .order("session_start", { ascending: false })
    .limit(1)
    .single()

  // Fetch recent voice commands
  const { data: recentCommands } = await supabase
    .from("voice_commands")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(5)

  // Fetch recent voice calls from the canonical voice_calls ledger
  const { data: recentCalls } = await supabase
    .from("voice_calls")
    .select(`
      id,
      direction,
      status,
      duration_seconds,
      started_at,
      outcome,
      contact_id,
      contacts (
        id,
        first_name,
        last_name
      )
    `)
    .eq("agent_id", agentId)
    .order("started_at", { ascending: false })
    .limit(5)

  return (
    <div className="min-h-screen bg-background pb-20">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-background border-b px-4 py-3">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold">Voice Assistant</h1>
            <p className="text-xs text-muted-foreground">Commands & Calls</p>
          </div>
          <Badge variant={voiceConfig ? "default" : "secondary"}>
            {voiceConfig ? "Configured" : "Not Set Up"}
          </Badge>
        </div>
      </header>

      <main className="px-4 py-4 space-y-6">
        {/* Voice Assistant Panel as Hero */}
        <VoiceAssistantPanel
          userId={userId ?? ""}
          userRole="agent"
          brokerageId={brokerageId ?? ""}
        />

        {/* Mobile OS Command Strip */}
        <MobileCommandStrip agentId={agentId ?? ""} />

        {/* Section 1: Voice Status Card */}
        <section>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center justify-between">
                Voice Status
                {activeSession && (
                  <Badge variant="default" className="bg-emerald-500">
                    Session Active
                  </Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-4">
                <div
                  className={`h-12 w-12 rounded-full flex items-center justify-center ${
                    activeSession ? "bg-emerald-100 text-emerald-700" : "bg-muted text-muted-foreground"
                  }`}
                >
                  {activeSession ? <Mic className="h-6 w-6" /> : <MicOff className="h-6 w-6" />}
                </div>
                <div className="flex-1">
                  {voiceConfig ? (
                    <>
                      <p className="font-medium text-sm">
                        Wake word: &quot;{voiceConfig.wake_word || "Hey Assistant"}&quot;
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {activeSession
                          ? `Active since ${format(new Date(activeSession.session_start), "h:mm a")}`
                          : "No active session"}
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="font-medium text-sm">Voice not configured</p>
                      <p className="text-xs text-muted-foreground">
                        Set up your voice profile in settings
                      </p>
                    </>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        </section>

        {/* Section 2: Recent Voice Commands */}
        <section>
          <h2 className="text-sm font-medium mb-3">Recent Commands</h2>
          {recentCommands && recentCommands.length > 0 ? (
            <div className="space-y-2">
              {recentCommands.map((command) => (
                <Card key={command.id} className="p-3">
                  <div className="flex items-start gap-3">
                    <div
                      className={`h-8 w-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                        command.success ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"
                      }`}
                    >
                      {command.success ? (
                        <CheckCircle className="h-4 w-4" />
                      ) : (
                        <XCircle className="h-4 w-4" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">
                        &quot;{command.raw_transcript}&quot;
                      </p>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Badge variant="outline" className="text-xs">
                          {command.command_type?.replace(/_/g, " ") || "command"}
                        </Badge>
                        <span>
                          {formatDistanceToNow(new Date(command.created_at), { addSuffix: true })}
                        </span>
                      </div>
                      {command.action_taken && (
                        <p className="text-xs text-muted-foreground mt-1 truncate">
                          Result: {command.action_taken}
                        </p>
                      )}
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          ) : (
            <Card className="p-4 text-center text-muted-foreground text-sm">
              No recent voice commands
            </Card>
          )}
        </section>

        {/* Section 3: Start Voice Session Button */}
        <section>
          <VoiceSessionButton
            agentId={agentId ?? ""}
            hasActiveSession={!!activeSession}
            isConfigured={!!voiceConfig}
          />
        </section>

        {/* Section 4: Recent Calls */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-medium">Recent Calls</h2>
            <Link
              href="/dashboard/voice"
              className="text-xs text-primary min-h-[44px] flex items-center"
            >
              View All
            </Link>
          </div>
          {recentCalls && recentCalls.length > 0 ? (
            <div className="space-y-2">
              {recentCalls.map((call) => {
                const contact = call.contacts as unknown as { id: string; first_name: string; last_name: string } | null
                const contactName = contact
                  ? `${contact.first_name} ${contact.last_name}`
                  : "Unknown"
                const isInbound = call.direction === "inbound"

                return (
                  <Link
                    key={call.id}
                    href={`/dashboard/voice/review/${call.id}`}
                    className="block"
                  >
                    <Card className="p-3 active:opacity-70">
                      <div className="flex items-center gap-3">
                        <div
                          className={`h-10 w-10 rounded-full flex items-center justify-center flex-shrink-0 ${
                            isInbound ? "bg-blue-100 text-blue-700" : "bg-emerald-100 text-emerald-700"
                          }`}
                        >
                          {isInbound ? (
                            <PhoneIncoming className="h-5 w-5" />
                          ) : (
                            <PhoneOutgoing className="h-5 w-5" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm truncate">{contactName}</p>
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <Badge
                              variant={isInbound ? "secondary" : "outline"}
                              className="text-xs"
                            >
                              {isInbound ? "Inbound" : "Outbound"}
                            </Badge>
                            {call.duration_seconds && (
                              <>
                                <Clock className="h-3 w-3" />
                                <span>{Math.floor(call.duration_seconds / 60)}m {call.duration_seconds % 60}s</span>
                              </>
                            )}
                          </div>
                        </div>
                        <div className="text-right flex-shrink-0">
                          <p className="text-xs text-muted-foreground">
                            {call.started_at
                              ? formatDistanceToNow(new Date(call.started_at), { addSuffix: true })
                              : ""}
                          </p>
                        </div>
                      </div>
                    </Card>
                  </Link>
                )
              })}
            </div>
          ) : (
            <Card className="p-4 text-center text-muted-foreground text-sm">
              No recent calls
            </Card>
          )}
        </section>

        {/* Section 5: Quick Dial */}
        <section>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Quick Dial</CardTitle>
            </CardHeader>
            <CardContent>
              <QuickDialSearch agentId={agentId ?? ""} brokerageId={brokerageId ?? ""} />
            </CardContent>
          </Card>
        </section>

        {/* Mobile OS Quick Contact Panel */}
        <QuickContactPanel contacts={[]} />
      </main>
    </div>
  )
}

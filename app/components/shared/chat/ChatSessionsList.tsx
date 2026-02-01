"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Plus, MessageSquare, Clock, Flame, Wind, Snowflake } from "lucide-react"
import { createChatSession } from "@/app/actions/ai-chat"
import { useToast } from "@/hooks/use-toast"
import { formatDistanceToNow } from "date-fns"

export default function ChatSessionsList({ sessions, agentId }: { sessions: any[]; agentId: string }) {
  const router = useRouter()
  const { toast } = useToast()
  const [isCreating, setIsCreating] = useState(false)
  
  // Check if this is demo mode (non-UUID agentId)
  const isDemoMode = !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agentId)

  const handleNewSession = async () => {
    setIsCreating(true)
    try {
      console.log("[v0] Creating new session for agentId:", agentId)
      
      const session = await createChatSession({
        agentId: agentId,
        sessionType: "lead_qualification",
      })

      router.push(`/dashboard/chat?session=${session.id}`)
      toast({ title: "New session created" })
    } catch (error) {
      console.error("[v0] Error creating chat session:", error)
      toast({ 
        title: "Unable to create session", 
        description: "Please ensure you're logged in with a valid account.",
        variant: "destructive" 
      })
    }
    setIsCreating(false)
  }

  const getTemperatureIcon = (temp: string) => {
    switch (temp) {
      case "hot":
        return <Flame className="w-4 h-4 text-red-600" />
      case "warm":
        return <Wind className="w-4 h-4 text-orange-600" />
      case "cold":
        return <Snowflake className="w-4 h-4 text-blue-600" />
      default:
        return <MessageSquare className="w-4 h-4" />
    }
  }

  return (
    <Card className="h-[700px] flex flex-col bg-background border">
      <CardHeader className="border-b">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base text-foreground">Sessions</CardTitle>
          {!isDemoMode && (
            <Button size="sm" onClick={handleNewSession} disabled={isCreating}>
              <Plus className="w-4 h-4 mr-1" />
              New
            </Button>
          )}
        </div>
      </CardHeader>

      <ScrollArea className="flex-1">
        <CardContent className="p-2 space-y-2">
          {sessions.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <MessageSquare className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p className="text-sm">No active sessions</p>
              {!isDemoMode && (
                <Button variant="outline" size="sm" className="mt-4 bg-transparent" onClick={handleNewSession}>
                  Start a New Chat
                </Button>
              )}
              {isDemoMode && (
                <p className="text-xs mt-4">Sign in to start a new chat session</p>
              )}
            </div>
          ) : (
            sessions.map((session) => (
              <Card
                key={session.id}
                className="cursor-pointer hover:bg-accent transition-colors bg-background border"
                onClick={() => router.push(`/dashboard/chat?session=${session.id}`)}
              >
                <CardContent className="p-3 space-y-2">
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        {session.contacts && getTemperatureIcon(session.contacts.lead_temperature)}
                        <h4 className="font-semibold text-sm truncate text-foreground">
                          {session.contacts
                            ? `${session.contacts.first_name} ${session.contacts.last_name}`
                            : "General Chat"}
                        </h4>
                      </div>
                      <p className="text-xs text-muted-foreground truncate mt-1">
                        {session.contacts?.email || session.session_type.replace("_", " ")}
                      </p>
                    </div>
                    {session.contacts && (
                      <Badge
                        variant={
                          session.contacts.lead_temperature === "hot"
                            ? "destructive"
                            : session.contacts.lead_temperature === "warm"
                              ? "default"
                              : "secondary"
                        }
                        className="text-xs"
                      >
                        {session.contacts.lead_temperature}
                      </Badge>
                    )}
                  </div>

                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <MessageSquare className="w-3 h-3" />
                      {session.chat_messages?.length || 0} messages
                    </span>
                    <span className="flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {formatDistanceToNow(new Date(session.last_activity_at), {
                        addSuffix: true,
                      })}
                    </span>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </CardContent>
      </ScrollArea>
    </Card>
  )
}

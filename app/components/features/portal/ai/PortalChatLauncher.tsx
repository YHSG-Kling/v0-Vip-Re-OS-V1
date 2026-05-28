"use client"

import { useState } from "react"
import { Video, Phone, X } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { toast } from "sonner"
import PortalAIAssistant from "./PortalAIAssistant"
import { AgentsWidget } from "@/app/components/features/ai-avatar-chat/AgentsWidget"

interface Contact {
  id: string
  first_name?: string | null
  brokerage_id?: string | null
  agent_id?: string | null
  contact_persona?: string | null
  phone?: string | null
}

interface PortalChatLauncherProps {
  contact: Contact
  contactId: string
  isBuyer: boolean
  isSeller: boolean
  persona: string
  agentFirstName: string
  /** True when the assigned agent has an avatar set up (gates the Live button).
   *  The widget itself resolves presenter/voice server-side via /api/did/agents/session. */
  agentHasDIDAvatar: boolean
}

export default function PortalChatLauncher({
  contact,
  contactId,
  isBuyer,
  isSeller,
  persona,
  agentFirstName,
  agentHasDIDAvatar,
}: PortalChatLauncherProps) {
  const [liveAgentOpen, setLiveAgentOpen] = useState(false)
  const [callbackSent, setCallbackSent] = useState(false)
  const [callbackSending, setCallbackSending] = useState(false)

  async function sendCallback() {
    setCallbackSending(true)
    try {
      const res = await fetch("/api/portal/escalate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactId, requestType: "callback" }),
      })
      if (res.ok) {
        setCallbackSent(true)
        toast.success(`Callback requested! ${agentFirstName} will reach out shortly.`)
      }
    } finally {
      setCallbackSending(false)
    }
  }

  return (
    <>
      {/* Text AI chat — existing autonomous widget */}
      <PortalAIAssistant
        contact={contact}
        contactId={contactId}
        isBuyer={isBuyer}
        isSeller={isSeller}
        persona={persona}
      />

      {/* Extra action buttons above the chat FAB */}
      <div className="fixed bottom-24 right-6 z-50 flex flex-col items-end gap-2">
        {agentHasDIDAvatar && !liveAgentOpen && (
          <button
            onClick={() => setLiveAgentOpen(true)}
            className="flex items-center gap-2 bg-background border shadow-md rounded-full px-3 py-2 text-sm hover:bg-muted transition-colors"
            aria-label="Live Agent video"
          >
            <Video className="h-4 w-4 text-primary" />
            <span>Live: {agentFirstName}</span>
          </button>
        )}

        {!callbackSent ? (
          <button
            onClick={sendCallback}
            disabled={callbackSending}
            className="flex items-center gap-2 bg-background border shadow-md rounded-full px-3 py-2 text-sm hover:bg-muted transition-colors disabled:opacity-50"
            aria-label="Request callback"
          >
            <Phone className="h-4 w-4 text-primary" />
            <span>{callbackSending ? "Sending…" : `Call me back`}</span>
          </button>
        ) : (
          <div className="flex items-center gap-2 bg-green-50 border border-green-200 rounded-full px-3 py-2 text-sm text-green-700">
            <Phone className="h-4 w-4" />
            <span>Callback requested ✓</span>
          </div>
        )}
      </div>

      {/* Live Agent overlay */}
      {liveAgentOpen && (
        <div className="fixed bottom-6 right-6 z-[60] w-80 sm:w-96">
          <Card className="shadow-2xl border">
            <div className="flex items-center justify-between px-4 py-3 border-b bg-primary text-primary-foreground rounded-t-lg">
              <div className="flex items-center gap-2">
                <Video className="h-4 w-4" />
                <span className="text-sm font-semibold">Live — {agentFirstName}</span>
              </div>
              <button onClick={() => setLiveAgentOpen(false)} className="hover:opacity-70">
                <X className="h-4 w-4" />
              </button>
            </div>
            <CardContent className="p-0">
              <AgentsWidget
                contactId={contactId}
                agentFirstName={agentFirstName}
                onFallbackToText={() => setLiveAgentOpen(false)}
              />
            </CardContent>
          </Card>
        </div>
      )}
    </>
  )
}

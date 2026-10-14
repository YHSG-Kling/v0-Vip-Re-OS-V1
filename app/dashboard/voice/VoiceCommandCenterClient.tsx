"use client"

import { useState, useTransition } from "react"
import { useToast } from "@/hooks/use-toast"
import { handleVoiceCommand } from "@/app/actions/voice-assistant/handle-voice-command"
import { WakeWordCard } from "@/app/components/dashboard/voice/WakeWordCard"
import { QuickCommandGrid } from "@/app/components/dashboard/voice/QuickCommandGrid"
// The KERNEL lane's door (POST /api/agentic-os/voice → planVoiceCommand). The direct
// lane below it (handleVoiceCommand → COMMAND_EXECUTORS, one verb) is untouched.
import { KernelPlanCard } from "@/app/components/dashboard/voice/KernelPlanCard"
import { RecentCommandsFeed, type VoiceCommandRow } from "@/app/components/dashboard/voice/RecentCommandsFeed"
import { AiOutboundCallPanel } from "@/app/components/dashboard/voice/AiOutboundCallPanel"
import { VoiceAnalytics } from "@/app/components/dashboard/voice/VoiceAnalytics"
import { VoiceCallHistoryTable, type VoiceCallRow } from "@/app/components/dashboard/voice/VoiceCallHistoryTable"
import type {
  VoiceCommandRequest,
} from "@/app/actions/voice-assistant/handle-voice-command"

interface Props {
  wakeName: string
  userId: string
  userRole: VoiceCommandRequest["user_role"]
  brokerageId: string
  initialCommands: VoiceCommandRow[]
  contacts: Array<{ id: string; first_name: string | null; last_name: string | null; phone: string | null }>
  scripts: Array<{ id: string; title: string }>
  summaryCards: Array<{ label: string; value: string | number }>
  commandTypeData: Array<{ name: string; value: number }>
  avgConfidence: number
  callHistory: VoiceCallRow[]
}

export function VoiceCommandCenterClient({
  wakeName,
  userId,
  userRole,
  brokerageId,
  initialCommands,
  contacts,
  scripts,
  summaryCards,
  commandTypeData,
  avgConfidence,
  callHistory,
}: Props) {
  const { toast } = useToast()
  const [commands, setCommands] = useState<VoiceCommandRow[]>(initialCommands)
  const [isPending, startTransition] = useTransition()

  /**
   * Central command handler — called by WakeWordCard (full voice flow)
   * and QuickCommandGrid (text shortcut).
   */
  async function executeCommand(transcript: string) {
    const result = await handleVoiceCommand({
      voice_input: transcript,
      user_id: userId,
      user_role: userRole,
      brokerage_id: brokerageId,
    })

    // Optimistically prepend to recent commands feed
    const newRow: VoiceCommandRow = {
      id: crypto.randomUUID(),
      command_type: result.action_taken ?? null,
      raw_transcript: transcript,
      action_taken: result.action_taken ?? null,
      success: result.success,
      confidence_score: null,
      created_at: new Date().toISOString(),
    }
    setCommands((prev) => [newRow, ...prev.slice(0, 9)])

    return {
      success: result.success,
      spoken_response: result.spoken_response,
      text_response: result.text_response,
    }
  }

  /** QuickCommandGrid tap handler — shows result as toast */
  function handleQuickCommand(command: string) {
    startTransition(async () => {
      const result = await executeCommand(command)
      toast({
        title: result.success ? "Command executed" : "Command failed",
        description: result.text_response,
        variant: result.success ? "default" : "destructive",
      })
    })
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
      {/* ── LEFT COLUMN ── */}
      <div className="space-y-4">
        <WakeWordCard
          wakeName={wakeName}
          onCommand={executeCommand}
        />

        <QuickCommandGrid
          onCommand={handleQuickCommand}
          isDisabled={isPending}
        />

        {/* One utterance → several capabilities → one governed signal per step,
            each attributed to the manager whose charter owns it. */}
        <KernelPlanCard />

        <RecentCommandsFeed commands={commands} />

        <AiOutboundCallPanel
          contacts={contacts}
          scripts={scripts}
          agentId={userId}
          brokerageId={brokerageId}
        />
      </div>

      {/* ── RIGHT COLUMN ── */}
      <div className="space-y-4">
        <VoiceAnalytics
          summaryCards={summaryCards}
          commandTypeData={commandTypeData}
          avgConfidence={avgConfidence}
        />

        <VoiceCallHistoryTable calls={callHistory} />
      </div>
    </div>
  )
}

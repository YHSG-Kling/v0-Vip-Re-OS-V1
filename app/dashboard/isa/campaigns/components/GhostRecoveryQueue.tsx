"use client"

import { useState, useTransition } from "react"
import { Mail, MessageSquare, Video, FileText, Phone, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { triggerGhostRecovery, skipGhostContact, getGhostRecoveryQueue, type GhostContact } from "@/app/actions/ai-isa"

const CHANNEL_ICON: Record<string, React.ReactNode> = {
  email:       <Mail className="h-3.5 w-3.5 text-blue-500" />,
  sms:         <MessageSquare className="h-3.5 w-3.5 text-green-500" />,
  video:       <Video className="h-3.5 w-3.5 text-purple-500" />,
  direct_mail: <FileText className="h-3.5 w-3.5 text-orange-500" />,
  phone:       <Phone className="h-3.5 w-3.5 text-gray-500" />,
}

const STAGE_CONFIG = {
  "24h": { label: "24h", color: "border-yellow-400 bg-yellow-50",  badge: "bg-yellow-100 text-yellow-800" },
  "48h": { label: "48h", color: "border-orange-400 bg-orange-50",  badge: "bg-orange-100 text-orange-800" },
  "72h": { label: "72h", color: "border-red-400 bg-red-50",        badge: "bg-red-100 text-red-800"       },
}

function nextRetryLabel(hoursAgo: number, stage: GhostContact["stage"]): string {
  const nextAt = stage === "24h" ? 48 : stage === "48h" ? 72 : 96
  const remaining = nextAt - hoursAgo
  if (remaining <= 0) return "Overdue"
  if (remaining < 1)  return "< 1h"
  return `${Math.round(remaining)}h`
}

interface RowProps {
  ghost:       GhostContact
  brokerageId: string
  onDone:      () => void
}

function GhostRow({ ghost, brokerageId, onDone }: RowProps) {
  const [isPending, startTransition] = useTransition()
  const [feedback, setFeedback]      = useState<string | null>(null)

  const name = [ghost.contact_first_name, ghost.contact_last_name].filter(Boolean).join(" ") || "Unknown Contact"

  function handleTrigger() {
    startTransition(async () => {
      setFeedback(null)
      const result = await triggerGhostRecovery({
        contactId:   ghost.contact_id,
        campaignId:  ghost.campaign_id ?? "",
        brokerageId,
      })
      setFeedback(result.success ? "Sent." : result.error ?? "Failed.")
      if (result.success) onDone()
    })
  }

  function handleSkip() {
    startTransition(async () => {
      setFeedback(null)
      const result = await skipGhostContact({
        contactId:   ghost.contact_id,
        campaignId:  ghost.campaign_id ?? "",
        brokerageId,
      })
      setFeedback(result.success ? "Skipped." : result.error ?? "Failed.")
      if (result.success) onDone()
    })
  }

  return (
    <div className="rounded-md border border-border bg-card p-3 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <div>
          <a
            href={`/crm/contacts/${ghost.contact_id}`}
            className="text-sm font-medium text-foreground hover:underline"
          >
            {name}
          </a>
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            {ghost.last_channel && CHANNEL_ICON[ghost.last_channel]}
            <span>{ghost.last_channel?.replace("_"," ") ?? "—"}</span>
            <span>·</span>
            <span>{ghost.attempt_count} attempt{ghost.attempt_count !== 1 ? "s" : ""}</span>
          </div>
          {ghost.campaign_name && (
            <p className="mt-0.5 text-xs text-muted-foreground truncate max-w-[160px]">{ghost.campaign_name}</p>
          )}
        </div>
        <div className="text-right shrink-0">
          <p className="text-xs text-muted-foreground">Next retry</p>
          <p className="text-xs font-semibold text-foreground">{nextRetryLabel(ghost.hours_since_last_touch, ghost.stage)}</p>
        </div>
      </div>

      {feedback && (
        <p className="text-xs text-muted-foreground">{feedback}</p>
      )}

      <div className="flex gap-2">
        <Button
          size="sm"
          variant="default"
          className="flex-1 h-7 text-xs"
          onClick={handleTrigger}
          disabled={isPending}
        >
          Manual Trigger
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="flex-1 h-7 text-xs"
          onClick={handleSkip}
          disabled={isPending}
        >
          Skip
        </Button>
      </div>
    </div>
  )
}

interface Props {
  brokerageId:    string
  initialGhosts:  GhostContact[]
}

export function GhostRecoveryQueue({ brokerageId, initialGhosts }: Props) {
  const [ghosts, setGhosts]          = useState<GhostContact[]>(initialGhosts)
  const [isRefreshing, startRefresh] = useTransition()

  function refresh() {
    startRefresh(async () => {
      const result = await getGhostRecoveryQueue(brokerageId)
      if (result.success) setGhosts(result.ghosts)
    })
  }

  const stages: GhostContact["stage"][] = ["24h", "48h", "72h"]

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Contacts with no reply in 24+ hours. Ghost = last engagement had no{" "}
          <span className="font-medium text-foreground">replied</span> event.
        </p>
        <Button size="sm" variant="outline" onClick={refresh} disabled={isRefreshing} className="gap-1.5 h-8">
          <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {stages.map(stage => {
          const stageGhosts = ghosts.filter(g => g.stage === stage)
          const cfg = STAGE_CONFIG[stage]
          return (
            <div key={stage} className={`rounded-lg border-2 ${cfg.color} p-4 flex flex-col gap-3`}>
              {/* Column header */}
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-foreground">{cfg.label} Ghosts</h3>
                <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${cfg.badge}`}>
                  {stageGhosts.length}
                </span>
              </div>

              {/* Contact rows */}
              {stageGhosts.length === 0 ? (
                <p className="text-xs text-muted-foreground py-4 text-center">No contacts in this stage.</p>
              ) : stageGhosts.map(ghost => (
                <GhostRow
                  key={ghost.contact_id}
                  ghost={ghost}
                  brokerageId={brokerageId}
                  onDone={refresh}
                />
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

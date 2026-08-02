"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Ghost,
  RefreshCw,
  XCircle,
  Clock,
  Phone,
  Mail,
  MessageSquare,
  MoreHorizontal,
} from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { retryGhostContact, suppressGhostContact } from "@/app/actions/ai-isa"

type GhostStage = "24h" | "48h" | "72h"

interface GhostContact {
  contact_id: string
  contact_first_name: string | null
  contact_last_name: string | null
  campaign_id: string | null
  campaign_name: string | null
  last_channel: string | null
  attempt_count: number
  last_touched_at: string
  hours_since_last_touch: number
  stage: GhostStage
}

interface GhostRecoveryPanelProps {
  ghosts: GhostContact[]
  brokerageId: string
}

const stageConfig: Record<GhostStage, { label: string; color: string; bgColor: string }> = {
  "24h": { label: "24h No Response", color: "text-amber-600", bgColor: "bg-amber-50" },
  "48h": { label: "48h No Response", color: "text-orange-600", bgColor: "bg-orange-50" },
  "72h": { label: "72h+ No Response", color: "text-red-600", bgColor: "bg-red-50" },
}

function getChannelIcon(channel: string | null) {
  switch (channel) {
    case "phone":
    case "voice":
      return Phone
    case "email":
      return Mail
    case "sms":
      return MessageSquare
    default:
      return MessageSquare
  }
}

export function GhostRecoveryPanel({ ghosts, brokerageId }: GhostRecoveryPanelProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [actioningId, setActioningId] = useState<string | null>(null)

  const ghostsByStage = {
    "24h": ghosts.filter((g) => g.stage === "24h"),
    "48h": ghosts.filter((g) => g.stage === "48h"),
    "72h": ghosts.filter((g) => g.stage === "72h"),
  }

  const handleRetry = async (contactId: string, channel: "email" | "sms" | "phone") => {
    setActioningId(contactId)
    startTransition(async () => {
      // Reports failure BY RETURN. A suppressed contact that failed to suppress
      // keeps getting chased; a retry that failed silently never went out.
      const r = await retryGhostContact({ brokerageId, contactId, channel })
      if (!r?.success) {
        toast.error((r as any)?.error ?? "The retry was not sent.")
        setActioningId(null)
        return
      }
      router.refresh()
      setActioningId(null)
    })
  }

  const handleSuppress = async (contactId: string) => {
    setActioningId(contactId)
    startTransition(async () => {
      const r = await suppressGhostContact({ brokerageId, contactId })
      if (!r?.success) {
        toast.error((r as any)?.error ?? "The contact was not suppressed.")
        setActioningId(null)
        return
      }
      router.refresh()
      setActioningId(null)
    })
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Ghost className="h-4 w-4 text-purple-600" />
            Ghost Recovery Queue
          </CardTitle>
          <Badge variant="secondary" className="text-xs">
            {ghosts.length} no-response leads
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        {ghosts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <Ghost className="h-10 w-10 text-muted-foreground/50 mb-3" />
            <p className="text-sm text-muted-foreground">No ghost contacts</p>
            <p className="text-xs text-muted-foreground mt-1">
              Leads with no response will appear here for recovery
            </p>
          </div>
        ) : (
          <>
            {/* Stage Summary */}
            <div className="flex gap-2 mb-3 pb-3 border-b">
              {(["24h", "48h", "72h"] as GhostStage[]).map((stage) => {
                const config = stageConfig[stage]
                const count = ghostsByStage[stage].length
                return (
                  <div
                    key={stage}
                    className={`${config.bgColor} rounded-md px-2 py-1 flex items-center gap-1`}
                  >
                    <Clock className={`h-3 w-3 ${config.color}`} />
                    <span className={`text-xs font-bold ${config.color}`}>{count}</span>
                    <span className="text-xs text-muted-foreground">{config.label}</span>
                  </div>
                )
              })}
            </div>

            {/* Ghost List */}
            <ScrollArea className="h-[260px]">
              <div className="space-y-2 pr-2">
                {ghosts.map((ghost) => {
                  const config = stageConfig[ghost.stage]
                  const ChannelIcon = getChannelIcon(ghost.last_channel)
                  const contactName =
                    `${ghost.contact_first_name || ""} ${ghost.contact_last_name || ""}`.trim() ||
                    "Unknown"

                  return (
                    <div
                      key={ghost.contact_id}
                      className={`${config.bgColor} border rounded-lg p-2.5`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="text-sm font-medium">{contactName}</p>
                          <div className="flex items-center gap-2 mt-0.5">
                            <Badge variant="outline" className="text-[10px] h-4">
                              <ChannelIcon className="h-2.5 w-2.5 mr-0.5" />
                              {ghost.last_channel || "unknown"}
                            </Badge>
                            <span className="text-[10px] text-muted-foreground">
                              {ghost.attempt_count} attempt{ghost.attempt_count !== 1 ? "s" : ""}
                            </span>
                          </div>
                        </div>
                        <Badge className={`${config.bgColor} ${config.color} border-0 text-[10px]`}>
                          {Math.round(ghost.hours_since_last_touch)}h silent
                        </Badge>
                      </div>

                      {ghost.campaign_name && (
                        <p className="text-xs text-muted-foreground mt-1">
                          Campaign: {ghost.campaign_name}
                        </p>
                      )}

                      <div className="flex items-center justify-end mt-2 gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 text-xs"
                          disabled={isPending && actioningId === ghost.contact_id}
                          onClick={() => handleRetry(ghost.contact_id, "email")}
                        >
                          <RefreshCw className="h-3 w-3 mr-1" />
                          Re-engage
                        </Button>

                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="sm" className="h-6 w-6 p-0">
                              <MoreHorizontal className="h-3.5 w-3.5" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => handleRetry(ghost.contact_id, "sms")}>
                              <MessageSquare className="h-3.5 w-3.5 mr-2" />
                              Retry via SMS
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleRetry(ghost.contact_id, "phone")}>
                              <Phone className="h-3.5 w-3.5 mr-2" />
                              Retry via Phone
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="text-red-600"
                              onClick={() => handleSuppress(ghost.contact_id)}
                            >
                              <XCircle className="h-3.5 w-3.5 mr-2" />
                              Suppress / Skip
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>
                  )
                })}
              </div>
            </ScrollArea>
          </>
        )}
      </CardContent>
    </Card>
  )
}

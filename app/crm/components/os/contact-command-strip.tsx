"use client"

import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { Phone, MessageSquare, ExternalLink, FileText, AlertTriangle, Zap, Pause, ChevronDown, Loader2, ShieldOff, Share2 } from "lucide-react"
import Link from "next/link"
import { processOptOut } from "@/app/actions/ai-isa/process-opt-out"
import { createClient } from "@/lib/supabase/client"
import { logActivity } from "@/app/actions/activities"

interface ContactCommandStripProps {
  contact: {
    id: string
    first_name: string
    last_name: string
    contact_persona?: string | null
    buyer_stage?: string | null
    contact_type?: string | null
    email?: string | null
    phone?: string | null
    lead_source?: string | null
    created_at?: string | null
    dnc_status?: boolean | null
    email_opt_out?: boolean | null
    sms_opt_out?: boolean | null
    phone_opt_out?: boolean | null
    direct_mail_opt_out?: boolean | null
  }
  churnRisk?: { churning: boolean; daysInactive?: number; reason?: string } | null
  autopilotPlans?: Array<{ id: string; is_active: boolean; autopilot_level: string }> | null
  agentId: string
  brokerageId: string
  onEnableAutopilot: (level: "conservative" | "moderate" | "aggressive") => Promise<void>
  onToggleAutopilot: (planId: string, pause: boolean) => Promise<void>
  onShareSocialPost?: () => void | Promise<void>
  onChannelToggled?: () => void
  onAddNote?: () => void
  loading?: boolean
}

const PERSONA_COLORS: Record<string, string> = {
  "first-time-buyer": "bg-blue-100 text-blue-800",
  "move-up-buyer": "bg-indigo-100 text-indigo-800",
  "investor": "bg-purple-100 text-purple-800",
  "downsizer": "bg-teal-100 text-teal-800",
  "relocator": "bg-orange-100 text-orange-800",
  "luxury": "bg-amber-100 text-amber-800",
}

const STAGE_COLORS: Record<string, string> = {
  "new": "bg-slate-100 text-slate-700",
  "researching": "bg-blue-100 text-blue-700",
  "actively-looking": "bg-indigo-100 text-indigo-700",
  "pre-approved": "bg-green-100 text-green-700",
  "under-contract": "bg-amber-100 text-amber-700",
  "closed": "bg-emerald-100 text-emerald-700",
}

export function ContactCommandStrip({
  contact,
  churnRisk,
  autopilotPlans,
  agentId,
  brokerageId,
  onEnableAutopilot,
  onToggleAutopilot,
  onShareSocialPost,
  onChannelToggled,
  onAddNote,
  loading = false,
}: ContactCommandStripProps) {
  const [autopilotLoading, setAutopilotLoading] = useState(false)
  const [channelLoading, setChannelLoading] = useState<string | null>(null)

  const activePlan = autopilotPlans?.find((p) => p.is_active)

  const handleEnableAutopilot = async (level: "conservative" | "moderate" | "aggressive") => {
    setAutopilotLoading(true)
    try {
      await onEnableAutopilot(level)
    } finally {
      setAutopilotLoading(false)
    }
  }

  const handleToggleAutopilot = async (planId: string, pause: boolean) => {
    setAutopilotLoading(true)
    try {
      await onToggleAutopilot(planId, pause)
    } finally {
      setAutopilotLoading(false)
    }
  }

  return (
    <div className="bg-gradient-to-r from-blue-700 to-indigo-800 text-white rounded-lg p-4">
      <div className="flex items-center justify-between flex-wrap gap-4">
        {/* LEFT: Name + badges + churn alert */}
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="text-xl font-bold">
            {contact.first_name} {contact.last_name}
          </h2>
          {contact.contact_persona && (
            <Badge className={PERSONA_COLORS[contact.contact_persona] || "bg-gray-100 text-gray-700"}>
              {contact.contact_persona.replace(/-/g, " ")}
            </Badge>
          )}
          {contact.buyer_stage && (
            <Badge className={STAGE_COLORS[contact.buyer_stage] || "bg-gray-100 text-gray-700"}>
              {contact.buyer_stage.replace(/-/g, " ")}
            </Badge>
          )}
          {churnRisk?.churning && (
            <Badge className="bg-red-500 text-white flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" />
              {churnRisk.daysInactive} days inactive - {churnRisk.reason}
            </Badge>
          )}
        </div>

        {/* CENTER: Contact type + quick actions */}
        <div className="flex items-center gap-2">
          {contact.contact_type && (
            <Badge variant="outline" className="bg-white/10 text-white border-white/30">
              {contact.contact_type}
            </Badge>
          )}
          {contact.phone && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-white hover:bg-white/20"
                    onClick={async () => {
                      await logActivity({
                        brokerageId,
                        agentId,
                        contactId: contact.id,
                        activityType: "call_initiated",
                        title: `Call initiated with ${contact.first_name} ${contact.last_name}`,
                        status: "completed",
                      }).catch(console.error)
                      window.location.href = `tel:${contact.phone}`
                    }}
                  >
                    <Phone className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Call</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          {contact.phone && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-white hover:bg-white/20"
                    onClick={async () => {
                      await logActivity({
                        brokerageId,
                        agentId,
                        contactId: contact.id,
                        activityType: "sms_sent",
                        title: `SMS initiated with ${contact.first_name} ${contact.last_name}`,
                        status: "completed",
                      }).catch(console.error)
                      window.location.href = `sms:${contact.phone}`
                    }}
                  >
                    <MessageSquare className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Text</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="sm" variant="ghost" className="text-white hover:bg-white/20" asChild>
                  <Link href={`/portal/${contact.id}`}>
                    <ExternalLink className="h-4 w-4" />
                  </Link>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Open Portal</TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="sm" variant="ghost" className="text-white hover:bg-white/20" onClick={() => onAddNote?.()}>
                  <FileText className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Add Note</TooltipContent>
            </Tooltip>
          </TooltipProvider>
          {onShareSocialPost && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-white hover:bg-white/20"
                    onClick={() => onShareSocialPost()}
                  >
                    <Share2 className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Share Social Post</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>

        {/* RIGHT: Autopilot section */}
        <div className="flex items-center gap-2">
          {!activePlan ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  className="bg-white/20 hover:bg-white/30 text-white"
                  disabled={autopilotLoading}
                >
                  {autopilotLoading ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Zap className="h-4 w-4 mr-2" />
                  )}
                  Enable AI Autopilot
                  <ChevronDown className="h-4 w-4 ml-2" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onClick={() => handleEnableAutopilot("conservative")}>
                  Conservative - Light touches only
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => handleEnableAutopilot("moderate")}>
                  Moderate - Regular nurturing
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => handleEnableAutopilot("aggressive")}>
                  Aggressive - Full engagement
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <>
              <Badge className="bg-emerald-500 text-white flex items-center gap-1">
                <Zap className="h-3 w-3" />
                AI Autopilot Active - {activePlan.autopilot_level}
              </Badge>
              <Button
                size="sm"
                variant="ghost"
                className="text-white hover:bg-white/20"
                onClick={() => handleToggleAutopilot(activePlan.id, true)}
                disabled={autopilotLoading}
              >
                {autopilotLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pause className="h-4 w-4" />}
                Pause
              </Button>
            </>
          )}
        </div>
      </div>

      {/* BOTTOM ticker */}
      <div className="mt-3 pt-3 border-t border-white/20 flex items-center gap-4 text-xs text-white/80 flex-wrap">
        {contact.email && <span>{contact.email}</span>}
        {contact.phone && <span>{contact.phone}</span>}
        {contact.lead_source && <span>Source: {contact.lead_source}</span>}
        {contact.buyer_stage && <span>Stage: {contact.buyer_stage}</span>}
      </div>

      {/* Channel preferences — always rendered so agents can see and manage suppression */}
      <div className="mt-3 pt-3 border-t border-white/10">
        <p className="text-xs text-white/60 mb-2">Communication Channels</p>
        <div className="flex flex-wrap gap-2 items-center">
          {(["email", "sms", "phone", "direct_mail"] as const).map((ch) => {
            const isOptedOut =
              ch === "email"       ? !!contact.email_opt_out
              : ch === "sms"       ? !!contact.sms_opt_out
              : ch === "phone"     ? !!contact.phone_opt_out
              : !!contact.direct_mail_opt_out

            const label = ch === "direct_mail" ? "Mail" : ch.charAt(0).toUpperCase() + ch.slice(1)
            const isLoading = channelLoading === ch

            return (
              <button
                key={ch}
                type="button"
                disabled={isLoading}
                className={`text-xs px-2 py-1 rounded-full border transition-colors flex items-center gap-1 ${
                  isOptedOut
                    ? "bg-red-500/20 border-red-400/40 text-red-200 line-through"
                    : "bg-white/10 border-white/20 text-white hover:bg-white/20"
                }`}
                onClick={async () => {
                  setChannelLoading(ch)
                  try {
                    if (isOptedOut) {
                      // Agent re-enabling a suppressed channel
                      const supabase = createClient()
                      await supabase
                        .from("contacts")
                        .update({ [`${ch}_opt_out`]: false })
                        .eq("id", contact.id)
                    } else {
                      // Agent manually suppressing a channel
                      await processOptOut({
                        entityType: "contact",
                        entityId: contact.id,
                        channel: ch,
                        source: "agent",
                        brokerageId,
                      })
                    }
                    onChannelToggled?.()
                  } finally {
                    setChannelLoading(null)
                  }
                }}
              >
                {isLoading ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <ShieldOff className={`h-3 w-3 ${isOptedOut ? "text-red-300" : "text-white/40"}`} />
                )}
                {label}
              </button>
            )
          })}

          {contact.dnc_status && (
            <span className="text-xs px-2 py-1 rounded-full bg-red-600/40 border border-red-400/60 text-red-100 font-semibold">
              Global DNC
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

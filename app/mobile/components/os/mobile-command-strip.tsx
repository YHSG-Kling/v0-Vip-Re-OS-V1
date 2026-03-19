"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { Phone, MessageSquare, MapPin, Mic, Clock, Calendar, FileText, Plus } from "lucide-react"
import Link from "next/link"

interface MobileCommandStripProps {
  agentId: string
  onQuickCall?: () => void
  onQuickText?: () => void
  onVoiceAssistant?: () => void
}

export function MobileCommandStrip({
  agentId,
  onQuickCall,
  onQuickText,
  onVoiceAssistant,
}: MobileCommandStripProps) {
  const [expanded, setExpanded] = useState(false)

  const primaryActions = [
    {
      icon: Phone,
      label: "Call",
      action: onQuickCall,
      color: "bg-green-500 hover:bg-green-600 text-white",
    },
    {
      icon: MessageSquare,
      label: "Text",
      action: onQuickText,
      color: "bg-blue-500 hover:bg-blue-600 text-white",
    },
    {
      icon: Mic,
      label: "Voice",
      action: onVoiceAssistant,
      href: "/mobile/voice",
      color: "bg-purple-500 hover:bg-purple-600 text-white",
    },
    {
      icon: Calendar,
      label: "Today",
      href: "/mobile/assistant",
      color: "bg-orange-500 hover:bg-orange-600 text-white",
    },
  ]

  const secondaryActions = [
    { icon: MapPin, label: "Directions", href: "/mobile/directions" },
    { icon: Clock, label: "Log Activity", href: "/mobile/log" },
    { icon: FileText, label: "Quick Note", href: "/mobile/notes/new" },
    { icon: Plus, label: "New Contact", href: "/mobile/contacts/new" },
  ]

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 bg-background border-t safe-area-inset-bottom">
      {/* Expanded Secondary Actions */}
      {expanded && (
        <div className="px-4 py-3 border-b bg-muted/50 animate-in slide-in-from-bottom-2">
          <div className="grid grid-cols-4 gap-2">
            {secondaryActions.map((action) => (
              <Link key={action.label} href={action.href}>
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full flex flex-col items-center gap-1 h-auto py-2"
                >
                  <action.icon className="h-4 w-4" />
                  <span className="text-xs">{action.label}</span>
                </Button>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Primary Command Strip */}
      <div className="px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          {primaryActions.map((action) => {
            const content = (
              <Button
                key={action.label}
                size="sm"
                className={cn("flex-1 flex flex-col items-center gap-1 h-auto py-2", action.color)}
                onClick={action.action}
              >
                <action.icon className="h-5 w-5" />
                <span className="text-xs font-medium">{action.label}</span>
              </Button>
            )

            if (action.href) {
              return (
                <Link key={action.label} href={action.href} className="flex-1">
                  {content}
                </Link>
              )
            }

            return content
          })}

          {/* Expand Toggle */}
          <Button
            variant="outline"
            size="sm"
            className="h-auto py-2 px-3"
            onClick={() => setExpanded(!expanded)}
          >
            <Plus className={cn("h-5 w-5 transition-transform", expanded && "rotate-45")} />
          </Button>
        </div>
      </div>
    </div>
  )
}

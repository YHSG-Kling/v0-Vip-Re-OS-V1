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

  // ── ORPHAN-ROUTE SWEEP (lane G) — "Activity" was a link to nothing, while the
  //    page it wanted was a route nothing linked to. Both halves are here:
  //
  //    · `/mobile/log` DOES NOT EXIST. `ls app/mobile` is activity, approvals,
  //      assistant, contacts, voice — there is no `log` segment and never was, so
  //      this tile 404'd on every tap since it was written.
  //    · `/mobile/activity` DOES exist and is the reader for exactly this: the
  //      agent's own logged calls, knocks and notes (its docblock records that
  //      `getAgentActivities` had no caller and no nav entry, and test:orphan-routes
  //      listed it as an orphan on that basis).
  //
  //    Pointing the tile at the page that was built for it resolves both. The
  //    label is now "Activity" rather than "Log Activity": the destination is the
  //    HISTORY, and the logging verbs live on the field surfaces
  //    (field-quick-actions / contact-command-strip → `logActivity`).
  //
  //    THE OTHER TWO, RESOLVED (dangling-link sweep, 2026-08-29). The earlier pass
  //    left `/mobile/directions` and `/mobile/notes/new` standing because neither
  //    had "an existing surface that obviously IS them". Both do — they are
  //    CAPABILITIES ON A PAGE rather than pages, and both live on /mobile/assistant:
  //
  //    · DIRECTIONS is `handleGetDirections` (window.open of maps.google.com), wired
  //      per-stop in showing-day-panel.tsx:69, open-house-panel.tsx:156 and
  //      tour-day-panel.tsx:76 — all three rendered by app/mobile/assistant/page.tsx.
  //      There is no address-less directions screen to build: the tile means "get me
  //      to my next stop", so it lands on Today's Schedule where the stops are.
  //    · QUICK NOTE is the note box in field-quick-actions.tsx:98 (`logActivity`
  //      with activityType "note"), also rendered by /mobile/assistant.
  //
  //    Both use a fragment so the tap lands on the right block, not the top of the
  //    page; the ids are on app/mobile/assistant/page.tsx.
  const secondaryActions = [
    { icon: MapPin, label: "Directions", href: "/mobile/assistant#todays-schedule" },
    { icon: Clock, label: "Activity", href: "/mobile/activity" },
    { icon: FileText, label: "Quick Note", href: "/mobile/assistant#quick-note" },
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

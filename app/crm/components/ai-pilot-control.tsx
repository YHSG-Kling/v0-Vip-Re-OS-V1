"use client"

/**
 * AIPilotControl — single segmented control for a contact's AI engagement
 * level. Replaces the old split between "AI Follow-up" boolean toggle and
 * "AI Autopilot" dropdown which never shared state.
 *
 * Persists via setContactAIPilot() which writes both
 * `contacts.ai_autopilot_level` and the legacy `ai_isa_enabled` boolean.
 */

import { useState, useTransition } from "react"
import { setContactAIPilot, type AIPilotLevel } from "@/app/actions/contact-intelligence"
import { Button } from "@/components/ui/button"
import { Sparkles, Loader2, Check } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { toast } from "sonner"

const LEVEL_LABELS: Record<AIPilotLevel, string> = {
  off:          "Off",
  conservative: "Conservative",
  moderate:     "Moderate",
  aggressive:   "Aggressive",
}

const LEVEL_DESCRIPTIONS: Record<AIPilotLevel, string> = {
  off:          "No AI activity for this contact",
  conservative: "Light cadence — you approve every send",
  moderate:     "Standard nurture + AI reply drafts",
  aggressive:   "Full autopilot — AI calls, texts, follow-ups",
}

const LEVEL_COLORS: Record<AIPilotLevel, string> = {
  off:          "bg-muted text-muted-foreground border-border",
  conservative: "bg-blue-50 text-blue-700 border-blue-200",
  moderate:     "bg-emerald-50 text-emerald-700 border-emerald-200",
  aggressive:   "bg-purple-50 text-purple-700 border-purple-200",
}

interface Props {
  contactId: string
  /** Initial level from the DB */
  initialLevel: AIPilotLevel | null | undefined
  /** Optional callback after a successful change */
  onChange?: (level: AIPilotLevel) => void
  /** Compact (icon-only label collapsed) */
  compact?: boolean
}

export function AIPilotControl({ contactId, initialLevel, onChange, compact }: Props) {
  const [level, setLevel] = useState<AIPilotLevel>(initialLevel ?? "off")
  const [isPending, startTransition] = useTransition()

  function handleSelect(next: AIPilotLevel) {
    if (next === level) return
    startTransition(async () => {
      const result = await setContactAIPilot({ contactId, level: next })
      if (result.success) {
        setLevel(next)
        onChange?.(next)
        toast.success(`AI Pilot: ${LEVEL_LABELS[next]}`)
      } else {
        toast.error(result.error ?? "Failed to update AI Pilot")
      }
    })
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          className={cn(
            "gap-1.5 text-xs h-8 border",
            LEVEL_COLORS[level],
            isPending && "opacity-70"
          )}
          disabled={isPending}
        >
          {isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
          {compact ? (
            <span>AI: {LEVEL_LABELS[level]}</span>
          ) : (
            <span>AI Pilot: {LEVEL_LABELS[level]}</span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {(Object.keys(LEVEL_LABELS) as AIPilotLevel[]).map((l) => (
          <DropdownMenuItem
            key={l}
            onClick={() => handleSelect(l)}
            className="flex items-start gap-2 py-2"
          >
            <div className="w-4 pt-0.5 shrink-0">
              {l === level && <Check className="h-3.5 w-3.5 text-primary" />}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">{LEVEL_LABELS[l]}</p>
              <p className="text-xs text-muted-foreground">{LEVEL_DESCRIPTIONS[l]}</p>
            </div>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

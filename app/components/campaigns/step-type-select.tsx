"use client"

/**
 * app/components/campaigns/step-type-select.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ONE STEP PICKER, rendered from lib/workflow/step-palette.ts.
 *
 * Both campaign builders used to keep their own list — 8 types in the workflow
 * builder, 7 channels in the sequence builder, 12 distinct out of the 23 the
 * executor dispatches. They edit the SAME rows, so a step built in one was
 * invisible in the other, and eleven working adapters had no UI at all.
 *
 * This renders the shared spec, grouped by what a step DOES rather than by the
 * pretence that every step is a send: a "Produce an asset" step contacts nobody
 * and hands its output to a later step. That distinction is the owner's rule
 * about video ("video is delivered in a sms or email") applied to every step
 * shaped the same way.
 *
 * Flag-locked steps stay VISIBLE but disabled, with the reason shown — a broker
 * should be able to see what the platform can do and what it would take to turn
 * it on, rather than wonder why a capability they were sold is absent.
 */

import {
  Calendar, CheckSquare, Clock, FileText, GitBranch, Gift, Globe, Image as ImageIcon,
  Layers, Mail, Megaphone, MessageSquare, Newspaper, PenTool, Phone, PhoneCall,
  Route, Send, Share2, Tag, TrendingUp, UserMinus, Video, type LucideIcon,
} from "lucide-react"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select"
import { paletteByGroup, stepSpec } from "@/lib/workflow/step-palette"

/** icon NAME (a string in the spec, which is shared with server code) → component. */
const ICONS: Record<string, LucideIcon> = {
  Calendar, CheckSquare, Clock, FileText, GitBranch, Gift, Globe, Image: ImageIcon,
  Layers, Mail, Megaphone, MessageSquare, Newspaper, PenTool, Phone, PhoneCall,
  Route, Send, Share2, Tag, TrendingUp, UserMinus, Video,
}

export function stepIcon(channel: string): LucideIcon {
  const name = stepSpec(channel)?.icon
  return (name && ICONS[name]) || Layers
}

export interface StepTypeSelectProps {
  value: string
  onChange: (channel: string) => void
  /** Brokerage feature flags — a step whose flagKey is off renders disabled. */
  featureFlags?: Record<string, boolean>
  disabled?: boolean
  id?: string
}

export function StepTypeSelect({
  value,
  onChange,
  featureFlags = {},
  disabled,
  id,
}: StepTypeSelectProps) {
  return (
    <Select value={value || undefined} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={id}>
        <SelectValue placeholder="Choose what this step does…" />
      </SelectTrigger>
      <SelectContent className="max-h-[420px]">
        {paletteByGroup().map((group) => (
          <SelectGroup key={group.group}>
            <SelectLabel className="flex flex-col gap-0.5 py-2">
              <span>{group.label}</span>
              <span className="text-[10px] font-normal text-muted-foreground">{group.help}</span>
            </SelectLabel>
            {group.steps.map((s) => {
              const Icon = ICONS[s.icon] ?? Layers
              const locked = !!s.flagKey && !featureFlags[s.flagKey]
              return (
                <SelectItem key={s.channel} value={s.channel} disabled={locked}>
                  <span className="flex items-center gap-2">
                    <Icon className="h-3.5 w-3.5 shrink-0" />
                    {s.label}
                    {locked && (
                      <span className="ml-1 text-[10px] text-muted-foreground">
                        (Superadmin activation required)
                      </span>
                    )}
                  </span>
                </SelectItem>
              )
            })}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  )
}

/** The one-line "what happens when this runs", shown under the picker. */
export function StepTypeDescription({ channel }: { channel: string }) {
  const spec = stepSpec(channel)
  if (!spec) return null
  return <p className="text-xs text-muted-foreground">{spec.description}</p>
}

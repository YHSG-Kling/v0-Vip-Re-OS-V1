"use client"

import { useState, useTransition } from "react"
import { Bell, Mail, MessageSquare, Monitor, Info } from "lucide-react"
import { Card } from "@/app/components/ui/card"
import { Badge } from "@/app/components/ui/badge"
import { toast } from "sonner"
import { updateNotificationRules } from "@/app/actions/settings/update-notification-rules"
import type { NotificationRuleRow } from "@/lib/kernel"

// ─── Display metadata ────────────────────────────────────────────────────────

const EVENT_META: Record<string, { label: string; description: string }> = {
  new_lead: {
    label: "New Lead",
    description: "A new contact is captured via form, embed widget, or manual entry.",
  },
  offer_received: {
    label: "Offer Received",
    description: "A buyer submits an offer on one of your listings.",
  },
  contract_signed: {
    label: "Contract Signed",
    description: "All parties have signed — a transaction moves to Under Contract.",
  },
  ready_to_close: {
    label: "Ready to Close",
    description: "All closing checklist items are complete and CDA is approved.",
  },
  task_assigned: {
    label: "Task Assigned",
    description: "A task or checklist item is assigned to you.",
  },
  showing_scheduled: {
    label: "Showing Scheduled",
    description: "A showing is booked on one of your listings.",
  },
}

const CHANNEL_META: Record<string, { label: string; icon: React.ReactNode }> = {
  push: { label: "In-app", icon: <Monitor className="h-3.5 w-3.5" /> },
  email: { label: "Email", icon: <Mail className="h-3.5 w-3.5" /> },
  sms: { label: "SMS", icon: <MessageSquare className="h-3.5 w-3.5" /> },
}

const ROLE_LABELS: Record<string, string> = {
  agent: "Agent",
  broker: "Broker",
  admin: "Admin",
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  rules: NotificationRuleRow[]
  canEdit: boolean
}

// ─── Component ────────────────────────────────────────────────────────────────

export function NotificationRulesClient({ rules, canEdit }: Props) {
  const [localRules, setLocalRules] = useState<NotificationRuleRow[]>(rules)
  const [pending, startTransition] = useTransition()

  function toggle(rule: NotificationRuleRow) {
    if (!canEdit) return
    const newActive = !rule.is_active
    // Optimistic update
    setLocalRules((prev) =>
      prev.map((r) => (r.id === rule.id ? { ...r, is_active: newActive } : r)),
    )
    startTransition(async () => {
      try {
        await updateNotificationRules(rule.id, { is_active: newActive })
      } catch {
        // Roll back
        setLocalRules((prev) =>
          prev.map((r) => (r.id === rule.id ? { ...r, is_active: rule.is_active } : r)),
        )
        toast.error("Couldn't update notification rule")
      }
    })
  }

  if (localRules.length === 0) {
    return (
      <Card className="p-8 text-center">
        <Bell className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
        <p className="text-sm font-medium mb-1">No notification rules configured</p>
        <p className="text-xs text-muted-foreground max-w-sm mx-auto">
          {canEdit
            ? "Notification rules are set at the brokerage level. Create them in the kernel admin panel or contact support."
            : "Your brokerage hasn't configured notification rules yet. Contact your broker."}
        </p>
      </Card>
    )
  }

  // Group rules by trigger_event
  const grouped = localRules.reduce<Record<string, NotificationRuleRow[]>>((acc, r) => {
    const key = r.trigger_event
    if (!acc[key]) acc[key] = []
    acc[key].push(r)
    return acc
  }, {})

  return (
    <div className="space-y-4">
      {!canEdit && (
        <div className="flex items-start gap-2 rounded-md border bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
          <Info className="h-4 w-4 shrink-0 mt-0.5" />
          <span>
            These rules are managed by your broker. You can view which notifications you receive
            but cannot change them here.
          </span>
        </div>
      )}

      {Object.entries(grouped).map(([event, eventRules]) => {
        const meta = EVENT_META[event] ?? { label: event, description: "" }
        return (
          <Card key={event} className="p-4">
            <div className="mb-3">
              <p className="text-sm font-medium">{meta.label}</p>
              {meta.description && (
                <p className="text-xs text-muted-foreground mt-0.5">{meta.description}</p>
              )}
            </div>
            <div className="space-y-2.5">
              {eventRules.map((rule) => {
                const channelMeta = CHANNEL_META[rule.notification_type] ?? {
                  label: rule.notification_type,
                  icon: <Bell className="h-3.5 w-3.5" />,
                }
                return (
                  <div key={rule.id} className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      {channelMeta.icon}
                      <span>{channelMeta.label}</span>
                      <Badge variant="outline" className="text-xs">
                        {ROLE_LABELS[rule.recipient_role] ?? rule.recipient_role}
                      </Badge>
                    </div>
                    <Toggle
                      checked={rule.is_active}
                      disabled={!canEdit || pending}
                      onChange={() => toggle(rule)}
                    />
                  </div>
                )
              })}
            </div>
          </Card>
        )
      })}
    </div>
  )
}

// ─── Inline toggle (avoids shadcn Switch which requires extra setup) ──────────

function Toggle({
  checked, disabled, onChange,
}: {
  checked: boolean
  disabled?: boolean
  onChange: () => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={onChange}
      className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
        disabled:opacity-50 disabled:cursor-not-allowed
        ${checked ? "bg-primary" : "bg-input"}`}
    >
      <span
        className={`pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform
          ${checked ? "translate-x-4" : "translate-x-0"}`}
      />
    </button>
  )
}

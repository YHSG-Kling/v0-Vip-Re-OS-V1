"use client"

import { useState } from "react"
import { createClient } from "@/lib/supabase/client"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import { Bot, Loader2, AlertTriangle, Phone } from "lucide-react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { toast } from "sonner"

interface IsaSettings {
  isa_auto_respond_new_leads: boolean
  isa_auto_respond_ghost_threshold_days: number
  isa_require_admin_approval_before_send: boolean
  isa_auto_respond_hours: string
}

const DEFAULTS: IsaSettings = {
  isa_auto_respond_new_leads: false,
  isa_auto_respond_ghost_threshold_days: 14,
  isa_require_admin_approval_before_send: true,
  isa_auto_respond_hours: "8-20",
}

interface IsaAutoRespondSettingsProps {
  brokerageId: string
  currentSettings: Partial<IsaSettings>
  // existing additional_settings JSONB to merge into on save
  existingAdditionalSettings: Record<string, unknown>
}

export function IsaAutoRespondSettings({
  brokerageId,
  currentSettings,
  existingAdditionalSettings,
}: IsaAutoRespondSettingsProps) {
  const merged: IsaSettings = { ...DEFAULTS, ...currentSettings }
  const [settings, setSettings] = useState<IsaSettings>(merged)
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    setSaving(true)
    try {
      const supabase = createClient()
      const newAdditionalSettings = {
        ...existingAdditionalSettings,
        isa_auto_respond_new_leads: settings.isa_auto_respond_new_leads,
        isa_auto_respond_ghost_threshold_days: settings.isa_auto_respond_ghost_threshold_days,
        isa_require_admin_approval_before_send: settings.isa_require_admin_approval_before_send,
        isa_auto_respond_hours: settings.isa_auto_respond_hours,
      }

      const { error } = await supabase
        .from("global_settings")
        .update({ additional_settings: newAdditionalSettings })
        .eq("brokerage_id", brokerageId)

      if (error) {
        toast.error("Failed to save ISA settings: " + error.message)
      } else {
        toast.success("ISA auto-respond settings saved")
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Bot className="h-5 w-5 text-primary" />
          <CardTitle className="text-base">AI-ISA Auto-Response Settings</CardTitle>
        </div>
        <CardDescription>
          Control when and how the AI Inside Sales Agent responds automatically
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">

        {/* Toggle 1: Auto-respond to new leads */}
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-0.5">
            <Label className="text-sm font-medium">Auto-respond to new incoming leads</Label>
            <p className="text-xs text-muted-foreground">
              AI-ISA responds within 5 minutes to every new lead
            </p>
            {settings.isa_auto_respond_new_leads && (
              <div className="flex items-center gap-1.5 mt-1">
                <AlertTriangle className="h-3 w-3 text-amber-500 shrink-0" />
                <p className="text-xs text-amber-600">
                  Only enable if your team is not monitoring leads 24/7
                </p>
              </div>
            )}
          </div>
          <Switch
            checked={settings.isa_auto_respond_new_leads}
            onCheckedChange={(v) =>
              setSettings((s) => ({ ...s, isa_auto_respond_new_leads: v }))
            }
          />
        </div>

        {/* Toggle 2: Require approval — only visible when auto-respond enabled */}
        {settings.isa_auto_respond_new_leads && (
          <>
            <Separator />
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-0.5">
                <Label className="text-sm font-medium">Require admin approval before sending</Label>
                <p className="text-xs text-muted-foreground">
                  AI drafts responses but you approve before they send
                </p>
              </div>
              <Switch
                checked={settings.isa_require_admin_approval_before_send}
                onCheckedChange={(v) =>
                  setSettings((s) => ({ ...s, isa_require_admin_approval_before_send: v }))
                }
              />
            </div>
          </>
        )}

        <Separator />

        {/* Ghost threshold */}
        <div className="space-y-1.5">
          <Label htmlFor="ghost-threshold" className="text-sm font-medium">
            Ghost re-engagement threshold (days)
          </Label>
          <Input
            id="ghost-threshold"
            type="number"
            min={1}
            max={365}
            value={settings.isa_auto_respond_ghost_threshold_days}
            onChange={(e) =>
              setSettings((s) => ({
                ...s,
                isa_auto_respond_ghost_threshold_days: Math.max(1, parseInt(e.target.value) || 14),
              }))
            }
            className="max-w-[120px]"
          />
          <p className="text-xs text-muted-foreground">
            How many days of inactivity before AI tries to re-engage
          </p>
        </div>

        {/* Auto-respond hours */}
        <div className="space-y-1.5">
          <Label htmlFor="respond-hours" className="text-sm font-medium">
            Auto-respond hours
          </Label>
          <Input
            id="respond-hours"
            type="text"
            placeholder="8-20"
            value={settings.isa_auto_respond_hours}
            onChange={(e) =>
              setSettings((s) => ({ ...s, isa_auto_respond_hours: e.target.value }))
            }
            className="max-w-[120px]"
          />
          <p className="text-xs text-muted-foreground">
            Hours during which AI can auto-respond (24h format, e.g. &quot;8-20&quot;)
          </p>
        </div>

        <Separator />

        {/* Voice — a statement, not a choice. There is one voice engine, and the
            clone is per-agent: the owner rule is that each user sets up their
            own, with no fallback to a brokerage voice. The control that used to
            live here offered a retired vendor as an equal option and nothing in
            app/ or lib/ ever read the answer to route a call. */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Phone className="h-4 w-4 text-muted-foreground" />
            <Label className="text-sm font-medium">AI Calling Voice</Label>
          </div>
          <p className="text-xs text-muted-foreground">
            AI ISA calls speak in your own ElevenLabs voice clone. Set it up at{" "}
            <a href="/dashboard/settings/twin-studio" className="underline underline-offset-2">
              Settings → Voice &amp; Avatar
            </a>
            . Until your clone exists, the ISA will not place calls as you — there
            is deliberately no shared brokerage voice to fall back to.
          </p>
        </div>

        <Button onClick={handleSave} disabled={saving} className="w-full sm:w-auto">
          {saving ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Saving...
            </>
          ) : (
            "Save Settings"
          )}
        </Button>
      </CardContent>
    </Card>
  )
}

"use client"

/**
 * VOICE ASSISTANT ACCESS — the management toggle card (owner: "voice assistant
 * should be able to expand to staff if management wants").
 *
 * The principal flips per-role switches to expand the voice assistant surface
 * beyond its principal/agent default. Saves through the gated server action
 * (management-only, sanitized allowlist, merge-preserving jsonb write into
 * global_settings.additional_settings). Expansion is SURFACE access only —
 * each role keeps exactly the voice intents its own role gates permit.
 */

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Mic, Loader2 } from "lucide-react"
import { toast } from "sonner"
import {
  getVoiceAccessSettings,
  setVoiceAssistantExpandedRoles,
} from "@/app/actions/voice-access"

const ROLE_LABELS: Record<string, string> = {
  tc: "Transaction Coordinator (tc)",
  transaction_coordinator: "Transaction Coordinator",
  compliance_officer: "Compliance Officer",
  isa: "Inside Sales Agent (ISA)",
  team_lead: "Team Lead",
  lender: "Lender",
  title_agent: "Title Agent",
}

export function VoiceAccessSettings() {
  const [expandable, setExpandable] = useState<string[]>([])
  const [enabled, setEnabled] = useState<Set<string>>(new Set())
  const [loaded, setLoaded] = useState(false)
  const [visible, setVisible] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    getVoiceAccessSettings()
      .then((r) => {
        if (r.success) {
          setExpandable(r.settings.expandableRoles)
          setEnabled(new Set(r.settings.expandedRoles))
          setLoaded(true)
        } else {
          setVisible(false) // not management — the card stays out of the way
        }
      })
      .catch(() => setVisible(false))
  }, [])

  if (!visible) return null

  const toggle = (role: string, on: boolean) => {
    setEnabled((prev) => {
      const next = new Set(prev)
      if (on) next.add(role)
      else next.delete(role)
      return next
    })
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const r = await setVoiceAssistantExpandedRoles([...enabled])
      if (r.success) {
        toast.success("Voice assistant access saved")
        if (r.expandedRoles) setEnabled(new Set(r.expandedRoles))
      } else {
        toast.error(r.error ?? "Could not save voice access settings")
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Mic className="h-4 w-4 text-purple-600" />
          Voice Assistant Access
        </CardTitle>
        <CardDescription>
          Agents and management always have the voice assistant. Enable it for
          additional staff roles — each role only gets the voice actions its
          own permissions already allow.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!loaded ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : (
          <>
            {expandable.map((role) => (
              <div key={role} className="flex items-center justify-between gap-3">
                <Label htmlFor={`voice-role-${role}`} className="text-sm font-normal">
                  {ROLE_LABELS[role] ?? role}
                </Label>
                <Switch
                  id={`voice-role-${role}`}
                  checked={enabled.has(role)}
                  onCheckedChange={(on) => toggle(role, on)}
                />
              </div>
            ))}
            <div className="pt-1">
              <Button size="sm" onClick={handleSave} disabled={saving}>
                {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                Save voice access
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

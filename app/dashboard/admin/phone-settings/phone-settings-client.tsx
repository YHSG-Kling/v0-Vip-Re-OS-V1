"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Phone, Volume2, CheckCircle2, AlertCircle, Loader2 } from "lucide-react"
import { A2pRegistrationCard } from "./a2p-card"
import {
  updateBrokeragePhoneSettings,
  type BrokeragePhoneSettings,
} from "@/app/actions/phone-provisioning"
import type { GenericVoiceOption } from "@/lib/voice/voice-resolver"

interface Props {
  initialSettings: BrokeragePhoneSettings
  genericVoices: GenericVoiceOption[]
}

export function PhoneSettingsClient({ initialSettings, genericVoices }: Props) {
  const [settings, setSettings] = useState(initialSettings)
  const [previewLoading, setPreviewLoading] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  async function handleAutoProvisionToggle(value: boolean) {
    setError(null); setSaved(false)
    startTransition(async () => {
      const result = await updateBrokeragePhoneSettings({ autoProvisionPhoneNumbers: value })
      if (result.success) {
        setSettings({ ...settings, autoProvisionPhoneNumbers: value })
        setSaved(true)
        setTimeout(() => setSaved(false), 2500)
      } else {
        setError(result.error ?? "Save failed")
      }
    })
  }

  async function handleVoiceChoice(voiceId: string | null) {
    setError(null); setSaved(false)
    startTransition(async () => {
      const result = await updateBrokeragePhoneSettings({ defaultIsaVoiceId: voiceId })
      if (result.success) {
        setSettings({ ...settings, defaultIsaVoiceId: voiceId })
        setSaved(true)
        setTimeout(() => setSaved(false), 2500)
      } else {
        setError(result.error ?? "Save failed")
      }
    })
  }

  async function previewVoice(voiceId: string) {
    setPreviewLoading(voiceId)
    try {
      const res = await fetch("/api/internal/voice-tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "Hi, this is your AI assistant. I'm calling to follow up on your home search.",
        }),
      })
      if (res.ok) {
        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        new Audio(url).play().finally(() => setTimeout(() => URL.revokeObjectURL(url), 5000))
      }
    } finally {
      setPreviewLoading(null)
    }
  }

  return (
    <div className="p-6 space-y-6 max-w-4xl mx-auto">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Phone className="h-6 w-6 text-blue-600" />
            Phone & ISA Voice
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Configure how your brokerage provisions phone numbers for agents and which voice
            the AI ISA uses when no agent voice clone is available.
          </p>
        </div>
        {saved && (
          <Badge variant="outline" className="border-green-200 bg-green-50 text-green-700">
            <CheckCircle2 className="h-3 w-3 mr-1" />
            Saved
          </Badge>
        )}
      </div>

      {/* Auto-provision toggle */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Auto-Provision Phone Numbers</CardTitle>
          <CardDescription className="text-xs">
            When ON, a new Twilio number is automatically purchased for each new agent in their
            preferred area code. When OFF, agents (or you) manually add a number from their
            settings using the "Add Number" button.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-center justify-between">
          <div className="text-sm">
            <p className="font-medium">
              {settings.autoProvisionPhoneNumbers ? "Auto-provisioning is ON" : "Auto-provisioning is OFF"}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {settings.autoProvisionPhoneNumbers
                ? "~$1.15/mo per number, billed to brokerage. Agents get a number on signup."
                : "Each agent must add their own number manually. Bring your own (BYO) Twilio numbers supported."}
            </p>
          </div>
          <Switch
            checked={settings.autoProvisionPhoneNumbers}
            disabled={isPending}
            onCheckedChange={handleAutoProvisionToggle}
          />
        </CardContent>
      </Card>

      {/* Default ISA voice */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Volume2 className="h-4 w-4 text-purple-600" />
            Default ISA Voice
          </CardTitle>
          <CardDescription className="text-xs">
            Voice used when AI ISA calls a lead who isn't yet assigned to an agent (so no agent
            clone is available). Agents' own cloned voices override this when they call their
            assigned contacts.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {genericVoices.map((v) => {
              const isSelected = settings.defaultIsaVoiceId === v.id
              return (
                <div
                  key={v.id}
                  className={`p-2 rounded border-2 text-xs transition-colors ${
                    isSelected ? "border-purple-500 bg-purple-50" : "border-border"
                  }`}
                >
                  <button
                    onClick={() => handleVoiceChoice(v.id)}
                    disabled={isPending}
                    className="w-full text-left"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{v.name}</span>
                      <span className="text-[10px] text-muted-foreground capitalize">{v.gender}</span>
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">{v.description}</p>
                  </button>
                  {isSelected && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full mt-2 h-6 text-xs gap-1.5"
                      onClick={() => previewVoice(v.id)}
                      disabled={previewLoading !== null}
                    >
                      {previewLoading === v.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Volume2 className="h-3 w-3" />
                      )}
                      Preview
                    </Button>
                  )}
                </div>
              )
            })}
          </div>
          {settings.defaultIsaVoiceId && (
            <Button
              size="sm"
              variant="ghost"
              className="text-xs mt-3"
              onClick={() => handleVoiceChoice(null)}
              disabled={isPending}
            >
              Clear (use VAPI default)
            </Button>
          )}
        </CardContent>
      </Card>

      {error && (
        <p className="text-sm text-red-600 flex items-center gap-2">
          <AlertCircle className="h-4 w-4" />
          {error}
        </p>
      )}

      {/* Carrier registration — the platform files A2P 10DLC for the tenant */}
      <A2pRegistrationCard />

      {/* Compliance note */}
      <Card className="bg-amber-50/50 border-amber-200">
        <CardContent className="p-4 text-xs text-amber-900 space-y-1">
          <p className="font-medium">Compliance enforced automatically on every outbound call:</p>
          <ul className="list-disc pl-5 space-y-0.5">
            <li><strong>TCPA quiet hours:</strong> calls only placed 8am–9pm in recipient's local time (resolved from area code)</li>
            <li><strong>Recording disclosure:</strong> "this call may be recorded" prepended to the assistant's first message (covers all 12 two-party-consent states + safer in 1-party states)</li>
            <li><strong>DNC + opt-out gates:</strong> contacts on DNC or with `call_stop_flag` are auto-skipped</li>
            <li><strong>STIR/SHAKEN:</strong> handled by Twilio when numbers are properly attested</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}

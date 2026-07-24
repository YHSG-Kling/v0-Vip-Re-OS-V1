"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Phone, Volume2, CheckCircle2, AlertCircle, Loader2, Plus, Search, Mic } from "lucide-react"
import { A2pRegistrationCard } from "./a2p-card"
import { VoiceRecorder } from "@/app/dashboard/settings/twin-studio/components/voice-recorder"
import { uploadTwinVoiceSample } from "@/app/actions/twin-studio-upload"
import {
  updateBrokeragePhoneSettings,
  getPhoneAllowanceStatusAction,
  searchBrokerageNumbersAction,
  purchaseBrokerageNumberAction,
  type BrokeragePhoneSettings,
  type PhoneAllowanceStatus,
  type NumberCandidateView,
} from "@/app/actions/phone-provisioning"
import type { GenericVoiceOption } from "@/lib/voice/voice-resolver"

interface Props {
  initialSettings: BrokeragePhoneSettings
  genericVoices: GenericVoiceOption[]
  allowanceStatus: PhoneAllowanceStatus | null
}

export function PhoneSettingsClient({ initialSettings, genericVoices, allowanceStatus }: Props) {
  const [settings, setSettings] = useState(initialSettings)
  const [previewLoading, setPreviewLoading] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  // ── Add-a-Number state ──
  const [allowance, setAllowance] = useState<PhoneAllowanceStatus | null>(allowanceStatus)
  const [areaCode, setAreaCode] = useState("")
  const [candidates, setCandidates] = useState<NumberCandidateView[]>([])
  const [searching, setSearching] = useState(false)
  const [buying, setBuying] = useState<string | null>(null)
  const [addNoteOk, setAddNoteOk] = useState<string | null>(null)
  const [addError, setAddError] = useState<string | null>(null)

  const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`

  async function handleSearchNumbers() {
    setAddError(null); setAddNoteOk(null); setSearching(true); setCandidates([])
    try {
      const res = await searchBrokerageNumbersAction({ areaCode: areaCode.trim() || undefined })
      if (res.success) {
        setCandidates(res.candidates)
        if (res.candidates.length === 0) setAddError("No numbers found for that area code — try another.")
      } else {
        setAddError(
          res.notConfigured
            ? "Telephony isn't connected for your brokerage yet. Once your carrier is set up, you can search and buy numbers here."
            : res.error,
        )
      }
    } finally {
      setSearching(false)
    }
  }

  async function handleBuyNumber(phoneNumber: string) {
    setAddError(null); setAddNoteOk(null); setBuying(phoneNumber)
    try {
      const res = await purchaseBrokerageNumberAction({ phoneNumber })
      if (res.success) {
        setAddNoteOk(
          `${res.phoneNumber} added${res.billing === "overage" ? ` (+${dollars(res.monthlyOverageCents)}/mo overage)` : " — included in your plan"}.`,
        )
        setCandidates((cs) => cs.filter((c) => c.phoneNumber !== phoneNumber))
        const refreshed = await getPhoneAllowanceStatusAction()
        if (refreshed.success) setAllowance(refreshed.status)
      } else {
        setAddError(res.error)
      }
    } finally {
      setBuying(null)
    }
  }

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

  // ── Record a custom ISA voice (clone) ──
  const [recording, setRecording] = useState(false)
  const [cloning, setCloning] = useState(false)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const [voiceNote, setVoiceNote] = useState<string | null>(null)

  function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onloadend = () => resolve(String(reader.result).split(",")[1] ?? "")
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
  }

  async function handleVoiceSample(blob: Blob, mimeType: string) {
    setVoiceError(null); setVoiceNote(null); setCloning(true)
    try {
      // 1. Upload the recorded sample to the Supabase voice bucket.
      const base64 = await blobToBase64(blob)
      const up = await uploadTwinVoiceSample({ base64, mimeType })
      if (!up.ok || !up.url) { setVoiceError(up.error ?? "Upload failed"); return }

      // 2. Clone via ElevenLabs and save it as the brokerage's default ISA voice.
      const res = await fetch("/api/elevenlabs/voice-clone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Custom ISA Voice", sample_audio_urls: [up.url], isa_default: true }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setVoiceError(
          res.status === 503
            ? "Voice cloning isn't available yet (ElevenLabs isn't configured for the platform)."
            : (data?.error ?? "Voice clone failed"),
        )
        return
      }
      setSettings((s) => ({ ...s, defaultIsaVoiceId: data.elevenlabs_voice_id }))
      setRecording(false)
      setVoiceNote("Your recorded voice is now the default ISA voice.")
    } finally {
      setCloning(false)
    }
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

      {/* Add a Number — search + purchase, gated by the plan allowance */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Plus className="h-4 w-4 text-blue-600" />
            Add a Number
          </CardTitle>
          <CardDescription className="text-xs">
            Search available numbers by area code and add one to your brokerage. Numbers inside
            your plan are included; beyond that they're metered overage.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {allowance && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge variant="outline">
                {allowance.activeNumbers} of {allowance.includedNumbers} included in use
              </Badge>
              {allowance.maxNumbers !== null && (
                <Badge variant="outline">Plan cap: {allowance.maxNumbers}</Badge>
              )}
              <Badge
                variant="outline"
                className={
                  allowance.nextBilling === "overage"
                    ? "border-amber-200 bg-amber-50 text-amber-800"
                    : "border-green-200 bg-green-50 text-green-700"
                }
              >
                {allowance.nextBilling === "overage"
                  ? `Next number: +${dollars(allowance.nextMonthlyOverageCents)}/mo`
                  : "Next number: included"}
              </Badge>
            </div>
          )}

          {allowance && !allowance.canAddNumber ? (
            <p className="text-sm text-amber-700 flex items-center gap-2">
              <AlertCircle className="h-4 w-4" />
              {allowance.capReason ?? "Your plan's number limit has been reached."}
            </p>
          ) : (
            <>
              <div className="flex items-end gap-2">
                <div className="space-y-1.5">
                  <Label htmlFor="areaCode" className="text-xs">Area code (optional)</Label>
                  <Input
                    id="areaCode"
                    value={areaCode}
                    onChange={(e) => setAreaCode(e.target.value.replace(/\D/g, "").slice(0, 3))}
                    placeholder="e.g. 305"
                    className="w-32"
                  />
                </div>
                <Button onClick={handleSearchNumbers} disabled={searching} variant="outline" className="gap-1.5">
                  {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                  Search
                </Button>
              </div>

              {candidates.length > 0 && (
                <div className="divide-y rounded-md border">
                  {candidates.map((c) => (
                    <div key={c.phoneNumber} className="flex items-center justify-between p-2.5 text-sm">
                      <div>
                        <span className="font-medium">{c.phoneNumber}</span>
                        {(c.locality || c.region) && (
                          <span className="text-xs text-muted-foreground ml-2">
                            {[c.locality, c.region].filter(Boolean).join(", ")}
                          </span>
                        )}
                      </div>
                      <Button
                        size="sm"
                        onClick={() => handleBuyNumber(c.phoneNumber)}
                        disabled={buying !== null}
                        className="h-7 gap-1.5"
                      >
                        {buying === c.phoneNumber ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
                        Add
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {addNoteOk && (
            <p className="text-sm text-green-700 flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4" />
              {addNoteOk}
            </p>
          )}
          {addError && (
            <p className="text-sm text-red-600 flex items-center gap-2">
              <AlertCircle className="h-4 w-4" />
              {addError}
            </p>
          )}
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

          {/* Record a custom voice → clone → set as ISA voice */}
          <div className="mt-4 border-t pt-4">
            {!recording ? (
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => { setRecording(true); setVoiceError(null); setVoiceNote(null) }}>
                <Mic className="h-4 w-4" />
                Record a custom voice
              </Button>
            ) : (
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  Record ~30 seconds of clear speech. We’ll create a private voice clone (via
                  ElevenLabs) and use it as your ISA voice.
                </p>
                {cloning ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" /> Creating your voice clone…
                  </div>
                ) : (
                  <VoiceRecorder onSampleReady={handleVoiceSample} />
                )}
                <Button size="sm" variant="ghost" className="text-xs" onClick={() => setRecording(false)} disabled={cloning}>
                  Cancel
                </Button>
              </div>
            )}
            {voiceNote && (
              <p className="text-sm text-green-700 flex items-center gap-2 mt-2">
                <CheckCircle2 className="h-4 w-4" /> {voiceNote}
              </p>
            )}
            {voiceError && (
              <p className="text-sm text-red-600 flex items-center gap-2 mt-2">
                <AlertCircle className="h-4 w-4" /> {voiceError}
              </p>
            )}
          </div>
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

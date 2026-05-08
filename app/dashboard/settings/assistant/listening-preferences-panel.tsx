"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Loader2, CheckCircle2, AlertCircle, Volume2, User, Sparkles } from "lucide-react"
import {
  updateMyVoicePreference,
  updateMyProspectVoice,
  type AgentVoiceAvatarPrefs,
} from "@/app/actions/voice-avatar-settings"
import type { GenericVoiceOption } from "@/lib/voice/voice-resolver"

interface Props {
  initialPrefs: AgentVoiceAvatarPrefs
  genericVoices: GenericVoiceOption[]
}

export function ListeningPreferencesPanel({ initialPrefs, genericVoices }: Props) {
  const [prefs, setPrefs] = useState(initialPrefs)
  const [previewLoading, setPreviewLoading] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [isPending, startTransition] = useTransition()

  function handleChoosePreference(pref: "clone" | "generic", voiceId?: string | null) {
    setSaveError(null)
    setSaved(false)
    startTransition(async () => {
      const result = await updateMyVoicePreference({
        preference: pref,
        assistantVoiceId: pref === "generic" ? voiceId ?? prefs.assistantVoiceId : null,
      })
      if (result.success) {
        setPrefs({
          ...prefs,
          voicePreference: pref,
          assistantVoiceId: pref === "generic" ? voiceId ?? prefs.assistantVoiceId : null,
        })
        setSaved(true)
        setTimeout(() => setSaved(false), 2500)
      } else {
        setSaveError(result.error ?? "Save failed")
      }
    })
  }

  function handleChooseProspectVoice(voiceId: string) {
    setSaveError(null)
    setSaved(false)
    // The prospect voice MUST differ from the agent's own clone so practice
    // feels like a real call.
    if (prefs.voiceId && voiceId === prefs.voiceId) {
      setSaveError("Pick a different voice from your own clone — practice prospects shouldn't sound like you.")
      return
    }
    startTransition(async () => {
      const result = await updateMyProspectVoice({ prospectVoiceId: voiceId })
      if (result.success) {
        setPrefs({ ...prefs, prospectVoiceId: voiceId })
        setSaved(true)
        setTimeout(() => setSaved(false), 2500)
      } else {
        setSaveError(result.error ?? "Save failed")
      }
    })
  }

  async function previewVoice(voiceId: string) {
    setPreviewLoading(voiceId)
    try {
      const res = await fetch("/api/internal/voice-tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Good morning. Here's your focus for today." }),
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
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Volume2 className="h-4 w-4 text-purple-600" />
              How YOU hear your assistant
            </CardTitle>
            <CardDescription className="text-xs mt-1">
              This controls the voice you hear in your morning brief and AI assistant.
              It does NOT change what your contacts hear — they always hear your cloned voice.
            </CardDescription>
          </div>
          {saved && (
            <Badge variant="outline" className="border-green-200 bg-green-50 text-green-700 text-xs">
              <CheckCircle2 className="h-3 w-3 mr-1" />
              Saved
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Option 1: Clone */}
        <button
          onClick={() => handleChoosePreference("clone")}
          disabled={isPending || !prefs.cloneAvailable}
          className={`w-full text-left p-3 rounded-lg border-2 transition-colors ${
            prefs.voicePreference === "clone"
              ? "border-purple-500 bg-purple-50/50"
              : "border-border hover:bg-muted/50"
          } ${!prefs.cloneAvailable ? "opacity-50 cursor-not-allowed" : ""}`}
        >
          <div className="flex items-start gap-3">
            <div className="h-8 w-8 rounded-full bg-purple-100 flex items-center justify-center shrink-0">
              <Sparkles className="h-4 w-4 text-purple-600" />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <p className="font-medium text-sm">My own cloned voice</p>
                {prefs.voicePreference === "clone" && (
                  <Badge variant="default" className="text-xs h-5">Active</Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                {prefs.cloneAvailable
                  ? "Hear your assistant in your own voice. Most agents prefer this."
                  : "Record your voice clone below first to enable this option."}
              </p>
            </div>
          </div>
        </button>

        {/* Option 2: Generic */}
        <div
          className={`p-3 rounded-lg border-2 transition-colors ${
            prefs.voicePreference === "generic"
              ? "border-purple-500 bg-purple-50/50"
              : "border-border"
          }`}
        >
          <div className="flex items-start gap-3 mb-3">
            <div className="h-8 w-8 rounded-full bg-blue-100 flex items-center justify-center shrink-0">
              <User className="h-4 w-4 text-blue-600" />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <p className="font-medium text-sm">Pick a generic voice</p>
                {prefs.voicePreference === "generic" && (
                  <Badge variant="default" className="text-xs h-5">Active</Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                Some agents find it odd to hear themselves. Pick a professional voice instead.
              </p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 ml-11">
            {genericVoices.map((v) => {
              const isSelected = prefs.voicePreference === "generic" && prefs.assistantVoiceId === v.id
              return (
                <button
                  key={v.id}
                  onClick={() => handleChoosePreference("generic", v.id)}
                  disabled={isPending}
                  className={`text-left p-2 rounded border text-xs transition-colors ${
                    isSelected
                      ? "border-purple-400 bg-purple-50"
                      : "border-border hover:bg-muted"
                  }`}
                >
                  <div className="flex items-center justify-between gap-1">
                    <span className="font-medium">{v.name}</span>
                    <span className="text-[10px] text-muted-foreground capitalize">{v.gender}</span>
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-1">{v.description}</p>
                </button>
              )
            })}
          </div>
          {prefs.voicePreference === "generic" && prefs.assistantVoiceId && (
            <Button
              size="sm"
              variant="outline"
              className="ml-11 mt-2 h-7 text-xs gap-1.5"
              onClick={() => previewVoice(prefs.assistantVoiceId!)}
              disabled={previewLoading !== null}
            >
              {previewLoading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Volume2 className="h-3 w-3" />
              )}
              Preview
            </Button>
          )}
        </div>

        {saveError && (
          <p className="text-xs text-red-600 flex items-center gap-1">
            <AlertCircle className="h-3 w-3" />
            {saveError}
          </p>
        )}

        <p className="text-[11px] text-muted-foreground border-t pt-2 mt-2">
          <strong>Note:</strong> Your contacts always hear your cloned voice when they interact
          with you through the portal AI chat or AI ISA — that's how they recognize you. This
          setting only affects what YOU hear when YOU talk to your assistant or play your brief.
        </p>

        {/* Practice prospect voice — Track C */}
        <div className="border-t pt-4 mt-4 space-y-2">
          <div className="flex items-start gap-2">
            <Sparkles className="h-4 w-4 text-purple-600 mt-0.5 shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-medium">Practice prospect voice</p>
              <p className="text-xs text-muted-foreground">
                The voice the AI uses when role-playing a prospect during objection training.
                Pick something different from your own voice so practice feels real.
              </p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-1.5 ml-6">
            {genericVoices.map((v) => {
              const isSelected = prefs.prospectVoiceId === v.id
              const isOwnClone = prefs.voiceId === v.id
              return (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => handleChooseProspectVoice(v.id)}
                  disabled={isPending || isOwnClone}
                  className={`text-left p-2 rounded border text-xs transition-colors ${
                    isSelected
                      ? "border-purple-400 bg-purple-50"
                      : "border-border hover:bg-muted"
                  } ${isOwnClone ? "opacity-40 cursor-not-allowed" : ""}`}
                >
                  <div className="flex items-center justify-between gap-1">
                    <span className="font-medium">{v.name}</span>
                    <span className="text-[10px] text-muted-foreground capitalize">{v.gender}</span>
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-1">
                    {isOwnClone ? "Your own voice — pick another" : v.description}
                  </p>
                </button>
              )
            })}
          </div>
          {prefs.prospectVoiceId && (
            <Button
              size="sm"
              variant="outline"
              className="ml-6 mt-2 h-7 text-xs gap-1.5"
              onClick={() => previewVoice(prefs.prospectVoiceId!)}
              disabled={previewLoading !== null}
            >
              {previewLoading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Volume2 className="h-3 w-3" />
              )}
              Preview
            </Button>
          )}
          {!prefs.prospectVoiceId && (
            <p className="text-[11px] text-muted-foreground ml-6 italic">
              Not picked yet — practice falls back to a platform default until you choose.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

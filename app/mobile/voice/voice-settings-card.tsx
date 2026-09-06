"use client"

// Voice assistant settings (lane E2 2026-08-28: getVoiceConfig +
// updateVoiceConfig WIRED). The page's status card told agents to "set up
// your voice profile in settings" — and no settings surface existed anywhere:
// voice_assistant_config had live READERS (this page's Configured badge,
// lib/voice/voice-resolver.ts, lib/intelligence/appointment-whisper.ts,
// lib/video/video-identity.ts) and no reachable writer. Opening this card
// bootstraps the default config row (getVoiceConfig creates it when missing)
// and Save is the writer. Identity is the SESSION's inside both actions.

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Loader2, Settings2 } from "lucide-react"
import { getVoiceConfig, updateVoiceConfig } from "@/app/actions/voice-assistant"

export function VoiceSettingsCard() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedNote, setSavedNote] = useState<string | null>(null)
  const [wakeWord, setWakeWord] = useState("hey assistant")
  const [autoBriefing, setAutoBriefing] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const res = await getVoiceConfig()
      if (cancelled) return
      setLoading(false)
      if ((res as any).success && (res as any).config) {
        const cfg = (res as any).config
        setWakeWord(cfg.wake_word ?? "hey assistant")
        setAutoBriefing(!!cfg.auto_briefing)
      } else {
        setError((res as any).error ?? "Could not load voice settings")
      }
    })()
    return () => { cancelled = true }
  }, [])

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    setSavedNote(null)
    const res = await updateVoiceConfig(undefined, {
      wake_word: wakeWord.trim() || "hey assistant",
      auto_briefing: autoBriefing,
    })
    setSaving(false)
    if ((res as any).success) {
      setSavedNote("Saved")
    } else {
      setError((res as any).error ?? "Could not save voice settings")
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Settings2 className="h-4 w-4" /> Voice Settings
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading settings…
          </div>
        ) : (
          <>
            <div className="space-y-1">
              <Label htmlFor="wake-word" className="text-xs">Wake word</Label>
              <Input
                id="wake-word"
                value={wakeWord}
                onChange={(e) => { setWakeWord(e.target.value); setSavedNote(null) }}
                placeholder="hey assistant"
              />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="auto-briefing" className="text-xs">Auto morning briefing</Label>
              <Switch
                id="auto-briefing"
                checked={autoBriefing}
                onCheckedChange={(v) => { setAutoBriefing(v); setSavedNote(null) }}
              />
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={handleSave} disabled={saving} className="min-h-[40px]">
                {saving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
                Save Settings
              </Button>
              {savedNote && <span className="text-xs text-emerald-600">{savedNote}</span>}
            </div>
            {error && <p className="text-xs text-red-600">{error}</p>}
          </>
        )}
      </CardContent>
    </Card>
  )
}

"use client"

/**
 * AUTO-RESPONSE SETTINGS — the writer's first surface.
 *
 * The auto-response module is LIVE on its read side (getHotLeads feeds the
 * dashboard and /leads; generateAIResponse reads these settings for tone), but
 * nothing anywhere read or wrote auto_response_settings itself — every agent ran
 * on the hardcoded defaults with no way to enable, tune or constrain their
 * auto-replies. updateAutoResponseSettings upserts by session-resolved agent_id;
 * this panel sits beside Reply Style because both govern how the agent's AI
 * writes to contacts.
 */

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Loader2, Check, MessageCircleReply } from "lucide-react"
import { updateAutoResponseSettings } from "@/app/actions/ai-auto-response"

const TONES = ["professional", "friendly", "casual"] as const

export interface AutoResponseSettings {
  is_enabled: boolean
  tone: string
  delay_minutes: number
  keywords: string[]
  custom_prompt: string | null
}

export function AutoResponsePanel({ initial }: { initial: AutoResponseSettings }) {
  const [enabled, setEnabled] = useState(!!initial.is_enabled)
  const [tone, setTone] = useState(initial.tone || "professional")
  const [delay, setDelay] = useState(initial.delay_minutes ?? 5)
  const [keywords, setKeywords] = useState((initial.keywords ?? []).join(", "))
  const [customPrompt, setCustomPrompt] = useState(initial.custom_prompt ?? "")
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSave() {
    setSaving(true); setError(null); setSaved(false)
    const res = await updateAutoResponseSettings({
      is_enabled: enabled,
      tone,
      delay_minutes: Math.max(0, Math.round(Number(delay) || 0)),
      keywords: keywords.split(",").map((k) => k.trim()).filter(Boolean),
      custom_prompt: customPrompt.trim() || null,
    })
    if (!res.success) setError(res.error ?? "Could not save auto-response settings.")
    else setSaved(true)
    setSaving(false)
  }

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <MessageCircleReply className="h-4 w-4" />
          Auto-Response
        </CardTitle>
        <CardDescription>
          When enabled, incoming messages get an AI-drafted reply in your tone after the delay you set.
          Keywords limit which messages qualify; the custom prompt adds your standing instructions.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={enabled} onChange={(e) => { setEnabled(e.target.checked); setSaved(false) }} />
          Enable auto-responses
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="block text-muted-foreground text-xs mb-1">Tone</span>
            <select className="w-full rounded border bg-background px-2 py-1.5 capitalize" value={tone}
              onChange={(e) => { setTone(e.target.value); setSaved(false) }}>
              {TONES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-muted-foreground text-xs mb-1">Delay before replying (minutes)</span>
            <input type="number" min={0} max={120} value={delay} className="w-full rounded border bg-background px-2 py-1.5"
              onChange={(e) => { setDelay(Number(e.target.value)); setSaved(false) }} />
          </label>
        </div>
        <label className="block text-sm">
          <span className="block text-muted-foreground text-xs mb-1">Only respond when the message mentions (comma-separated; empty = all messages)</span>
          <input value={keywords} placeholder="showing, offer, price" className="w-full rounded border bg-background px-2 py-1.5"
            onChange={(e) => { setKeywords(e.target.value); setSaved(false) }} />
        </label>
        <label className="block text-sm">
          <span className="block text-muted-foreground text-xs mb-1">Standing instructions for the AI (optional)</span>
          <textarea value={customPrompt} rows={2} className="w-full rounded border bg-background px-2 py-1.5 resize-y"
            placeholder="e.g. Always offer my calendar link for showings."
            onChange={(e) => { setCustomPrompt(e.target.value); setSaved(false) }} />
        </label>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex items-center gap-3">
          <Button size="sm" onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
            {saving ? "Saving…" : "Save auto-response settings"}
          </Button>
          {saved && (
            <Badge variant="secondary" className="text-xs gap-1"><Check className="h-3 w-3" /> Saved</Badge>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

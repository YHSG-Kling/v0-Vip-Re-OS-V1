"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Loader2, Check, PenLine } from "lucide-react"
import { cn } from "@/lib/utils"
import { REPLY_TONES, REPLY_MODELS, type ReplyTone, type ReplyModel } from "@/lib/ai/reply-style"
import { updateAgentChatPreferences } from "@/app/actions/ai-chat"

interface Props {
  agentId: string
  initialTone: ReplyTone
  initialModel: ReplyModel
}

export function ReplyStylePanel({ agentId, initialTone, initialModel }: Props) {
  const [tone, setTone] = useState<ReplyTone>(initialTone)
  const [model, setModel] = useState<ReplyModel>(initialModel)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const dirty = tone !== initialTone || model !== initialModel

  async function handleSave() {
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      await updateAgentChatPreferences(agentId, { tone, preferred_model: model })
      setSaved(true)
    } catch (err: any) {
      setError(err?.message ?? "Could not save your reply style.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <PenLine className="h-4 w-4" />
          AI Reply Style
        </CardTitle>
        <CardDescription>
          How your AI drafts replies to contacts — the tone it writes in and how much thinking it
          puts behind each draft. Applies to reply suggestions across your conversations.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-2">
          <p className="text-sm font-medium">Tone</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {REPLY_TONES.map((t) => (
              <button
                key={t.value}
                type="button"
                onClick={() => { setTone(t.value); setSaved(false) }}
                className={cn(
                  "text-left rounded-lg border-2 p-3 transition-colors",
                  tone === t.value ? "border-primary bg-primary/5" : "border-border hover:border-primary/50",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{t.label}</span>
                  {tone === t.value && <Check className="h-4 w-4 text-primary shrink-0" />}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">{t.description}</p>
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium">Drafting depth</p>
          <div className="grid gap-2 sm:grid-cols-3">
            {REPLY_MODELS.map((m) => (
              <button
                key={m.value}
                type="button"
                onClick={() => { setModel(m.value); setSaved(false) }}
                className={cn(
                  "text-left rounded-lg border-2 p-3 transition-colors",
                  model === m.value ? "border-primary bg-primary/5" : "border-border hover:border-primary/50",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{m.label}</span>
                  {model === m.value && <Check className="h-4 w-4 text-primary shrink-0" />}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">{m.description}</p>
              </button>
            ))}
          </div>
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}

        <div className="flex items-center gap-3">
          <Button size="sm" onClick={handleSave} disabled={saving || !dirty}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
            {saving ? "Saving…" : "Save reply style"}
          </Button>
          {saved && !dirty && (
            <Badge variant="secondary" className="text-xs gap-1">
              <Check className="h-3 w-3" /> Saved
            </Badge>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

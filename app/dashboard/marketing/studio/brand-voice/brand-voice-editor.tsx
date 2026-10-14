"use client"

import { useState, useTransition } from "react"
import { saveBrandVoiceProfileAction, type BrandVoiceProfile } from "@/app/actions/brand-voice"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { Check, Loader2, Plus, X, AlertCircle, Sparkles, ShieldCheck, Volume2 } from "lucide-react"

const TONE_OPTIONS = [
  { value: "professional",  label: "Professional" },
  { value: "warm",          label: "Warm & Approachable" },
  { value: "authoritative", label: "Authoritative" },
  { value: "conversational",label: "Conversational" },
  { value: "luxury",        label: "Luxury / Aspirational" },
  { value: "friendly",      label: "Friendly" },
  // "educational" was offered here and the column has never accepted it, so
  // picking it silently failed the save. friendly is the value that exists.
]

const FORMALITY_OPTIONS = [
  { value: "formal",        label: "Formal" },
  { value: "semi_formal",   label: "Semi-Formal" },
  { value: "casual",        label: "Casual" },
]

interface BrandVoiceEditorProps {
  initialProfile: BrandVoiceProfile | null
}

export function BrandVoiceEditor({ initialProfile }: BrandVoiceEditorProps) {
  const [isPending, startTrans] = useTransition()
  const [saved, setSaved]       = useState(false)
  const [error, setError]       = useState<string | null>(null)

  const [tone, setTone]               = useState(initialProfile?.tone ?? "professional")
  const [formality, setFormality]     = useState(initialProfile?.formality_level ?? "semi_formal")
  const [tagline, setTagline]         = useState(initialProfile?.tagline ?? "")
  const [mission, setMission]         = useState(initialProfile?.mission_statement ?? "")
  const [customInstr, setCustomInstr] = useState(initialProfile?.custom_instructions ?? "")

  const [keyMessages, setKeyMessages]       = useState<string[]>(initialProfile?.key_brand_messages  ?? [])
  const [preferredWords, setPreferredWords] = useState<string[]>(initialProfile?.preferred_words     ?? [])
  const [prohibitedWords, setProhibited]    = useState<string[]>(initialProfile?.prohibited_words    ?? [])

  const [newKeyMsg, setNewKeyMsg]         = useState("")
  const [newPreferred, setNewPreferred]   = useState("")
  const [newProhibited, setNewProhibited] = useState("")

  function addToList(
    list: string[], setter: (v: string[]) => void,
    val: string, clearInput: () => void
  ) {
    const trimmed = val.trim()
    if (!trimmed || list.includes(trimmed)) return
    setter([...list, trimmed])
    clearInput()
  }

  function removeFromList(list: string[], setter: (v: string[]) => void, item: string) {
    setter(list.filter(x => x !== item))
  }

  function handleSave() {
    setError(null)
    setSaved(false)
    startTrans(async () => {
      const res = await saveBrandVoiceProfileAction({
        tone,
        formality_level:     formality,
        tagline:             tagline   || undefined,
        mission_statement:   mission   || undefined,
        custom_instructions: customInstr || undefined,
        key_brand_messages:  keyMessages.length  > 0 ? keyMessages  : undefined,
        preferred_words:     preferredWords.length > 0 ? preferredWords : undefined,
        prohibited_words:    prohibitedWords.length > 0 ? prohibitedWords : undefined,
      })
      if (res.success) {
        setSaved(true)
        setTimeout(() => setSaved(false), 3000)
      } else {
        setError(res.error ?? "Failed to save")
      }
    })
  }

  return (
    <div className="space-y-6">

      {/* Tone & Formality */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Volume2 className="h-4 w-4 text-primary" />
            Voice & Tone
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <Label className="text-xs mb-1 block">Tone</Label>
            <Select value={tone} onValueChange={setTone}>
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TONE_OPTIONS.map(o => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs mb-1 block">Formality Level</Label>
            <Select value={formality} onValueChange={setFormality}>
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FORMALITY_OPTIONS.map(o => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="sm:col-span-2">
            <Label className="text-xs mb-1 block">Tagline</Label>
            <Input
              value={tagline}
              onChange={e => setTagline(e.target.value)}
              placeholder="e.g. Your trusted partner in real estate"
              className="h-9 text-sm"
            />
          </div>
        </CardContent>
      </Card>

      {/* Brand Messages */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            Key Brand Messages
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Core talking points the AI should weave into your content naturally.
          </p>
          <div className="flex gap-2">
            <Input
              value={newKeyMsg}
              onChange={e => setNewKeyMsg(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addToList(keyMessages, setKeyMessages, newKeyMsg, () => setNewKeyMsg("")) } }}
              placeholder="Add a key message…"
              className="h-8 text-sm"
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-label="Add key message"
              onClick={() => addToList(keyMessages, setKeyMessages, newKeyMsg, () => setNewKeyMsg(""))}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>
          {keyMessages.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {keyMessages.map(msg => (
                <Badge key={msg} variant="secondary" className="gap-1 text-xs pr-1">
                  {msg}
                  <button type="button" aria-label={`Remove "${msg}"`} onClick={() => removeFromList(keyMessages, setKeyMessages, msg)} className="ml-0.5 hover:text-destructive">
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
            </div>
          )}

          <div className="pt-2">
            <Label className="text-xs mb-1 block">Mission Statement</Label>
            <Textarea
              value={mission}
              onChange={e => setMission(e.target.value)}
              placeholder="Describe what drives your work as a real estate professional…"
              rows={2}
              className="text-sm resize-none"
            />
          </div>
        </CardContent>
      </Card>

      {/* Vocabulary Control */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary" />
            Vocabulary Control
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label className="text-xs font-semibold text-green-700">Preferred Words / Phrases</Label>
            <p className="text-xs text-muted-foreground">Words the AI should favor in generated content.</p>
            <div className="flex gap-2">
              <Input
                value={newPreferred}
                onChange={e => setNewPreferred(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addToList(preferredWords, setPreferredWords, newPreferred, () => setNewPreferred("")) } }}
                placeholder="e.g. nestled, move-in ready…"
                className="h-8 text-sm"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                aria-label="Add preferred word"
                onClick={() => addToList(preferredWords, setPreferredWords, newPreferred, () => setNewPreferred(""))}
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </div>
            {preferredWords.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {preferredWords.map(w => (
                  <Badge key={w} variant="outline" className="gap-1 text-xs pr-1 border-green-300 text-green-700">
                    {w}
                    <button type="button" aria-label={`Remove "${w}"`} onClick={() => removeFromList(preferredWords, setPreferredWords, w)} className="ml-0.5 hover:text-destructive">
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <Label className="text-xs font-semibold text-destructive">Prohibited Words / Phrases</Label>
            <p className="text-xs text-muted-foreground">
              Words the AI must never use. Add Fair Housing terms here (e.g. "perfect for families", "great neighborhood").
            </p>
            <div className="flex gap-2">
              <Input
                value={newProhibited}
                onChange={e => setNewProhibited(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addToList(prohibitedWords, setProhibited, newProhibited, () => setNewProhibited("")) } }}
                placeholder="e.g. perfect for families, exclusive…"
                className="h-8 text-sm"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                aria-label="Add prohibited word"
                onClick={() => addToList(prohibitedWords, setProhibited, newProhibited, () => setNewProhibited(""))}
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </div>
            {prohibitedWords.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {prohibitedWords.map(w => (
                  <Badge key={w} variant="outline" className="gap-1 text-xs pr-1 border-destructive/40 text-destructive">
                    {w}
                    <button type="button" aria-label={`Remove "${w}"`} onClick={() => removeFromList(prohibitedWords, setProhibited, w)} className="ml-0.5 hover:text-destructive">
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Custom Instructions */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Additional AI Instructions</CardTitle>
        </CardHeader>
        <CardContent>
          <Textarea
            value={customInstr}
            onChange={e => setCustomInstr(e.target.value)}
            placeholder="Any other guidance for the AI — e.g. always mention your team name, always include a call to action, keep descriptions under 200 words…"
            rows={3}
            className="text-sm resize-none"
          />
        </CardContent>
      </Card>

      {/* Save */}
      {error && (
        <div className="flex items-center gap-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      <div className="flex items-center justify-end gap-3">
        {saved && (
          <span className="flex items-center gap-1.5 text-sm text-green-600">
            <Check className="h-4 w-4" />
            Saved
          </span>
        )}
        <Button onClick={handleSave} disabled={isPending}>
          {isPending ? (
            <><Loader2 className="h-4 w-4 animate-spin mr-2" />Saving…</>
          ) : (
            "Save BrandVoice Profile"
          )}
        </Button>
      </div>
    </div>
  )
}

"use client"

import { useState, useTransition, useCallback } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { ASSISTANT_VOICE_OPTIONS } from "@/lib/video/assistant-options"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Bot,
  Plus,
  Trash2,
  RefreshCw,
  Save,
  MessageSquare,
  ShieldAlert,
  BookOpen,
  GitBranch,
  Loader2,
  CheckCircle,
  X,
  Info,
  Phone,
} from "lucide-react"
import {
  saveAIIdentityProfile,
  generateIdentityPreview,
  type AIIdentityProfile,
  type SaveAIIdentityInput,
} from "@/app/actions/ai-identity"

// ─── Types ────────────────────────────────────────────────────────────────────

type Scope = "brokerage" | "team" | "agent"

interface FaqItem {
  question: string
  answer: string
}

interface ObjectionItem {
  objection: string
  response: string
  category: string
}

export interface AIIdentityEditorProps {
  scope: Scope
  scopeId: string
  brokerageId: string
  brokerageName?: string
  teamName?: string
  initialProfile: AIIdentityProfile | null
  parentProfile: AIIdentityProfile | null
}

// ─── Tone cards data ──────────────────────────────────────────────────────────

const TONE_OPTIONS = [
  {
    value: "professional",
    label: "Professional",
    sample: "Thank you for reaching out. I would be happy to assist you with your real estate needs.",
  },
  {
    value: "conversational",
    label: "Conversational",
    sample: "Hey! Thanks for getting in touch — I'd love to help you find the perfect home.",
  },
  {
    value: "luxury",
    label: "Luxury",
    sample: "Welcome. It is my privilege to curate an exceptional property experience tailored exclusively for you.",
  },
  {
    value: "friendly",
    label: "Friendly",
    sample: "Hi there! So great to connect with you. Let's make your home journey amazing together!",
  },
  {
    value: "authoritative",
    label: "Authoritative",
    sample: "With deep market expertise, I deliver data-driven guidance that protects your investment.",
  },
  {
    value: "warm",
    label: "Warm",
    sample: "It means so much that you reached out. I'm here every step of the way — you're in good hands.",
  },
] as const

const OBJECTION_CATEGORIES = [
  "price",
  "timing",
  "agent_trust",
  "market_conditions",
  "process",
] as const

const DEFAULT_ESCALATION_RULES: Record<string, boolean> = {
  contact_requests_human: true,
  legal_liability_detected: true,
  negative_sentiment_high: true,
  offer_negotiation_starts: true,
  three_unanswered_messages: true,
}

const ESCALATION_LABELS: Record<string, string> = {
  contact_requests_human: "Contact requests human agent",
  legal_liability_detected: "Legal or liability question detected",
  negative_sentiment_high: "Complaint or negative sentiment score exceeds threshold",
  offer_negotiation_starts: "Offer negotiation begins",
  three_unanswered_messages: "Three consecutive unanswered messages",
}

// ─── Component ────────────────────────────────────────────────────────────────

export function AIIdentityEditor({
  scope,
  scopeId,
  brokerageId,
  brokerageName,
  teamName,
  initialProfile,
  parentProfile,
}: AIIdentityEditorProps) {
  // ── Identity section state
  const [assistantName, setAssistantName] = useState(
    initialProfile?.assistant_name ?? parentProfile?.assistant_name ?? "Your AI Assistant"
  )
  const [personaLabel, setPersonaLabel] = useState(
    initialProfile?.persona_label ?? parentProfile?.persona_label ?? "AI Real Estate Specialist"
  )
  const [avatarUrl, setAvatarUrl] = useState(
    initialProfile?.avatar_url ?? parentProfile?.avatar_url ?? ""
  )
  const [assistantVoiceId, setAssistantVoiceId] = useState(
    initialProfile?.elevenlabs_voice_id ?? parentProfile?.elevenlabs_voice_id ?? ""
  )
  const [faceOptions, setFaceOptions] = useState<Array<{ key: string; imageUrl: string }>>([])
  const [facesBusy, setFacesBusy] = useState(false)
  const [facesError, setFacesError] = useState<string | null>(null)
  const [tone, setTone] = useState<string | null>(
    initialProfile?.tone ?? parentProfile?.tone ?? null
  )
  const [formalityLevel, setFormalityLevel] = useState<string | null>(
    initialProfile?.formality_level ?? parentProfile?.formality_level ?? null
  )

  // ── Inheritance overrides (team/agent only)
  const [overrideTone, setOverrideTone] = useState(
    scope !== "brokerage" && !!initialProfile?.tone
  )
  const [overrideFaq, setOverrideFaq] = useState(
    scope !== "brokerage" && (initialProfile?.faq_knowledge?.length ?? 0) > 0
  )
  const [overrideEscalation, setOverrideEscalation] = useState(
    scope !== "brokerage" &&
      Object.keys(initialProfile?.escalation_rules ?? {}).length > 0
  )

  // ── Knowledge section state
  const [faqs, setFaqs] = useState<FaqItem[]>(
    initialProfile?.faq_knowledge ?? []
  )
  const [objections, setObjections] = useState<ObjectionItem[]>(
    initialProfile?.objection_library ?? []
  )

  // ── Guardrails section state
  const [prohibitedChips, setProhibitedChips] = useState<string[]>(
    initialProfile?.prohibited_language ?? []
  )
  const [chipInput, setChipInput] = useState("")
  const [escalationRules, setEscalationRules] = useState<Record<string, boolean>>(
    Object.keys(initialProfile?.escalation_rules ?? {}).length > 0
      ? (initialProfile!.escalation_rules as Record<string, boolean>)
      : { ...DEFAULT_ESCALATION_RULES }
  )
  const [followupStyle, setFollowupStyle] = useState(
    initialProfile?.followup_style ?? "warm_persistent"
  )

  // ── Call handling state (brokerage-level only; inherited by child scopes)
  const [aiAnswerCalls, setAiAnswerCalls] = useState<boolean>(
    (initialProfile as any)?.ai_answer_calls ?? false
  )
  const [aiCallHandleInbound, setAiCallHandleInbound] = useState<boolean>(
    (initialProfile as any)?.ai_call_handle_inbound ?? true
  )
  const [aiCallHandleOutbound, setAiCallHandleOutbound] = useState<boolean>(
    (initialProfile as any)?.ai_call_handle_outbound ?? false
  )
  const [aiCallForwardNumber, setAiCallForwardNumber] = useState<string>(
    (initialProfile as any)?.ai_call_forward_number ?? ""
  )
  // Hour-aware answering: 'always' = AI owns every call; 'after_hours' = during
  // office hours it offers an immediate transfer to the human, after hours it
  // runs the full reception.
  const [aiAnswerMode, setAiAnswerMode] = useState<"always" | "after_hours">(
    ((initialProfile as any)?.ai_answer_mode as "always" | "after_hours") ?? "always"
  )
  const initialHours = ((initialProfile as any)?.business_hours ?? {}) as { timezone?: string; start?: string; end?: string }
  const [hoursStart, setHoursStart] = useState<string>(initialHours.start ?? "09:00")
  const [hoursEnd, setHoursEnd] = useState<string>(initialHours.end ?? "18:00")
  const [hoursTz, setHoursTz] = useState<string>(initialHours.timezone ?? "America/Chicago")

  // ── Preview state
  const [previewText, setPreviewText] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [isGeneratingPreview, startPreviewTransition] = useTransition()

  // ── Save state
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle")
  const [saveError, setSaveError] = useState<string | null>(null)
  const [isPending, startSaveTransition] = useTransition()

  // ─────────────────────────────────────────────────────────────────────────
  // Handlers
  // ─────────────────────────────────────────────────────────────────────────

  const handleGeneratePreview = useCallback(() => {
    if (!tone || !formalityLevel) return
    startPreviewTransition(async () => {
      setPreviewText(null)
      setPreviewError(null)
      const result = await generateIdentityPreview({
        assistantName,
        personaLabel,
        tone: tone!,
        formalityLevel: formalityLevel!,
      })
      if (result.success && result.preview) {
        setPreviewText(result.preview)
      } else {
        setPreviewError(result.error ?? "Preview failed")
      }
    })
  }, [assistantName, personaLabel, tone, formalityLevel])

  const handleSave = useCallback(() => {
    startSaveTransition(async () => {
      setSaveStatus("saving")
      setSaveError(null)

      const input: SaveAIIdentityInput = {
        scopeType: scope,
        scopeId,
        brokerageId,
        assistantName,
        personaLabel,
        avatarUrl: avatarUrl.trim() || null,
        assistantVoiceId: assistantVoiceId.trim() || null,
        tone: overrideTone || scope === "brokerage" ? tone : null,
        formalityLevel: overrideTone || scope === "brokerage" ? formalityLevel : null,
        objectionLibrary: objections,
        faqKnowledge: overrideFaq || scope === "brokerage" ? faqs : [],
        prohibitedLanguage: prohibitedChips,
        escalationRules: overrideEscalation || scope === "brokerage" ? escalationRules : {},
        followupStyle,
        parentScopeId: parentProfile?.id ?? null,
        // Call handling — brokerage-level only; child scopes inherit
        aiAnswerCalls: scope === "brokerage" ? aiAnswerCalls : undefined,
        aiCallHandleInbound: scope === "brokerage" ? aiCallHandleInbound : undefined,
        aiCallHandleOutbound: scope === "brokerage" ? aiCallHandleOutbound : undefined,
        aiCallForwardNumber: scope === "brokerage" ? (aiCallForwardNumber.trim() || null) : undefined,
        aiAnswerMode: scope === "brokerage" ? aiAnswerMode : undefined,
        businessHours: scope === "brokerage" && aiAnswerMode === "after_hours"
          ? { timezone: hoursTz, start: hoursStart, end: hoursEnd, days: [1, 2, 3, 4, 5] }
          : undefined,
      }

      const result = await saveAIIdentityProfile(input)
      if (result.success) {
        setSaveStatus("saved")
        setTimeout(() => setSaveStatus("idle"), 3000)
      } else {
        setSaveStatus("error")
        setSaveError(result.error ?? "Save failed")
      }
    })
  }, [
    scope, scopeId, brokerageId, assistantName, personaLabel, avatarUrl, assistantVoiceId,
    tone, formalityLevel, overrideTone, overrideFaq, overrideEscalation,
    faqs, objections, prohibitedChips, escalationRules, followupStyle, parentProfile,
    aiAnswerCalls, aiCallHandleInbound, aiCallHandleOutbound, aiCallForwardNumber,
    aiAnswerMode, hoursStart, hoursEnd, hoursTz,
  ])

  const addFaq = () => setFaqs((prev) => [...prev, { question: "", answer: "" }])
  const removeFaq = (i: number) => setFaqs((prev) => prev.filter((_, idx) => idx !== i))
  const updateFaq = (i: number, field: keyof FaqItem, value: string) =>
    setFaqs((prev) => prev.map((item, idx) => (idx === i ? { ...item, [field]: value } : item)))

  const addObjection = () =>
    setObjections((prev) => [...prev, { objection: "", response: "", category: "price" }])
  const removeObjection = (i: number) => setObjections((prev) => prev.filter((_, idx) => idx !== i))
  const updateObjection = (i: number, field: keyof ObjectionItem, value: string) =>
    setObjections((prev) =>
      prev.map((item, idx) => (idx === i ? { ...item, [field]: value } : item))
    )

  const addChip = () => {
    const trimmed = chipInput.trim()
    if (trimmed && !prohibitedChips.includes(trimmed)) {
      setProhibitedChips((prev) => [...prev, trimmed])
      setChipInput("")
    }
  }
  const removeChip = (chip: string) =>
    setProhibitedChips((prev) => prev.filter((c) => c !== chip))

  const toneIsEditable = scope === "brokerage" || overrideTone
  const faqIsEditable = scope === "brokerage" || overrideFaq
  const escalationIsEditable = scope === "brokerage" || overrideEscalation

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* ── Section 1: Identity ─────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Bot className="h-5 w-5 text-primary" />
            <CardTitle>Identity</CardTitle>
          </div>
          <CardDescription>
            Define the name, persona, and voice your AI assistant uses in every interaction.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="assistant-name">Assistant name</Label>
              <Input
                id="assistant-name"
                value={assistantName}
                onChange={(e) => setAssistantName(e.target.value)}
                placeholder="Aria, Max, or your brand name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="persona-label">Persona label</Label>
              <Input
                id="persona-label"
                value={personaLabel}
                onChange={(e) => setPersonaLabel(e.target.value)}
                placeholder="Your AI Listing Specialist"
              />
            </div>
          </div>

          {/* Assistant photo — the face your assistant uses when it PRESENTS:
              the weekly Partners' Meeting show, the board-packet video, and
              report videos are hosted by this photo + your assistant's voice
              (so you're briefed by your assistant, not a mirror of yourself). */}
          <div className="space-y-2">
            <Label htmlFor="assistant-avatar">Assistant photo</Label>
            <div className="flex items-center gap-3">
              {avatarUrl.trim() ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={avatarUrl} alt="Assistant" className="h-12 w-12 rounded-full object-cover border" />
              ) : (
                <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center text-lg font-semibold text-muted-foreground border">
                  {(assistantName[0] ?? "A").toUpperCase()}
                </div>
              )}
              <Input
                id="assistant-avatar"
                value={avatarUrl}
                onChange={(e) => setAvatarUrl(e.target.value)}
                placeholder="https://… (photo used when your assistant presents reports & videos)"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Report videos (Partners&apos; Meeting, board packet) are hosted by your named assistant with this photo and its voice — client-facing videos always use the agent&apos;s own face and voice.
            </p>
            {/* FACE OPTIONS — one click renders a small gallery of distinct
                AI-generated personas; pick one and it becomes the assistant's
                face everywhere it presents. Never a photo of a real person. */}
            <div className="flex items-center gap-2 pt-1">
              <Button
                type="button" size="sm" variant="outline" disabled={facesBusy}
                onClick={async () => {
                  setFacesBusy(true); setFacesError(null)
                  const { generateAssistantFaceOptionsAction } = await import("@/app/actions/ai-identity")
                  const res = await generateAssistantFaceOptionsAction()
                  if (res.success) setFaceOptions(res.options)
                  else setFacesError(res.error)
                  setFacesBusy(false)
                }}
              >
                {facesBusy ? "Generating faces…" : "Generate face options"}
              </Button>
              {facesError && <span className="text-xs text-red-600">{facesError}</span>}
            </div>
            {faceOptions.length > 0 && (
              <div className="flex gap-3 pt-1">
                {faceOptions.map((f) => (
                  <button
                    key={f.key} type="button" onClick={() => setAvatarUrl(f.imageUrl)}
                    className={`rounded-full border-2 transition ${avatarUrl === f.imageUrl ? "border-primary ring-2 ring-primary/30" : "border-transparent hover:border-muted-foreground/40"}`}
                    title="Use this face"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={f.imageUrl} alt={f.key} className="h-16 w-16 rounded-full object-cover" />
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Assistant VOICE — curated ElevenLabs presets (the assistant picks
              from professional voices; the humans clone their OWN voice in the
              Twin Studio). This voice answers the phone and narrates reports. */}
          <div className="space-y-2">
            <Label htmlFor="assistant-voice">Assistant voice</Label>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              {ASSISTANT_VOICE_OPTIONS.map((v) => (
                <button
                  key={v.voiceId} type="button" onClick={() => setAssistantVoiceId(v.voiceId)}
                  className={`rounded-md border p-2 text-left transition ${assistantVoiceId === v.voiceId ? "border-primary ring-2 ring-primary/30 bg-primary/5" : "hover:border-muted-foreground/40"}`}
                >
                  <div className="text-sm font-medium">{v.label}</div>
                  <div className="text-xs text-muted-foreground leading-snug">{v.style}</div>
                </button>
              ))}
            </div>
            {assistantVoiceId && !ASSISTANT_VOICE_OPTIONS.some((v) => v.voiceId === assistantVoiceId) && (
              <p className="text-xs text-muted-foreground">Using a custom voice id: <code>{assistantVoiceId}</code></p>
            )}
            <p className="text-xs text-muted-foreground">
              This voice answers your phone line and narrates your report videos. Agents&apos; own cloned voices (Twin Studio) always speak client-facing videos.
            </p>
          </div>

          {/* Tone selector */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label>Tone</Label>
              {scope !== "brokerage" && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Switch
                    checked={overrideTone}
                    onCheckedChange={setOverrideTone}
                    id="override-tone"
                  />
                  <label htmlFor="override-tone" className="cursor-pointer">
                    Override {parentProfile ? (scope === "agent" ? "team/brokerage" : "brokerage") : "default"} tone
                  </label>
                </div>
              )}
            </div>
            <div className={`grid grid-cols-2 md:grid-cols-3 gap-3 ${!toneIsEditable ? "opacity-50 pointer-events-none" : ""}`}>
              {TONE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setTone(option.value)}
                  className={`rounded-lg border p-3 text-left transition-all ${
                    tone === option.value
                      ? "border-primary bg-primary/5 ring-1 ring-primary"
                      : "border-border hover:border-primary/40 hover:bg-muted/50"
                  }`}
                >
                  <p className="font-medium text-sm">{option.label}</p>
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed line-clamp-2">
                    {option.sample}
                  </p>
                </button>
              ))}
            </div>
          </div>

          {/* Formality */}
          <div className={`space-y-2 ${!toneIsEditable ? "opacity-50 pointer-events-none" : ""}`}>
            <Label>Formality level</Label>
            <div className="flex gap-2">
              {(["formal", "semi_formal", "casual"] as const).map((level) => (
                <button
                  key={level}
                  type="button"
                  onClick={() => setFormalityLevel(level)}
                  className={`flex-1 rounded-md border py-2 text-sm font-medium transition-all ${
                    formalityLevel === level
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border hover:border-primary/40"
                  }`}
                >
                  {level === "semi_formal" ? "Semi-formal" : level.charAt(0).toUpperCase() + level.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {/* Live preview */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label>Live greeting preview</Label>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handleGeneratePreview}
                disabled={!tone || !formalityLevel || isGeneratingPreview}
              >
                {isGeneratingPreview ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                )}
                {previewText ? "Regenerate" : "Generate preview"}
              </Button>
            </div>
            {!tone || !formalityLevel ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted/40 rounded-lg p-3">
                <Info className="h-4 w-4 shrink-0" />
                Select a tone and formality level to generate a preview.
              </div>
            ) : previewError ? (
              <div className="text-sm text-destructive bg-destructive/10 rounded-lg p-3">
                {previewError}
              </div>
            ) : previewText ? (
              <div className="bg-muted/50 rounded-lg p-4 border">
                <div className="flex items-start gap-3">
                  <div className="h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                    <Bot className="h-3.5 w-3.5 text-primary" />
                  </div>
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-1">
                      {assistantName} · {personaLabel}
                    </p>
                    <p className="text-sm leading-relaxed">{previewText}</p>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {/* ── Section 2: Knowledge ────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <BookOpen className="h-5 w-5 text-primary" />
            <CardTitle>Knowledge</CardTitle>
          </div>
          <CardDescription>
            FAQ answers and objection responses the AI will use during conversations.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* FAQs */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-sm">FAQ knowledge base</p>
                <p className="text-xs text-muted-foreground">
                  Answers the AI gives to common questions.
                </p>
              </div>
              <div className="flex items-center gap-3">
                {scope !== "brokerage" && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Switch
                      checked={overrideFaq}
                      onCheckedChange={setOverrideFaq}
                      id="override-faq"
                    />
                    <label htmlFor="override-faq" className="cursor-pointer text-xs">
                      Add custom FAQs
                    </label>
                  </div>
                )}
                {faqIsEditable && (
                  <Button type="button" size="sm" variant="outline" onClick={addFaq}>
                    <Plus className="h-3.5 w-3.5 mr-1" />
                    Add FAQ
                  </Button>
                )}
              </div>
            </div>

            {!faqIsEditable && parentProfile && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted/40 rounded-lg p-3">
                <Info className="h-4 w-4 shrink-0" />
                Inheriting {parentProfile.faq_knowledge?.length ?? 0} FAQ{(parentProfile.faq_knowledge?.length ?? 0) !== 1 ? "s" : ""} from parent profile. Enable toggle to add more.
              </div>
            )}

            {faqIsEditable && faqs.length === 0 && (
              <div className="text-sm text-muted-foreground bg-muted/40 rounded-lg p-3 text-center">
                No FAQs added yet. Click "Add FAQ" to get started.
              </div>
            )}

            {faqIsEditable && faqs.map((faq, i) => (
              <div key={i} className="border rounded-lg p-4 space-y-3 bg-muted/20">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">FAQ {i + 1}</span>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    onClick={() => removeFaq(i)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <div className="space-y-2">
                  <Input
                    placeholder="Question (e.g. What areas do you serve?)"
                    value={faq.question}
                    onChange={(e) => updateFaq(i, "question", e.target.value)}
                  />
                  <Textarea
                    placeholder="Answer the AI will give"
                    value={faq.answer}
                    onChange={(e) => updateFaq(i, "answer", e.target.value)}
                    rows={2}
                    className="resize-none"
                  />
                </div>
              </div>
            ))}
          </div>

          <Separator />

          {/* Objections */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-sm">Objection library</p>
                <p className="text-xs text-muted-foreground">
                  Teach the AI how to handle common objections.
                </p>
              </div>
              <Button type="button" size="sm" variant="outline" onClick={addObjection}>
                <Plus className="h-3.5 w-3.5 mr-1" />
                Add objection
              </Button>
            </div>

            {objections.length === 0 && (
              <div className="text-sm text-muted-foreground bg-muted/40 rounded-lg p-3 text-center">
                No objections added yet.
              </div>
            )}

            {objections.map((item, i) => (
              <div key={i} className="border rounded-lg p-4 space-y-3 bg-muted/20">
                <div className="flex items-center justify-between">
                  <Select
                    value={item.category}
                    onValueChange={(v) => updateObjection(i, "category", v)}
                  >
                    <SelectTrigger className="w-40 h-7 text-xs">
                      <SelectValue placeholder="Category" />
                    </SelectTrigger>
                    <SelectContent>
                      {OBJECTION_CATEGORIES.map((cat) => (
                        <SelectItem key={cat} value={cat}>
                          {cat.replace("_", " ")}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    onClick={() => removeObjection(i)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <Input
                  placeholder="Objection (e.g. The market is too high right now)"
                  value={item.objection}
                  onChange={(e) => updateObjection(i, "objection", e.target.value)}
                />
                <Textarea
                  placeholder="AI response to this objection"
                  value={item.response}
                  onChange={(e) => updateObjection(i, "response", e.target.value)}
                  rows={2}
                  className="resize-none"
                />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* ── Section 3: Guardrails ────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-primary" />
            <CardTitle>Guardrails</CardTitle>
          </div>
          <CardDescription>
            Prohibited language, escalation triggers, and follow-up behavior.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Prohibited language */}
          <div className="space-y-3">
            <Label>Prohibited language</Label>
            <p className="text-xs text-muted-foreground -mt-1">
              Competitor names, legal terms without disclaimers, price guarantees.
            </p>
            <div className="flex gap-2">
              <Input
                placeholder="Type a word or phrase and press Enter"
                value={chipInput}
                onChange={(e) => setChipInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    addChip()
                  }
                }}
              />
              <Button type="button" size="sm" variant="outline" onClick={addChip}>
                Add
              </Button>
            </div>
            {prohibitedChips.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {prohibitedChips.map((chip) => (
                  <Badge key={chip} variant="secondary" className="gap-1 pr-1">
                    {chip}
                    <button
                      type="button"
                      onClick={() => removeChip(chip)}
                      className="rounded-full hover:text-destructive ml-0.5"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}
          </div>

          <Separator />

          {/* Escalation rules */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-sm">Escalate to human when:</p>
              </div>
              {scope !== "brokerage" && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Switch
                    checked={overrideEscalation}
                    onCheckedChange={setOverrideEscalation}
                    id="override-escalation"
                  />
                  <label htmlFor="override-escalation" className="cursor-pointer text-xs">
                    Use my own escalation rules
                  </label>
                </div>
              )}
            </div>

            <div className={`space-y-2 ${!escalationIsEditable ? "opacity-50 pointer-events-none" : ""}`}>
              {Object.keys(DEFAULT_ESCALATION_RULES).map((key) => (
                <div key={key} className="flex items-center justify-between rounded-md border px-3 py-2.5">
                  <span className="text-sm">{ESCALATION_LABELS[key]}</span>
                  <Switch
                    checked={escalationRules[key] ?? false}
                    onCheckedChange={(checked) =>
                      setEscalationRules((prev) => ({ ...prev, [key]: checked }))
                    }
                  />
                </div>
              ))}
            </div>
          </div>

          <Separator />

          {/* Follow-up style */}
          <div className="space-y-3">
            <Label>Follow-up style</Label>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  { value: "warm_persistent", label: "Warm & persistent", desc: "Friendly, regular check-ins" },
                  { value: "gentle_nudge", label: "Gentle nudge", desc: "Light touches, low pressure" },
                  { value: "direct_close", label: "Direct close", desc: "Action-oriented, clear CTAs" },
                  { value: "educational", label: "Educational", desc: "Value-first, teach & nurture" },
                ] as const
              ).map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setFollowupStyle(option.value)}
                  className={`rounded-lg border p-3 text-left transition-all ${
                    followupStyle === option.value
                      ? "border-primary bg-primary/5 ring-1 ring-primary"
                      : "border-border hover:border-primary/40 hover:bg-muted/50"
                  }`}
                >
                  <p className="font-medium text-sm">{option.label}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{option.desc}</p>
                </button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Section 4: Call Handling (brokerage only) ───────────────────── */}
      {scope === "brokerage" && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Phone className="h-5 w-5 text-primary" />
              <CardTitle>AI Call Handling</CardTitle>
            </div>
            <CardDescription>
              Configure whether the AI answers inbound calls, makes outbound calls, and
              which number to forward calls to when handing off to a human.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Master toggle */}
            <div className="flex items-center justify-between rounded-md border px-4 py-3">
              <div>
                <p className="font-medium text-sm">Enable AI call handling</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  AI will be available to answer and/or place calls on behalf of your brokerage.
                </p>
              </div>
              <Switch
                checked={aiAnswerCalls}
                onCheckedChange={setAiAnswerCalls}
                id="ai-answer-calls"
              />
            </div>

            {aiAnswerCalls && (
              <>
                <Separator />

                {/* Inbound */}
                <div className="flex items-center justify-between rounded-md border px-4 py-3">
                  <div>
                    <p className="font-medium text-sm">Handle inbound calls</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      AI answers calls from leads and contacts that come into your forwarding number.
                    </p>
                  </div>
                  <Switch
                    checked={aiCallHandleInbound}
                    onCheckedChange={setAiCallHandleInbound}
                    id="ai-inbound"
                  />
                </div>

                {/* Outbound */}
                <div className="flex items-center justify-between rounded-md border px-4 py-3">
                  <div>
                    <p className="font-medium text-sm">Make outbound calls</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      AI places calls to leads and contacts as part of the ISA follow-up sequence.
                    </p>
                  </div>
                  <Switch
                    checked={aiCallHandleOutbound}
                    onCheckedChange={setAiCallHandleOutbound}
                    id="ai-outbound"
                  />
                </div>

                {/* Hour-aware answering — the after-hours receptionist */}
                <div className="rounded-md border px-4 py-3 space-y-2">
                  <p className="font-medium text-sm">When the AI answers</p>
                  <div className="flex flex-wrap items-center gap-3 text-sm">
                    <label className="flex items-center gap-1.5">
                      <input type="radio" name="answer-mode" checked={aiAnswerMode === "always"} onChange={() => setAiAnswerMode("always")} />
                      Every call
                    </label>
                    <label className="flex items-center gap-1.5">
                      <input type="radio" name="answer-mode" checked={aiAnswerMode === "after_hours"} onChange={() => setAiAnswerMode("after_hours")} />
                      Office-hours aware
                    </label>
                  </div>
                  {aiAnswerMode === "after_hours" && (
                    <div className="space-y-1.5">
                      <p className="text-xs text-muted-foreground">
                        During office hours the AI greets and offers an immediate transfer to you; after hours it
                        runs the full reception — qualifies, books, and promises a morning follow-up.
                      </p>
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <input type="time" value={hoursStart} onChange={(e) => setHoursStart(e.target.value)} className="rounded border px-2 py-1" />
                        <span className="text-xs text-muted-foreground">to</span>
                        <input type="time" value={hoursEnd} onChange={(e) => setHoursEnd(e.target.value)} className="rounded border px-2 py-1" />
                        <select value={hoursTz} onChange={(e) => setHoursTz(e.target.value)} className="rounded border px-2 py-1 text-sm">
                          {["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu"].map((tz) => (
                            <option key={tz} value={tz}>{tz.split("/")[1].replace("_", " ")}</option>
                          ))}
                        </select>
                        <span className="text-xs text-muted-foreground">Mon–Fri</span>
                      </div>
                    </div>
                  )}
                </div>

                <Separator />

                {/* Forward number */}
                <div className="space-y-2">
                  <Label htmlFor="forward-number">
                    Forward-to number <span className="text-destructive">*</span>
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    When a caller requests a human or the AI cannot handle the call, it will
                    transfer to this number. Use E.164 format (e.g. +14155552671).
                  </p>
                  <Input
                    id="forward-number"
                    type="tel"
                    placeholder="+14155552671"
                    value={aiCallForwardNumber}
                    onChange={(e) => setAiCallForwardNumber(e.target.value)}
                    className="max-w-xs"
                  />
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Section 5: Inheritance (team / agent only) ───────────────────── */}
      {scope !== "brokerage" && parentProfile && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <GitBranch className="h-5 w-5 text-primary" />
              <CardTitle>Inheritance</CardTitle>
            </div>
            <CardDescription>
              Settings inherited from the parent profile. Enable overrides above to customize.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="rounded-lg bg-muted/40 border p-4 space-y-2">
              <p className="text-sm font-medium">
                Inheriting from:{" "}
                <span className="text-primary">
                  {scope === "agent" && teamName
                    ? `${teamName} team profile`
                    : `${brokerageName ?? "Brokerage"} profile`}
                </span>
              </p>
              <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                {parentProfile.tone && (
                  <Badge variant="outline">Tone: {parentProfile.tone}</Badge>
                )}
                {parentProfile.formality_level && (
                  <Badge variant="outline">Formality: {parentProfile.formality_level}</Badge>
                )}
                {(parentProfile.faq_knowledge?.length ?? 0) > 0 && (
                  <Badge variant="outline">
                    {parentProfile.faq_knowledge.length} FAQ{parentProfile.faq_knowledge.length !== 1 ? "s" : ""}
                  </Badge>
                )}
                {parentProfile.assistant_name && (
                  <Badge variant="outline">Name: {parentProfile.assistant_name}</Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Child overrides only what is toggled. Parent settings fill in the rest at runtime.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Save bar ─────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between rounded-lg border bg-card px-5 py-3 sticky bottom-4 shadow-lg">
        <div className="text-sm text-muted-foreground">
          {saveStatus === "saved" && (
            <span className="flex items-center gap-1.5 text-green-600">
              <CheckCircle className="h-4 w-4" />
              Saved — changes will apply to new AI interactions immediately.
            </span>
          )}
          {saveStatus === "error" && (
            <span className="text-destructive">{saveError}</span>
          )}
          {saveStatus === "idle" && "Unsaved changes will not apply until saved."}
        </div>
        <Button
          onClick={handleSave}
          disabled={isPending || saveStatus === "saving"}
          size="sm"
          className="min-w-24"
        >
          {isPending || saveStatus === "saving" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
          ) : (
            <Save className="h-3.5 w-3.5 mr-1.5" />
          )}
          Save identity
        </Button>
      </div>
    </div>
  )
}

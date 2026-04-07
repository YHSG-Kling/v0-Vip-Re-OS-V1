"use client"

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Copy, Check, ExternalLink, LayoutTemplate, Bot, ShieldCheck } from "lucide-react"
import { saveWidgetSettings, saveAIIdentity } from "./actions"
import { useRouter } from "next/navigation"

interface AIIdentity {
  id: string
  assistant_name: string
  persona_label: string
  tone: string
  formality_level: string
  welcome_message: string
  followup_style: string
  avatar_url: string | null
  active: boolean
}

interface WidgetSettingsClientProps {
  userId: string
  brokerageId: string
  agentId: string | null
  widgetEnabled: boolean
  widgetPosition: "right" | "left"
  aiIdentity: AIIdentity | null
  appUrl: string
}

export default function WidgetSettingsClient({
  userId,
  brokerageId,
  agentId,
  widgetEnabled: initialEnabled,
  widgetPosition: initialPosition,
  aiIdentity: initialIdentity,
  appUrl,
}: WidgetSettingsClientProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  // Widget settings
  const [enabled, setEnabled] = useState(initialEnabled)
  const [position, setPosition] = useState<"right" | "left">(initialPosition)

  // AI identity settings
  const [assistantName, setAssistantName] = useState(initialIdentity?.assistant_name ?? "Alex")
  const [personaLabel, setPersonaLabel] = useState(initialIdentity?.persona_label ?? "Real Estate Assistant")
  const [tone, setTone] = useState(initialIdentity?.tone ?? "friendly")
  const [formalityLevel, setFormalityLevel] = useState(initialIdentity?.formality_level ?? "conversational")
  const [welcomeMessage, setWelcomeMessage] = useState(
    initialIdentity?.welcome_message ?? "Hi! I'm here to help you with your real estate journey. How can I assist you today?"
  )
  const [followupStyle, setFollowupStyle] = useState(initialIdentity?.followup_style ?? "helpful")

  // UI state
  const [copied, setCopied] = useState(false)
  const [widgetSaved, setWidgetSaved] = useState(false)
  const [identitySaved, setIdentitySaved] = useState(false)

  const embedCode = `<script
  src="${appUrl}/widget-loader.js"
  data-vip-agent="${agentId ?? ""}"
  data-vip-brokerage="${brokerageId}"
  data-vip-url="${appUrl}"
  data-vip-position="${position}">
</script>`

  const copyEmbed = () => {
    navigator.clipboard.writeText(embedCode).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  const handleWidgetSave = () => {
    startTransition(async () => {
      const result = await saveWidgetSettings({ agentId, enabled, position })
      if (result.success) {
        setWidgetSaved(true)
        setTimeout(() => setWidgetSaved(false), 2500)
        router.refresh()
      }
    })
  }

  const handleIdentitySave = () => {
    startTransition(async () => {
      const result = await saveAIIdentity({
        identityId: initialIdentity?.id ?? null,
        agentId,
        brokerageId,
        assistantName,
        personaLabel,
        tone,
        formalityLevel,
        welcomeMessage,
        followupStyle,
      })
      if (result.success) {
        setIdentitySaved(true)
        setTimeout(() => setIdentitySaved(false), 2500)
        router.refresh()
      }
    })
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Widget &amp; AI Settings</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Configure your website chat widget, AI assistant identity, and intake routing.
        </p>
      </div>

      {/* ── Widget Configuration ─────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <LayoutTemplate className="h-4 w-4" />
            Chat Widget
          </CardTitle>
          <CardDescription>
            Embed a real-time AI chat widget on your website to capture and qualify visitors.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Enable / disable */}
          <div className="flex items-center justify-between rounded-lg border border-border px-4 py-3">
            <div>
              <p className="font-medium text-sm">Widget enabled</p>
              <p className="text-xs text-muted-foreground">Show the chat launcher on pages using your embed code</p>
            </div>
            <Switch
              checked={enabled}
              onCheckedChange={setEnabled}
              aria-label="Enable widget"
            />
          </div>

          {/* Position toggle */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Widget position</Label>
            <div className="flex gap-3">
              {(["right", "left"] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => setPosition(p)}
                  className={`flex-1 rounded-lg border px-4 py-2 text-sm font-medium transition-colors capitalize ${
                    position === p
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background text-foreground hover:bg-muted"
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>

          <Separator />

          {/* Embed code */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-medium">Embed code</Label>
              {appUrl && (
                <a
                  href={`${appUrl}/widget/chat?brokerage=${brokerageId}&agent=${agentId ?? ""}`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  Preview widget
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
            <div className="relative">
              <pre className="rounded-lg bg-muted px-4 py-3 text-xs font-mono overflow-x-auto border border-border whitespace-pre-wrap break-all">
                {embedCode}
              </pre>
              <Button
                variant="ghost"
                size="sm"
                className="absolute top-2 right-2 h-7 px-2 text-xs"
                onClick={copyEmbed}
              >
                {copied ? (
                  <><Check className="h-3 w-3 mr-1 text-green-600" />Copied</>
                ) : (
                  <><Copy className="h-3 w-3 mr-1" />Copy</>
                )}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Paste this snippet before the <code className="bg-muted px-1 rounded">&lt;/body&gt;</code> tag on your website.
            </p>
          </div>

          <div className="flex justify-end">
            <Button onClick={handleWidgetSave} disabled={isPending} size="sm">
              {widgetSaved ? <><Check className="h-3.5 w-3.5 mr-1.5" />Saved</> : "Save widget settings"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── AI Identity Profile ──────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Bot className="h-4 w-4" />
            AI Assistant Identity
          </CardTitle>
          <CardDescription>
            Define how your AI assistant introduces itself and communicates with website visitors and portal clients.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="assistant-name" className="text-sm">Assistant name</Label>
              <Input
                id="assistant-name"
                value={assistantName}
                onChange={(e) => setAssistantName(e.target.value)}
                placeholder="e.g. Alex, Aria, Scout"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="persona-label" className="text-sm">Persona label</Label>
              <Input
                id="persona-label"
                value={personaLabel}
                onChange={(e) => setPersonaLabel(e.target.value)}
                placeholder="e.g. Real Estate Assistant"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-sm">Tone</Label>
              <div className="flex flex-wrap gap-2">
                {["friendly", "professional", "enthusiastic", "calm"].map((t) => (
                  <button
                    key={t}
                    onClick={() => setTone(t)}
                    className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors capitalize ${
                      tone === t
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-background text-foreground hover:bg-muted"
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm">Formality level</Label>
              <div className="flex flex-wrap gap-2">
                {["conversational", "semi-formal", "formal"].map((f) => (
                  <button
                    key={f}
                    onClick={() => setFormalityLevel(f)}
                    className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors capitalize ${
                      formalityLevel === f
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-background text-foreground hover:bg-muted"
                    }`}
                  >
                    {f}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="welcome-message" className="text-sm">Welcome message</Label>
            <Textarea
              id="welcome-message"
              value={welcomeMessage}
              onChange={(e) => setWelcomeMessage(e.target.value)}
              rows={3}
              placeholder="How your assistant greets visitors when they open the chat..."
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-sm">Follow-up style</Label>
            <div className="flex flex-wrap gap-2">
              {["helpful", "consultative", "direct", "nurturing"].map((s) => (
                <button
                  key={s}
                  onClick={() => setFollowupStyle(s)}
                  className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors capitalize ${
                    followupStyle === s
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background text-foreground hover:bg-muted"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          {/* Identity preview */}
          <div className="rounded-lg border border-border bg-muted/40 p-4 space-y-1">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Preview</p>
            <p className="text-sm font-semibold text-foreground">{assistantName || "Assistant"}</p>
            <p className="text-xs text-muted-foreground">{personaLabel || "Real Estate Assistant"}</p>
            <p className="text-sm text-foreground mt-2 italic leading-relaxed">
              &ldquo;{welcomeMessage}&rdquo;
            </p>
            <div className="flex gap-2 mt-2 flex-wrap">
              <Badge variant="outline" className="text-xs capitalize">{tone}</Badge>
              <Badge variant="outline" className="text-xs capitalize">{formalityLevel}</Badge>
              <Badge variant="outline" className="text-xs capitalize">{followupStyle} follow-up</Badge>
            </div>
          </div>

          <div className="flex justify-end">
            <Button onClick={handleIdentitySave} disabled={isPending} size="sm">
              {identitySaved ? <><Check className="h-3.5 w-3.5 mr-1.5" />Saved</> : "Save AI identity"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── Consent Status ──────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-4 w-4" />
            Consent &amp; Intake Status
          </CardTitle>
          <CardDescription>
            All widget submissions include TCPA-compliant consent language by default.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-lg border border-green-200 bg-green-50 dark:bg-green-950/20 dark:border-green-800 px-4 py-3 space-y-1">
            <div className="flex items-center gap-2">
              <Check className="h-4 w-4 text-green-600" />
              <p className="text-sm font-medium text-green-800 dark:text-green-300">TCPA consent language active</p>
            </div>
            <p className="text-xs text-green-700 dark:text-green-400 pl-6">
              Widget intake includes: &ldquo;By submitting, you agree to be contacted by a real estate professional via phone, email, or text.&rdquo;
            </p>
          </div>
          <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50 dark:bg-blue-950/20 dark:border-blue-800 px-4 py-3 space-y-1">
            <div className="flex items-center gap-2">
              <Check className="h-4 w-4 text-blue-600" />
              <p className="text-sm font-medium text-blue-800 dark:text-blue-300">Contact-first intake routing active</p>
            </div>
            <p className="text-xs text-blue-700 dark:text-blue-400 pl-6">
              Consented widget submissions create or update Contacts (not leads). Dedup runs before every insert.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

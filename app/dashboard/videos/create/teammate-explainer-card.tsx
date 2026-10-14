"use client"

/**
 * app/dashboard/videos/create/teammate-explainer-card.tsx
 *
 * TEAMMATE VIDEO lane — the video studio entry for avatar explainer videos
 * (D-ID avatar + ElevenLabs voice + Remotion brand frames; no HeyGen).
 *
 * The agent picks a TOPIC preset (topics only — the script is always
 * AI-authored in the brand voice and compliance-gated server-side) plus an
 * audience, and the commission rides the EXISTING pipeline: the project rows
 * land in the unified approval queue at pending_review before anything can
 * publish. Provider state is shown honestly: no D-ID key → the job parks at
 * "awaiting provider"; no voice clone → the stock-voice fallback is labeled.
 */

import { useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Users, Sparkles, Loader2, AlertTriangle, CheckCircle2, Clock, Mic } from "lucide-react"
import { cn } from "@/lib/utils"
import { AVATAR_EXPLAINER_PRESETS, type AvatarExplainerPreset } from "@/lib/video/avatar-explainer-presets"
import {
  createTeammateExplainerVideo,
  getTeammateExplainerReadiness,
  type TeammateExplainerReadinessResult,
} from "@/app/actions/avatar-video"

const VOICE_LABELS: Record<string, string> = {
  agent_clone: "Your ElevenLabs voice clone",
  brokerage_assistant: "Brokerage assistant voice (ElevenLabs)",
  stock_elevenlabs: "Stock ElevenLabs voice — no voice clone configured yet",
  did_default: "D-ID default voice — ElevenLabs is not configured",
}

const STATUS_LABELS: Record<string, string> = {
  remotion_pending: "Queued for rendering",
  rendering: "Rendering",
  generating: "Avatar rendering (D-ID)",
  completed: "Rendered — in approval queue",
  failed: "Failed",
  awaiting_provider: "Awaiting provider (D-ID not configured)",
  awaiting_presenter_setup: "Awaiting your avatar setup",
}

export function TeammateExplainerCard() {
  const [readinessResult, setReadinessResult] = useState<TeammateExplainerReadinessResult | null>(null)
  const [loadingReadiness, setLoadingReadiness] = useState(true)
  const [presetId, setPresetId] = useState<AvatarExplainerPreset["id"] | null>(null)
  const [topic, setTopic] = useState("")
  const [audience, setAudience] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [violations, setViolations] = useState<string[]>([])
  const [success, setSuccess] = useState<{ status: string; warnings: string[] } | null>(null)

  useEffect(() => {
    let cancelled = false
    getTeammateExplainerReadiness().then((r) => {
      if (!cancelled) {
        setReadinessResult(r)
        setLoadingReadiness(false)
      }
    })
    return () => { cancelled = true }
  }, [])

  const readiness = readinessResult?.readiness

  const selectPreset = (p: AvatarExplainerPreset) => {
    setPresetId(p.id)
    setTopic(p.topicSeed)
    setAudience((prev) => prev || p.defaultAudience)
    setSuccess(null)
    setError(null)
  }

  const handleSubmit = async () => {
    setSubmitting(true)
    setError(null)
    setViolations([])
    setSuccess(null)
    try {
      const res = await createTeammateExplainerVideo({ presetId, topic, audience })
      if (!res.success) {
        setError(res.error ?? "Could not create the video")
        setViolations(res.violations ?? [])
      } else {
        setSuccess({ status: res.status ?? "staged", warnings: res.warnings ?? [] })
        // Refresh the recent list so the new project shows immediately.
        getTeammateExplainerReadiness().then(setReadinessResult)
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Card className="border-primary/30">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Users className="h-5 w-5 text-primary" />
          <CardTitle>Teammate explainer video</CardTitle>
        </div>
        <CardDescription>
          Your AI teammate presents a short explainer on camera — script written in your brand
          voice, narrated with your voice clone, framed with your brand kit. Every video waits in
          the approval queue for your review before it can be published.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Provider posture — honest, never implied. */}
        {loadingReadiness ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Checking avatar + voice providers…
          </div>
        ) : readiness ? (
          <div className="flex flex-wrap gap-2">
            <Badge variant={readiness.didConfigured ? "default" : "destructive"}>
              {readiness.didConfigured ? "D-ID avatar engine: ready" : "D-ID avatar engine: not configured"}
            </Badge>
            <Badge variant={readiness.hasAvatar ? "default" : "secondary"}>
              {readiness.hasAvatar
                ? "Talking-head avatar: ready"
                : readiness.presenterReady
                  ? "Photo only (animated)"
                  : "Your avatar: not set up"}
            </Badge>
            <Badge variant={readiness.voiceSource === "agent_clone" ? "default" : "secondary"}>
              <Mic className="h-3 w-3 mr-1" />
              {VOICE_LABELS[readiness.voiceSource] ?? readiness.voiceSource}
            </Badge>
          </div>
        ) : (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>{readinessResult?.error ?? "Could not check provider status"}</AlertDescription>
          </Alert>
        )}

        {readiness && !readiness.didConfigured && (
          <Alert>
            <Clock className="h-4 w-4" />
            <AlertTitle>Avatar rendering unavailable right now</AlertTitle>
            <AlertDescription>
              The D-ID avatar provider is not configured. You can still queue this video — it will
              wait in an honest &ldquo;awaiting provider&rdquo; state and start rendering
              automatically once the provider is connected. Nothing is faked in the meantime.
            </AlertDescription>
          </Alert>
        )}
        {readiness && readiness.didConfigured && !readiness.presenterReady && (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              You have no avatar configured yet — finish Settings → Voice &amp; Avatar. If you queue
              a video now it will park and you will be notified to complete setup.
            </AlertDescription>
          </Alert>
        )}
        {/* Photo on file but no real talking-head avatar → the video will animate
            the still photo. Nudge the agent to set up the D-ID avatar. */}
        {readiness && readiness.didConfigured && readiness.presenterReady && !readiness.hasAvatar && (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Using your photo, not a talking-head avatar</AlertTitle>
            <AlertDescription>
              Only a still photo is on file, so this explainer will animate the photo. For a true
              talking-head avatar, set it up in{" "}
              <a href="/dashboard/settings/twin-studio" className="underline font-medium">Twin Studio</a>{" "}
              (upload a short video or photo → D-ID builds your avatar).
            </AlertDescription>
          </Alert>
        )}

        {/* Topic presets — TOPICS only; content is AI-authored per tenant. */}
        <div className="space-y-2">
          <Label>What should your teammate explain?</Label>
          <div className="grid grid-cols-2 gap-2">
            {AVATAR_EXPLAINER_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => selectPreset(p)}
                className={cn(
                  "rounded-md border p-3 text-left text-sm transition-colors",
                  presetId === p.id ? "border-primary bg-primary/5" : "border-border hover:border-primary/50",
                )}
              >
                <div className="font-medium">{p.label}</div>
                <div className="text-xs text-muted-foreground mt-1 line-clamp-2">{p.topicSeed}</div>
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="teammate-topic">Topic</Label>
          <Textarea
            id="teammate-topic"
            value={topic}
            onChange={(e) => { setTopic(e.target.value); setSuccess(null) }}
            placeholder="e.g. What an escalation clause actually does in a competitive offer"
            rows={2}
            maxLength={300}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="teammate-audience">Audience</Label>
          <Input
            id="teammate-audience"
            value={audience}
            onChange={(e) => { setAudience(e.target.value); setSuccess(null) }}
            placeholder="e.g. first-time buyers"
            maxLength={120}
          />
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Not created</AlertTitle>
            <AlertDescription>
              {error}
              {violations.length > 0 && (
                <ul className="list-disc pl-4 mt-2">
                  {violations.map((v, i) => (<li key={i}>{v}</li>))}
                </ul>
              )}
            </AlertDescription>
          </Alert>
        )}

        {success && (
          <Alert>
            <CheckCircle2 className="h-4 w-4" />
            <AlertTitle>
              {success.status === "awaiting_provider"
                ? "Queued — awaiting provider"
                : "Queued — your teammate is on it"}
            </AlertTitle>
            <AlertDescription>
              {success.status === "awaiting_provider"
                ? "The script was written and staged. Rendering starts as soon as the D-ID provider is configured."
                : "The script was written in your brand voice. The avatar render and brand-kit framing run next; the finished video appears in your approval queue for review before anything can publish."}
              {success.warnings.length > 0 && (
                <ul className="list-disc pl-4 mt-2">
                  {success.warnings.map((w, i) => (<li key={i}>{w}</li>))}
                </ul>
              )}
            </AlertDescription>
          </Alert>
        )}

        <Button onClick={handleSubmit} disabled={submitting || topic.trim().length < 3} className="w-full">
          {submitting ? (
            <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Writing script + queueing…</>
          ) : (
            <><Sparkles className="h-4 w-4 mr-2" /> Create teammate explainer</>
          )}
        </Button>

        {/* Recent lane projects — honest status per row. */}
        {(readinessResult?.recent?.length ?? 0) > 0 && (
          <div className="space-y-1 pt-1">
            <Label className="text-xs text-muted-foreground">Recent teammate videos</Label>
            {readinessResult!.recent!.map((r) => (
              <div key={r.id} className="flex items-center justify-between text-sm border-b border-border/50 py-1.5 last:border-0">
                <span className="truncate mr-3">{r.title ?? "Untitled"}</span>
                <Badge variant="outline" className="shrink-0">
                  {STATUS_LABELS[r.status ?? ""] ?? r.status ?? "—"}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

"use client"

// The door for app/actions/ai-agent-onboarding.ts:generateWelcomeMessage
// (wired lane E6 2026-08-28 — the action had no caller since the
// app/actions/index.ts barrel was deleted; the capability exists nowhere else,
// so per §1 it gets its smallest honest surface rather than a delete).
//
// Admin-side on purpose: this page is already gated to broker/admin, and the
// action re-checks that gate plus the tenant itself. The message is GENERATED
// AND SHOWN, never auto-sent — the admin reads it, edits it wherever they
// paste it, and owns the send. Nothing here writes.

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"
import { Loader2, Sparkles, Copy, Check } from "lucide-react"
import { generateWelcomeMessage } from "@/app/actions/ai-agent-onboarding"

export function WelcomeMessageCard({ agentId, agentName }: { agentId: string; agentName: string }) {
  const [isGenerating, setIsGenerating] = useState(false)
  const [message, setMessage] = useState<string>("")
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const handleGenerate = async () => {
    setIsGenerating(true)
    setError(null)
    try {
      const result = await generateWelcomeMessage(agentId)
      if (!result.success || !result.welcomeMessage) {
        setError(result.error ?? "Could not generate a welcome message")
        return
      }
      setMessage(result.welcomeMessage)
    } catch (err: any) {
      setError(err?.message ?? "Could not generate a welcome message")
    } finally {
      setIsGenerating(false)
    }
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard can be unavailable (permissions, non-secure context) — the
      // text is selectable in the box either way.
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="h-4 w-4" />
          AI Welcome Message
        </CardTitle>
        <CardDescription>
          Draft a personalized welcome for {agentName}. Nothing is sent — review it, then copy it
          into an email or message yourself.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button onClick={handleGenerate} disabled={isGenerating} size="sm" variant="outline">
          {isGenerating ? (
            <><Loader2 className="h-3 w-3 mr-2 animate-spin" />Generating…</>
          ) : message ? (
            <><Sparkles className="h-3 w-3 mr-2" />Regenerate</>
          ) : (
            <><Sparkles className="h-3 w-3 mr-2" />Generate welcome message</>
          )}
        </Button>
        {error && <p className="text-xs text-destructive">{error}</p>}
        {message && (
          <div className="space-y-2">
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={8}
              className="text-sm"
            />
            <Button onClick={handleCopy} size="sm" variant="ghost">
              {copied ? (
                <><Check className="h-3 w-3 mr-2" />Copied</>
              ) : (
                <><Copy className="h-3 w-3 mr-2" />Copy to clipboard</>
              )}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

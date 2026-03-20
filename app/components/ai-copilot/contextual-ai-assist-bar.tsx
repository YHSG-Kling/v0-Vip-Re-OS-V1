"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Sparkles, Check, AlertCircle, Copy, RotateCcw } from "lucide-react"
import { generateSmartResponse } from "@/app/actions/ai-communication-hub"
import { checkThemFirstCompliance } from "@/app/actions/ai-chat"
import { getBrandVoiceProfile } from "@/app/actions/ai-content-generation.tsx"
import { toast } from "sonner"

interface ContextualAiAssistBarProps {
  agentId: string
  context: {
    type: 'note' | 'message' | 'email' | 'social_post' | 'seller_update' | 'referral_ask' | 'review_request'
    contactName?: string
    propertyAddress?: string
    currentContent?: string
  }
  onAcceptDraft: (draft: string) => void
}

export function ContextualAiAssistBar({
  agentId,
  context,
  onAcceptDraft,
}: ContextualAiAssistBarProps) {
  const [expanded, setExpanded] = useState(false)
  const [draft, setDraft] = useState("")
  const [loading, setLoading] = useState(false)
  const [complianceResult, setComplianceResult] = useState<{
    passes: boolean
    message?: string
  } | null>(null)
  const [brandVoice, setBrandVoice] = useState<any>(null)

  const handleDraftForMe = async () => {
    setLoading(true)
    try {
      const profile = await getBrandVoiceProfile(agentId)
      setBrandVoice(profile)

      const prompt = `Write a ${context.type} for ${context.contactName || "a contact"}.${
        context.propertyAddress ? ` Property: ${context.propertyAddress}.` : ""
      }
      Make it professional, authentic, and personable.
      Tone: ${profile?.tone || "professional"}.
      Style: ${profile?.style || "clear"}.`

      const result = await generateSmartResponse({
        userMessage: prompt,
        brandVoice: profile,
      })

      setDraft(result)

      // Check compliance for customer-facing content
      if (
        context.type === "email" ||
        context.type === "seller_update" ||
        context.type === "referral_ask"
      ) {
        const compliance = await checkThemFirstCompliance(result)
        setComplianceResult({
          passes: compliance.passes,
          message: compliance.message,
        })
      }
    } catch (error) {
      console.error("Error generating draft:", error)
      toast.error("Failed to generate draft")
    } finally {
      setLoading(false)
    }
  }

  const handleImprove = async () => {
    if (!context.currentContent) return

    setLoading(true)
    try {
      const profile = await getBrandVoiceProfile(agentId)

      const result = await generateSmartResponse({
        userMessage: `Improve this ${context.type}: "${context.currentContent}"`,
        brandVoice: profile,
      })

      setDraft(result)
    } catch (error) {
      console.error("Error improving content:", error)
      toast.error("Failed to improve content")
    } finally {
      setLoading(false)
    }
  }

  const handleCheckCompliance = async () => {
    if (!context.currentContent) return

    try {
      const result = await checkThemFirstCompliance(context.currentContent)
      setComplianceResult(result)
    } catch (error) {
      console.error("Error checking compliance:", error)
      toast.error("Failed to check compliance")
    }
  }

  if (!expanded && !draft) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 mt-2"
      >
        <Sparkles className="h-3 w-3" />
        AI can help here
      </button>
    )
  }

  return (
    <div className="space-y-3 mt-3 p-3 bg-blue-50 rounded-lg border border-blue-100">
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-blue-600" />
        <span className="text-sm font-semibold">AI Assistant</span>
      </div>

      {!draft ? (
        <div className="flex gap-2 flex-wrap">
          <Button
            size="sm"
            variant="outline"
            onClick={handleDraftForMe}
            disabled={loading}
          >
            Draft for Me
          </Button>
          {context.currentContent && (
            <Button
              size="sm"
              variant="outline"
              onClick={handleImprove}
              disabled={loading}
            >
              Improve This
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={handleCheckCompliance}
            disabled={loading}
          >
            Check Compliance
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="text-sm"
            rows={4}
          />

          {complianceResult && (
            <div
              className={`flex items-start gap-2 text-xs p-2 rounded ${
                complianceResult.passes
                  ? "bg-green-50 text-green-700"
                  : "bg-amber-50 text-amber-700"
              }`}
            >
              {complianceResult.passes ? (
                <Check className="h-4 w-4 flex-shrink-0 mt-0.5" />
              ) : (
                <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
              )}
              <span>{complianceResult.message}</span>
            </div>
          )}

          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => onAcceptDraft(draft)}
              className="flex-1"
            >
              Use This
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                navigator.clipboard.writeText(draft)
                toast.success("Copied to clipboard")
              }}
            >
              <Copy className="h-4 w-4" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraft("")
                setComplianceResult(null)
              }}
            >
              <RotateCcw className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Sparkles, Check, AlertCircle, Copy, RotateCcw } from "lucide-react"
import { checkThemFirstCompliance } from "@/app/actions/ai-chat"
import { generateContextualDraft, generateSocialPostContent } from "@/app/actions/social/generate-social-post"
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
    violations?: string[]
  } | null>(null)

  const handleDraftForMe = async () => {
    setLoading(true)
    try {
      let text = ""
      if (context.type === "social_post") {
        const res = await generateSocialPostContent({
          brief: context.propertyAddress ? `Social post about ${context.propertyAddress}` : "Real estate social post",
          platform: "instagram",
          contentType: "market_update",
          agentId,
          brokerageId: "",
        })
        if (res.complianceBlocked) {
          setComplianceResult({
            passes: false,
            message: `Compliance violation: ${res.complianceViolations?.join("; ") ?? "content blocked"}`,
            violations: res.complianceViolations,
          })
          toast.error("Draft blocked by compliance rules")
          return
        }
        if (!res.success) {
          toast.error(res.error ?? "Failed to generate post")
          return
        }
        text = `${res.data?.content ?? ""}\n\n${(res.data?.hashtags ?? []).map((h: string) => `#${h}`).join(" ")}`
      } else {
        const res = await generateContextualDraft({
          agentId,
          contentType: context.type,
          contactName: context.contactName,
          propertyAddress: context.propertyAddress,
        })
        if (!res.success) {
          if (res.complianceViolations?.length) {
            setComplianceResult({
              passes: false,
              message: `Compliance violation: ${res.complianceViolations.join("; ")}`,
              violations: res.complianceViolations,
            })
            toast.error("Draft blocked by compliance rules")
          } else {
            toast.error(res.error ?? "Failed to generate draft")
          }
          return
        }
        text = res.draft ?? ""
      }

      setDraft(text)

      if (text && (context.type === "email" || context.type === "seller_update" || context.type === "referral_ask")) {
        const compliance = await checkThemFirstCompliance(text)
        setComplianceResult({ passes: compliance.passes, message: compliance.message })
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
      const res = await generateContextualDraft({
        agentId,
        contentType: context.type,
        contactName: context.contactName,
        propertyAddress: context.propertyAddress,
        currentContent: context.currentContent,
      })
      if (!res.success) {
        if (res.complianceViolations?.length) {
          setComplianceResult({
            passes: false,
            message: `Compliance violation: ${res.complianceViolations.join("; ")}`,
            violations: res.complianceViolations,
          })
          toast.error("Improved draft blocked by compliance rules")
        } else {
          toast.error(res.error ?? "Failed to improve content")
        }
        return
      }
      setDraft(res.draft ?? "")
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
              <div className="flex flex-col gap-1">
                <span>{complianceResult.message}</span>
                {!complianceResult.passes && complianceResult.violations && complianceResult.violations.length > 1 && (
                  <ul className="list-disc list-inside space-y-0.5">
                    {complianceResult.violations.map((v, i) => (
                      <li key={i}>{v}</li>
                    ))}
                  </ul>
                )}
              </div>
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

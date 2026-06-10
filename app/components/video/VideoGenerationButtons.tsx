"use client"

import { useState } from "react"
import { Video, Mic, ShieldCheck, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { generateVideoFromScript } from "@/app/actions/video-generation"
import { getAgentSettings } from "@/app/actions/agent-settings"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { toast } from "sonner"

interface VideoGenerationButtonsProps {
  script: string
  title: string
  userId?: string
  onSuccess?: () => void
  size?: "sm" | "md" | "lg"
  className?: string
}

export function VideoGenerationButtons({
  script,
  title,
  userId,
  onSuccess,
  size = "md",
  className = "",
}: VideoGenerationButtonsProps) {
  const [generating, setGenerating] = useState<"avatar" | "voice" | null>(null)
  const [complianceStatus, setComplianceStatus] = useState<"checking" | "pass" | "fail" | null>(null)
  const [complianceMessage, setComplianceMessage] = useState<string>("")

  const checkCompliance = async (text: string): Promise<boolean> => {
    setComplianceStatus("checking")
    setComplianceMessage("Checking Them-First compliance...")

    const forbiddenWords = ["guaranteed", "can't lose", "risk-free", "instant"]
    const foundForbidden = forbiddenWords.filter((word) => text.toLowerCase().includes(word))

    if (foundForbidden.length > 0) {
      setComplianceStatus("fail")
      setComplianceMessage(
        `❌ Non-compliant words found: ${foundForbidden.join(", ")}. Please remove these and try again.`,
      )
      return false
    }

    // Check for Them-First approach
    const hasThemFirst = /feel|understand|help|together|support|concern|need/i.test(text)
    if (!hasThemFirst) {
      setComplianceStatus("fail")
      setComplianceMessage("❌ Script needs more empathy. Use words like 'feel', 'understand', 'help', or 'support'.")
      return false
    }

    setComplianceStatus("pass")
    setComplianceMessage("✅ Content passed Them-First compliance check")
    return true
  }

  const handleGenerate = async (type: "avatar" | "voice") => {
    if (!script || !script.trim()) {
      toast.error("Script content required")
      return
    }

    // Check compliance first
    const isCompliant = await checkCompliance(script)
    if (!isCompliant) {
      return
    }

    setGenerating(type)

    try {
      // Get agent settings
      const settings = await getAgentSettings(userId || "")

      if (!settings?.avatarId || !settings?.voiceId) {
        toast.error("Avatar or voice not set up — visit Settings → Voice & Avatar (D-ID + ElevenLabs)")
        return
      }

      // Generate video
      const result = await generateVideoFromScript({
        script,
        title,
        type,
        avatarId: settings.avatarId,
        voiceId: settings.voiceId,
        userId,
      })

      if (result.success) {
        toast.success("Video queued for generation")
        onSuccess?.()
      } else {
        toast.error(result.error)
      }
    } catch (error) {
      console.error("[v0] Video generation error:", error)
      toast.error("Video generation failed")
    } finally {
      setGenerating(null)
      setTimeout(() => {
        setComplianceStatus(null)
        setComplianceMessage("")
      }, 3000)
    }
  }

  const buttonSize = size === "sm" ? "h-8 px-3 text-xs" : size === "lg" ? "h-11 px-6" : "h-9 px-4"
  const isDisabled = generating !== null || complianceStatus === "fail"

  return (
    <div className={`space-y-3 ${className}`}>
      {complianceStatus && (
        <Alert
          className={
            complianceStatus === "pass"
              ? "border-green-500 bg-green-50"
              : complianceStatus === "fail"
                ? "border-red-500 bg-red-50 text-red-900"
                : "border-blue-500 bg-blue-50"
          }
        >
          <ShieldCheck className={complianceStatus === "fail" ? "h-4 w-4 text-red-600" : "h-4 w-4"} />
          <AlertDescription className="text-sm font-medium">{complianceMessage}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap gap-3">
        <Button
          onClick={() => handleGenerate("avatar")}
          disabled={isDisabled}
          className={`${buttonSize} ${
            complianceStatus === "fail"
              ? "bg-gray-300 hover:bg-gray-300 text-gray-500 border-2 border-red-500 cursor-not-allowed"
              : "bg-blue-600 hover:bg-blue-700 text-white border-2 border-blue-700"
          }`}
        >
          {generating === "avatar" ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Generating...
            </>
          ) : (
            <>
              <Video className="h-4 w-4 mr-2" />
              Avatar Video
            </>
          )}
        </Button>

        <Button
          onClick={() => handleGenerate("voice")}
          disabled={isDisabled}
          className={`${buttonSize} ${
            complianceStatus === "fail"
              ? "bg-gray-300 hover:bg-gray-300 text-gray-500 border-2 border-red-500 cursor-not-allowed"
              : "bg-purple-600 hover:bg-purple-700 text-white border-2 border-purple-700"
          }`}
        >
          {generating === "voice" ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Generating...
            </>
          ) : (
            <>
              <Mic className="h-4 w-4 mr-2" />
              Voice Only
            </>
          )}
        </Button>

        {complianceStatus === "pass" && (
          <Badge variant="outline" className="border-green-500 text-green-700 bg-green-50">
            <ShieldCheck className="h-3 w-3 mr-1" />
            Compliant
          </Badge>
        )}
      </div>
    </div>
  )
}

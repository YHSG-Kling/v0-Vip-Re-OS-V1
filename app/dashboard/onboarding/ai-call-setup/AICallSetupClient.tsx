"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import { Phone, ArrowRight, CheckCircle } from "lucide-react"
import { saveAIIdentityProfile, type AIIdentityProfile } from "@/app/actions/ai-identity"
import { toast } from "sonner"

interface Props {
  brokerageId: string
  brokerageName: string
  existingProfile: AIIdentityProfile | null
}

export function AICallSetupClient({ brokerageId, brokerageName, existingProfile }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const [aiAnswerCalls, setAiAnswerCalls] = useState<boolean>(
    (existingProfile as any)?.ai_answer_calls ?? false
  )
  const [aiCallHandleInbound, setAiCallHandleInbound] = useState<boolean>(
    (existingProfile as any)?.ai_call_handle_inbound ?? true
  )
  const [aiCallHandleOutbound, setAiCallHandleOutbound] = useState<boolean>(
    (existingProfile as any)?.ai_call_handle_outbound ?? false
  )
  const [aiCallForwardNumber, setAiCallForwardNumber] = useState<string>(
    (existingProfile as any)?.ai_call_forward_number ?? ""
  )

  function handleSaveAndContinue() {
    if (aiAnswerCalls && !aiCallForwardNumber.trim()) {
      toast.error("Please enter a forward-to number before continuing.")
      return
    }

    startTransition(async () => {
      const result = await saveAIIdentityProfile({
        scopeType: "brokerage",
        scopeId: brokerageId,
        brokerageId,
        assistantName: existingProfile?.assistant_name ?? "AI Assistant",
        personaLabel: existingProfile?.persona_label ?? "AI Real Estate Specialist",
        tone: existingProfile?.tone ?? null,
        formalityLevel: existingProfile?.formality_level ?? null,
        objectionLibrary: existingProfile?.objection_library ?? [],
        faqKnowledge: existingProfile?.faq_knowledge ?? [],
        prohibitedLanguage: existingProfile?.prohibited_language ?? [],
        escalationRules: existingProfile?.escalation_rules ?? {},
        followupStyle: existingProfile?.followup_style ?? "warm_persistent",
        parentScopeId: null,
        aiAnswerCalls,
        aiCallHandleInbound,
        aiCallHandleOutbound,
        aiCallForwardNumber: aiCallForwardNumber.trim() || null,
      })

      if (!result.success) {
        toast.error(result.error ?? "Failed to save call settings")
        return
      }

      toast.success("Call handling preferences saved")
      router.push("/dashboard/onboarding")
    })
  }

  function handleSkip() {
    router.push("/dashboard/onboarding")
  }

  return (
    <div className="min-h-screen bg-muted/30 flex items-start justify-center pt-16 px-4">
      <div className="w-full max-w-xl space-y-6">
        {/* Header */}
        <div>
          <div className="flex items-center gap-2 text-primary mb-2">
            <Phone className="h-5 w-5" />
            <span className="text-sm font-medium uppercase tracking-wide">Onboarding</span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight">AI Call Handling</h1>
          <p className="text-muted-foreground mt-1">
            Do you want your AI to answer inbound calls or make outbound follow-up calls for{" "}
            {brokerageName}? You can change this anytime in AI Identity settings.
          </p>
        </div>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Phone className="h-5 w-5 text-primary" />
              <CardTitle className="text-base">Call handling preferences</CardTitle>
            </div>
            <CardDescription>
              These settings control how the AI behaves on phone calls.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {/* Master toggle */}
            <div className="flex items-center justify-between rounded-md border px-4 py-3">
              <div>
                <p className="font-medium text-sm">Enable AI call handling</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  AI will be available to answer and/or place calls.
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

                <div className="flex items-center justify-between rounded-md border px-4 py-3">
                  <div>
                    <p className="font-medium text-sm">Handle inbound calls</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      AI answers calls forwarded to your VAPI number.
                    </p>
                  </div>
                  <Switch
                    checked={aiCallHandleInbound}
                    onCheckedChange={setAiCallHandleInbound}
                    id="ai-inbound"
                  />
                </div>

                <div className="flex items-center justify-between rounded-md border px-4 py-3">
                  <div>
                    <p className="font-medium text-sm">Make outbound calls</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      AI places follow-up calls to leads and contacts.
                    </p>
                  </div>
                  <Switch
                    checked={aiCallHandleOutbound}
                    onCheckedChange={setAiCallHandleOutbound}
                    id="ai-outbound"
                  />
                </div>

                <Separator />

                <div className="space-y-2">
                  <Label htmlFor="forward-number">
                    Forward-to number <span className="text-destructive">*</span>
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    When a caller requests a human or the AI cannot handle the call, it will
                    transfer to this number. Use E.164 format, e.g. +14155552671.
                  </p>
                  <Input
                    id="forward-number"
                    type="tel"
                    placeholder="+14155552671"
                    value={aiCallForwardNumber}
                    onChange={(e) => setAiCallForwardNumber(e.target.value)}
                  />
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Actions */}
        <div className="flex items-center justify-between">
          <Button variant="ghost" onClick={handleSkip} disabled={isPending}>
            Skip for now
          </Button>
          <Button onClick={handleSaveAndContinue} disabled={isPending} className="gap-2">
            {isPending ? (
              "Saving..."
            ) : (
              <>
                Save and continue
                <ArrowRight className="h-4 w-4" />
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}

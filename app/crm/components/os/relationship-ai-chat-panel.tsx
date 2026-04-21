"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Sparkles, Loader2, Check, AlertTriangle, Copy, Send } from "lucide-react"
import {
  getAiSuggestions,
  acceptAiSuggestion,
  analyzeClientMessageTemperature,
  checkThemFirstCompliance,
  getChatTemplates,
} from "@/app/actions/ai-chat"
import { getBrandVoiceProfile } from "@/app/actions/ai-content-generation"
import { askRelationshipAI } from "@/app/crm/actions/ask-relationship-ai"

interface RelationshipAiChatPanelProps {
  contactId: string
  agentId: string
  contactName: string
  contactPersona?: string | null
  channel?: "sms" | "email" | "chat"
}

type DraftPurpose = "follow_up" | "check_in" | "seller_update" | "buyer_update" | "referral_ask" | "review_request"

export function RelationshipAiChatPanel({
  contactId,
  agentId,
  contactName,
  contactPersona,
  channel = "email",
}: RelationshipAiChatPanelProps) {
  const [mode, setMode] = useState<"draft" | "suggest" | "analyze">("draft")
  const [input, setInput] = useState("")
  const [draft, setDraft] = useState("")
  const [purpose, setPurpose] = useState<DraftPurpose>("follow_up")
  const [selectedChannel, setSelectedChannel] = useState<"sms" | "email" | "chat">(channel)
  const [loading, setLoading] = useState(false)
  const [brandVoice, setBrandVoice] = useState<any>(null)
  const [templates, setTemplates] = useState<any[]>([])
  const [complianceCheck, setComplianceCheck] = useState<{ passed: boolean; suggestion?: string } | null>(null)
  const [temperature, setTemperature] = useState<any>(null)
  const [suggestions, setSuggestions] = useState<any[]>([])

  // Load brand voice and templates on mount
  useEffect(() => {
    const loadInitialData = async () => {
      try {
        const [voiceResult, templatesResult] = await Promise.all([
          getBrandVoiceProfile(agentId),
          getChatTemplates({ category: "relationship" }),
        ])
        if (voiceResult.success) setBrandVoice(voiceResult.profile)
        if (Array.isArray(templatesResult)) setTemplates(templatesResult)
      } catch (err) {
        console.error("Failed to load AI data:", err)
      }
    }
    loadInitialData()
  }, [agentId])

  const handleDraft = async () => {
    setLoading(true)
    setComplianceCheck(null)
    try {
      // Build a context-rich question for the AI
      const channelInstructions =
        selectedChannel === "sms"
          ? "Keep it concise, under 160 characters."
          : selectedChannel === "email"
          ? "Write a well-structured email with a clear subject and call to action."
          : "Write a short, conversational message."

      const basePrompt = input
        ? `The agent has provided this context: ${input}\n\nChannel: ${selectedChannel}. ${channelInstructions}`
        : `Purpose: ${purpose.replace(/_/g, " ")}. Channel: ${selectedChannel}. Use a ${brandVoice?.tone || "professional"} tone. ${channelInstructions}`

      const draftPrompt = `You are helping a real estate agent write a message to send directly to a client named ${contactName}.

Context about this client: ${basePrompt}

Task: Write ONLY the text of the message the agent should send. Do not include subject lines, greetings like "Dear...", explanations, coaching notes, or meta-commentary. Write in a warm, professional first-person voice as the agent. Output only the message body, nothing else.`

      const result = await askRelationshipAI({
        question: draftPrompt,
        contactName,
        contactPersona,
        systemPrompt: `You are a professional message writer for a real estate agent. Write client-ready messages that the agent can send directly. Output ONLY the message body — no subject lines, no "Dear..." greetings, no coaching notes, no meta-commentary. Write in first-person as the agent in a warm, professional voice.`,
      })

      if (result.success && result.answer) {
        setDraft(result.answer)
        // Run compliance check
        const compliance = await checkThemFirstCompliance(result.answer)
        setComplianceCheck(compliance)
      } else {
        console.error("Draft generation failed:", result.error)
      }
    } catch (err) {
      console.error("Draft generation failed:", err)
    } finally {
      setLoading(false)
    }
  }

  const handleAnalyzeAndSuggest = async () => {
    setLoading(true)
    try {
      const [tempResult, suggestResult] = await Promise.all([
        analyzeClientMessageTemperature(input, contactId),
        getAiSuggestions(contactId),
      ])
      if (tempResult?.temperature) setTemperature(tempResult)
      if (Array.isArray(suggestResult)) setSuggestions(suggestResult)
    } catch (err) {
      console.error("Analysis failed:", err)
    } finally {
      setLoading(false)
    }
  }

  const handleAnalyzeOnly = async () => {
    setLoading(true)
    try {
      const result = await analyzeClientMessageTemperature(input, contactId)
      if (result?.temperature) setTemperature(result)
    } catch (err) {
      console.error("Temperature analysis failed:", err)
    } finally {
      setLoading(false)
    }
  }

  const handleAcceptSuggestion = async (suggestion: any) => {
    setDraft(suggestion.text)
    setMode("draft")
    await acceptAiSuggestion(suggestion.id)
  }

  const handleCopyDraft = () => {
    navigator.clipboard.writeText(draft)
  }

  const handleInsertTemplate = (template: any) => {
    setInput(template.content || template.text || "")
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-purple-600" />
          Relationship AI
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Tabs value={mode} onValueChange={(v) => setMode(v as any)}>
          <TabsList className="grid w-full grid-cols-3 mb-4">
            <TabsTrigger value="draft">Draft</TabsTrigger>
            <TabsTrigger value="suggest">Suggest Response</TabsTrigger>
            <TabsTrigger value="analyze">Analyze</TabsTrigger>
          </TabsList>

          {/* DRAFT MODE */}
          <TabsContent value="draft" className="space-y-4">
            <Select value={purpose} onValueChange={(v) => setPurpose(v as DraftPurpose)}>
              <SelectTrigger>
                <SelectValue placeholder="Select purpose" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="follow_up">Follow Up</SelectItem>
                <SelectItem value="check_in">Check In</SelectItem>
                <SelectItem value="seller_update">Seller Update</SelectItem>
                <SelectItem value="buyer_update">Buyer Update</SelectItem>
                <SelectItem value="referral_ask">Referral Ask</SelectItem>
                <SelectItem value="review_request">Review Request</SelectItem>
              </SelectContent>
            </Select>

            <Textarea
              placeholder="What context should the AI know? (optional)"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              rows={3}
            />

            <Button onClick={handleDraft} disabled={loading} className="w-full">
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Drafting...
                </>
              ) : (
                <>
                  <Sparkles className="h-4 w-4 mr-2" />
                  Draft for Me
                </>
              )}
            </Button>

            {draft && (
              <div className="space-y-3">
                <div className="bg-amber-50 border border-amber-200 rounded px-2 py-1.5 space-y-0.5">
                  <p className="text-xs font-semibold text-amber-700">
                    Message Draft — review and edit before sending
                  </p>
                  <p className="text-[11px] text-amber-600">
                    This draft was written for you to review. Edit it before sending.
                  </p>
                </div>
                <Textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={5}
                  className="font-medium"
                />

                {/* Compliance check result */}
                {complianceCheck && (
                  <div
                    className={`flex items-center gap-2 p-2 rounded-lg ${
                      complianceCheck.passed ? "bg-emerald-50" : "bg-amber-50"
                    }`}
                  >
                    {complianceCheck.passed ? (
                      <>
                        <Check className="h-4 w-4 text-emerald-600" />
                        <span className="text-sm text-emerald-700">Them First Compliant</span>
                      </>
                    ) : (
                      <>
                        <AlertTriangle className="h-4 w-4 text-amber-600" />
                        <span className="text-sm text-amber-700">{complianceCheck.suggestion}</span>
                      </>
                    )}
                  </div>
                )}

                <div className="flex gap-2">
                  <Select value={selectedChannel} onValueChange={(v) => setSelectedChannel(v as any)}>
                    <SelectTrigger className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="sms">SMS</SelectItem>
                      <SelectItem value="email">Email</SelectItem>
                      <SelectItem value="chat">Chat</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button variant="outline" size="sm" onClick={handleCopyDraft}>
                    <Copy className="h-4 w-4 mr-1" />
                    Copy Draft
                  </Button>
                  <Button size="sm">
                    <Send className="h-4 w-4 mr-1" />
                    Send
                  </Button>
                </div>
              </div>
            )}
          </TabsContent>

          {/* SUGGEST MODE */}
          <TabsContent value="suggest" className="space-y-4">
            <Textarea
              placeholder="Paste the message you received..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              rows={3}
            />

            <Button onClick={handleAnalyzeAndSuggest} disabled={loading || !input} className="w-full">
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Analyzing...
                </>
              ) : (
                "Analyze & Suggest"
              )}
            </Button>

            {temperature && (
              <div className="flex items-center gap-2">
                <Badge
                  className={
                    temperature.temperature === "hot"
                      ? "bg-red-100 text-red-700"
                      : temperature.temperature === "warm"
                      ? "bg-amber-100 text-amber-700"
                      : "bg-blue-100 text-blue-700"
                  }
                >
                  {temperature.temperature?.toUpperCase()} - {temperature.urgency}
                </Badge>
              </div>
            )}

            {suggestions.length > 0 && (
              <div className="space-y-2">
                {suggestions.map((s, idx) => (
                  <div
                    key={idx}
                    className="p-3 bg-gray-50 rounded-lg cursor-pointer hover:bg-gray-100"
                    onClick={() => handleAcceptSuggestion(s)}
                  >
                    <p className="text-sm">{s.text}</p>
                    <Button variant="ghost" size="sm" className="mt-2">
                      Use This
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </TabsContent>

          {/* ANALYZE MODE */}
          <TabsContent value="analyze" className="space-y-4">
            <Textarea
              placeholder="Paste a message to analyze..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              rows={3}
            />

            <Button onClick={handleAnalyzeOnly} disabled={loading || !input} className="w-full">
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Analyzing...
                </>
              ) : (
                "Analyze Temperature"
              )}
            </Button>

            {temperature && (
              <div className="p-3 bg-gray-50 rounded-lg space-y-2">
                <div className="flex gap-2">
                  <Badge>{temperature.temperature}</Badge>
                  <Badge variant="outline">{temperature.urgency}</Badge>
                </div>
                {temperature.tone && <p className="text-sm">Tone: {temperature.tone}</p>}
                {temperature.recommendedStyle && (
                  <p className="text-sm">Recommended: {temperature.recommendedStyle}</p>
                )}
                {temperature.riskSignals && temperature.riskSignals.length > 0 && (
                  <div className="text-sm text-amber-600">
                    Risks: {temperature.riskSignals.join(", ")}
                  </div>
                )}
              </div>
            )}
          </TabsContent>
        </Tabs>

        {/* Templates strip */}
        {templates.length > 0 && (
          <div className="mt-4 pt-3 border-t">
            <p className="text-xs text-muted-foreground mb-2">Quick Templates:</p>
            <div className="flex flex-wrap gap-1">
              {templates.slice(0, 5).map((t, idx) => (
                <Badge
                  key={idx}
                  variant="outline"
                  className="cursor-pointer hover:bg-gray-100"
                  onClick={() => handleInsertTemplate(t)}
                >
                  {t.name || t.title || `Template ${idx + 1}`}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Brain, Send, Loader2, Copy, CheckCircle2, MessageSquare, Users } from "lucide-react"
import { generateSmartResponse } from "@/app/actions/ai-communication-hub"
import { generateCoachingScenario, evaluatePracticeSession } from "@/app/actions/ai-training-coaching"

interface AiTutorPanelProps {
  agentId: string
  brokerageId: string
  currentContext?: string
}

const SUGGESTED_QUESTIONS = [
  "Explain the buyer consultation process",
  "What should I say when a seller wants to overprice?",
  "How does earnest money work?",
  "Walk me through a counter-offer scenario",
  "What compliance rules apply to disclosures?",
]

const SCENARIO_TYPES = [
  { value: "listing_presentation", label: "Listing Presentation" },
  { value: "buyer_consultation", label: "Buyer Consultation" },
  { value: "negotiation", label: "Negotiation" },
  { value: "objection_handling", label: "Objection Handling" },
  { value: "cold_calling", label: "Cold Calling" },
  { value: "fsbo_conversion", label: "FSBO Conversion" },
]

export function AiTutorPanel({ agentId, brokerageId, currentContext }: AiTutorPanelProps) {
  // Question mode state
  const [question, setQuestion] = useState("")
  const [response, setResponse] = useState("")
  const [loading, setLoading] = useState(false)

  // Scenario mode state
  const [scenarioType, setScenarioType] = useState<"listing_presentation" | "buyer_consultation" | "negotiation" | "objection_handling" | "cold_calling" | "fsbo_conversion">("objection_handling")
  const [difficulty, setDifficulty] = useState<"easy" | "medium" | "hard">("medium")
  const [scenario, setScenario] = useState<any>(null)
  const [agentResponse, setAgentResponse] = useState("")
  const [evaluation, setEvaluation] = useState<any>(null)
  const [scenarioLoading, setScenarioLoading] = useState(false)
  const [evaluating, setEvaluating] = useState(false)

  const handleAskQuestion = async () => {
    if (!question.trim()) return
    setLoading(true)
    setResponse("")
    try {
      // generateSmartResponse API expects: incomingMessage, contactId, agentId, brokerageId, channel, tone?, includeNextSteps?
      // We use chat channel for the tutor context and include the training context in the message itself
      const result = await generateSmartResponse({
        incomingMessage: `[Training Context: You are a real estate training expert. Answer clearly for a real estate agent. ${currentContext || ""}]\n\nQuestion: ${question}`,
        contactId: agentId, // Use agent as the contact for context
        agentId,
        brokerageId,
        channel: "chat",
        tone: "professional",
        includeNextSteps: true,
      })
      setResponse(result?.draft || "No response generated.")
    } catch (error) {
      console.error("Error asking question:", error)
      setResponse("An error occurred. Please try again.")
    } finally {
      setLoading(false)
    }
  }

  const handleSuggestedQuestion = (q: string) => {
    setQuestion(q)
  }

  const handleCopyResponse = () => {
    navigator.clipboard.writeText(response)
  }

  const handleGenerateScenario = async () => {
    setScenarioLoading(true)
    setScenario(null)
    setAgentResponse("")
    setEvaluation(null)
    try {
      const result = await generateCoachingScenario({
        agentId,
        brokerageId,
        scenarioType,
        difficulty,
      })
      setScenario(result?.scenario || null)
    } catch (error) {
      console.error("Error generating scenario:", error)
    } finally {
      setScenarioLoading(false)
    }
  }

  const handleEvaluateResponse = async () => {
    if (!scenario || !agentResponse.trim()) return
    setEvaluating(true)
    try {
      const result = await evaluatePracticeSession({
        agentId,
        brokerageId,
        scenarioId: scenario.id || scenarioType,
        response: agentResponse,
      })
      setEvaluation(result)
    } catch (error) {
      console.error("Error evaluating response:", error)
    } finally {
      setEvaluating(false)
    }
  }

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Brain className="h-5 w-5 text-purple-600" />
          AI Tutor
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="question" className="space-y-4">
          <TabsList className="w-full">
            <TabsTrigger value="question" className="flex-1">
              <MessageSquare className="h-4 w-4 mr-2" />
              Ask Questions
            </TabsTrigger>
            <TabsTrigger value="scenario" className="flex-1">
              <Users className="h-4 w-4 mr-2" />
              Practice Scenarios
            </TabsTrigger>
          </TabsList>

          {/* Question Mode */}
          <TabsContent value="question" className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-2 block">Ask about any process, step, or concept...</label>
              <div className="flex gap-2">
                <Input
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  placeholder="Type your question..."
                  onKeyDown={(e) => e.key === "Enter" && handleAskQuestion()}
                />
                <Button onClick={handleAskQuestion} disabled={loading || !question.trim()}>
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                </Button>
              </div>
            </div>

            {/* Suggested Questions */}
            <div>
              <p className="text-xs text-muted-foreground mb-2">Suggested questions:</p>
              <div className="flex flex-wrap gap-2">
                {SUGGESTED_QUESTIONS.map((q) => (
                  <Badge
                    key={q}
                    variant="outline"
                    className="cursor-pointer hover:bg-muted"
                    onClick={() => handleSuggestedQuestion(q)}
                  >
                    {q}
                  </Badge>
                ))}
              </div>
            </div>

            {/* Response */}
            {response && (
              <div className="p-4 bg-muted rounded-lg space-y-2">
                <div className="flex items-start justify-between">
                  <p className="text-sm whitespace-pre-wrap">{response}</p>
                  <Button size="sm" variant="ghost" onClick={handleCopyResponse}>
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </TabsContent>

          {/* Scenario Mode */}
          <TabsContent value="scenario" className="space-y-4">
            {/* Scenario Configuration */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium mb-2 block">Scenario Type</label>
                <Select value={scenarioType} onValueChange={(v) => setScenarioType(v as "listing_presentation" | "buyer_consultation" | "negotiation" | "objection_handling" | "cold_calling" | "fsbo_conversion")}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SCENARIO_TYPES.map((type) => (
                      <SelectItem key={type.value} value={type.value}>
                        {type.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-sm font-medium mb-2 block">Difficulty</label>
                <Select value={difficulty} onValueChange={(v) => setDifficulty(v as "easy" | "medium" | "hard")}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="easy">Easy</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="hard">Hard</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <Button onClick={handleGenerateScenario} disabled={scenarioLoading} className="w-full">
              {scenarioLoading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Generating Scenario...
                </>
              ) : (
                "Generate Scenario"
              )}
            </Button>

            {/* Scenario Display */}
            {scenario && (
              <div className="space-y-4">
                <div className="p-4 bg-purple-50 rounded-lg border border-purple-200">
                  <h4 className="font-medium text-purple-900 mb-2">{scenario.title || "Roleplay Scenario"}</h4>
                  <p className="text-sm text-purple-800">{scenario.setup || scenario.description}</p>
                  {scenario.client_persona && (
                    <div className="mt-2 text-xs text-purple-700">
                      <strong>Client:</strong> {scenario.client_persona}
                    </div>
                  )}
                </div>

                <div>
                  <label className="text-sm font-medium mb-2 block">Your Response</label>
                  <Textarea
                    value={agentResponse}
                    onChange={(e) => setAgentResponse(e.target.value)}
                    placeholder="Type how you would respond to this scenario..."
                    rows={4}
                  />
                </div>

                <Button
                  onClick={handleEvaluateResponse}
                  disabled={evaluating || !agentResponse.trim()}
                  className="w-full"
                >
                  {evaluating ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Evaluating...
                    </>
                  ) : (
                    "Evaluate Response"
                  )}
                </Button>

                {/* Evaluation Result */}
                {evaluation && (
                  <div className="p-4 bg-muted rounded-lg space-y-3">
                    {evaluation.score !== undefined && (
                      <div className="text-center">
                        <div className="text-3xl font-bold text-emerald-600">{evaluation.score}/100</div>
                        <div className="text-sm text-muted-foreground">Response Score</div>
                      </div>
                    )}
                    {evaluation.feedback && (
                      <div>
                        <h5 className="font-medium text-sm mb-1">Feedback</h5>
                        <p className="text-sm text-muted-foreground">{evaluation.feedback}</p>
                      </div>
                    )}
                    {evaluation.improvements?.length > 0 && (
                      <div>
                        <h5 className="font-medium text-sm mb-1">Areas to Improve</h5>
                        <ul className="text-sm text-muted-foreground space-y-1">
                          {evaluation.improvements.map((item: string, i: number) => (
                            <li key={i} className="flex items-start gap-2">
                              <CheckCircle2 className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
                              {item}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  )
}

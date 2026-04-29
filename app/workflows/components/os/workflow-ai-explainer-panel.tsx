"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Sparkles, Loader2, Copy, X, Send, CheckCircle2 } from "lucide-react"
import { generateSmartResponse } from "@/app/actions/ai-communication-hub"

interface SelectedExecution {
  id: string
  workflow_name: string
  error_message?: string
  status: string
  steps?: any[]
}

interface WorkflowAiExplainerPanelProps {
  agentId: string
  selectedExecution?: SelectedExecution | null
  onClearSelection: () => void
}

const PRESET_QUESTIONS = [
  "Why did this fail?",
  "What should I retry first?",
  "What records are affected?",
  "What is the safest next action?",
  "Explain what this automation does",
]

export function WorkflowAiExplainerPanel({
  agentId,
  selectedExecution,
  onClearSelection,
}: WorkflowAiExplainerPanelProps) {
  const [question, setQuestion] = useState("")
  const [explanation, setExplanation] = useState("")
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)

  const handleAskQuestion = async (q: string) => {
    if (!q.trim()) return
    setLoading(true)
    setExplanation("")

    try {
      const context = selectedExecution
        ? `Workflow: ${selectedExecution.workflow_name}\nStatus: ${selectedExecution.status}\n${
            selectedExecution.error_message ? `Error: ${selectedExecution.error_message}` : ""
          }`
        : "No specific workflow selected."

      const result = await (generateSmartResponse as any)({
        agentId,
        context: `${context}\n\nQuestion: ${q}`,
        systemPrompt:
          "You are an automation expert. The user is a real estate professional. Explain workflow failures in plain business language. Be concise and actionable.",
        type: "general",
      })

      if ((result as any).draft) {
        setExplanation((result as any).draft)
      } else {
        setExplanation("I couldn't generate an explanation. Please try again.")
      }
    } catch (error) {
      console.error("Error generating explanation:", error)
      setExplanation("Failed to generate explanation. Please try again.")
    } finally {
      setLoading(false)
    }
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(explanation)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-purple-600" />
          Ask AI About This Automation
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Context chip */}
        {selectedExecution && (
          <div className="flex items-center justify-between gap-2 rounded-md bg-purple-50 border border-purple-200 px-3 py-2">
            <div className="flex items-center gap-2 min-w-0">
              <Badge variant="outline" className="shrink-0">
                {selectedExecution.status}
              </Badge>
              <span className="text-sm font-medium truncate">{selectedExecution.workflow_name}</span>
            </div>
            <Button variant="ghost" size="sm" onClick={onClearSelection} className="shrink-0">
              <X className="h-4 w-4" />
            </Button>
          </div>
        )}

        {/* Preset questions */}
        <div className="flex flex-wrap gap-2">
          {PRESET_QUESTIONS.map((q) => (
            <Button
              key={q}
              variant="outline"
              size="sm"
              onClick={() => handleAskQuestion(q)}
              disabled={loading}
              className="text-xs"
            >
              {q}
            </Button>
          ))}
        </div>

        {/* Custom question input */}
        <div className="flex gap-2">
          <Input
            placeholder="Ask any automation question..."
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAskQuestion(question)}
            disabled={loading}
          />
          <Button onClick={() => handleAskQuestion(question)} disabled={loading || !question.trim()}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>

        {/* Response */}
        {explanation && (
          <div className="rounded-md bg-muted/50 border p-4 space-y-2">
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm whitespace-pre-wrap">{explanation}</p>
              <Button variant="ghost" size="sm" onClick={handleCopy} className="shrink-0">
                {copied ? <CheckCircle2 className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
          </div>
        )}

        {/* Empty state */}
        {!selectedExecution && !explanation && (
          <p className="text-sm text-muted-foreground text-center py-4">
            Select a workflow run to ask AI about it, or type any automation question above.
          </p>
        )}
      </CardContent>
    </Card>
  )
}

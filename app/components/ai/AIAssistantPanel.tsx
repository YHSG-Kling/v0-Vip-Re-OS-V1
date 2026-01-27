"use client"

import { useState } from "react"
import { Sparkles, X, Check, Loader2, Zap, TrendingUp } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

interface AISuggestion {
  id: string
  title: string
  description: string
  action: string
  confidence: number
  automationType: "instant" | "review" | "schedule"
  category: "contact" | "content" | "property" | "task"
  data?: any
}

interface AIAssistantPanelProps {
  suggestions: AISuggestion[]
  onApprove: (suggestion: AISuggestion) => Promise<void>
  onDismiss: (suggestionId: string) => void
  className?: string
}

export function AIAssistantPanel({ suggestions, onApprove, onDismiss, className }: AIAssistantPanelProps) {
  const [isOpen, setIsOpen] = useState(true)
  const [processingId, setProcessingId] = useState<string | null>(null)
  const [completedIds, setCompletedIds] = useState<Set<string>>(new Set())

  const handleApprove = async (suggestion: AISuggestion) => {
    setProcessingId(suggestion.id)
    try {
      await onApprove(suggestion)
      setCompletedIds((prev) => new Set(prev).add(suggestion.id))
      setTimeout(() => {
        onDismiss(suggestion.id)
      }, 2000)
    } catch (error) {
      console.error("[v0] Failed to process suggestion:", error)
    } finally {
      setProcessingId(null)
    }
  }

  if (!isOpen || suggestions.length === 0) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="fixed bottom-6 right-6 z-50 flex items-center gap-2 px-6 py-3 rounded-full gradient-ai text-white shadow-lg hover:scale-105 transition-transform ai-glow"
      >
        <Sparkles size={20} />
        <span className="font-semibold">{suggestions.length} AI Suggestions</span>
      </button>
    )
  }

  return (
    <div className={`fixed bottom-6 right-6 z-50 w-96 ${className}`}>
      <Card className="glass-morphism border-primary/20 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-white/10">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg gradient-ai">
              <Sparkles size={18} className="text-white" />
            </div>
            <div>
              <h3 className="font-semibold text-white">AI Assistant</h3>
              <p className="text-xs text-muted-foreground">Ready to automate {suggestions.length} tasks</p>
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={() => setIsOpen(false)} className="hover:bg-white/10">
            <X size={18} />
          </Button>
        </div>

        {/* Suggestions List */}
        <div className="max-h-[500px] overflow-y-auto p-4 space-y-3">
          {suggestions.map((suggestion) => {
            const isProcessing = processingId === suggestion.id
            const isCompleted = completedIds.has(suggestion.id)

            return (
              <div
                key={suggestion.id}
                className={`p-4 rounded-xl border transition-all ${
                  isCompleted
                    ? "bg-success/10 border-success/30"
                    : "bg-muted/50 border-white/10 hover:border-primary/30"
                }`}
              >
                {/* Category Badge */}
                <div className="flex items-start justify-between mb-2">
                  <Badge variant="secondary" className="text-xs">
                    {suggestion.category}
                  </Badge>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <TrendingUp size={12} />
                    <span>{suggestion.confidence}% confidence</span>
                  </div>
                </div>

                {/* Title & Description */}
                <h4 className="font-medium text-white mb-1">{suggestion.title}</h4>
                <p className="text-sm text-muted-foreground mb-3">{suggestion.description}</p>

                {/* Action Button */}
                {isCompleted ? (
                  <div className="flex items-center gap-2 text-success text-sm font-medium">
                    <Check size={16} />
                    <span>Completed</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <Button
                      onClick={() => handleApprove(suggestion)}
                      disabled={isProcessing}
                      className="flex-1 gradient-ai hover:opacity-90"
                      size="sm"
                    >
                      {isProcessing ? (
                        <>
                          <Loader2 size={14} className="animate-spin mr-2" />
                          Processing...
                        </>
                      ) : (
                        <>
                          <Zap size={14} className="mr-2" />
                          {suggestion.action}
                        </>
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onDismiss(suggestion.id)}
                      className="hover:bg-white/10"
                    >
                      Dismiss
                    </Button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </Card>
    </div>
  )
}

export default AIAssistantPanel

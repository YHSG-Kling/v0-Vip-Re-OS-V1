"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { CheckCircle2, Edit3, AlertCircle, Sparkles } from "lucide-react"

interface DescriptionApprovalCardProps {
  description: {
    id: string
    generated_text?: string
    generated_content?: any
    word_count?: number
    metadata?: {
      them_first_score?: number
      target_persona?: string
      seo_keywords?: string[]
      them_first_validation?: {
        passed: boolean
        recommendations?: string[]
      }
    }
    approval_status?: string
  }
  onApprove?: (id: string) => void
  onEdit?: (id: string, newText: string) => void
}

export function DescriptionApprovalCard({ description, onApprove, onEdit }: DescriptionApprovalCardProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [editedText, setEditedText] = useState("")

  const themFirstScore = description.metadata?.them_first_score || 0
  const validation = description.metadata?.them_first_validation
  const targetPersona = description.metadata?.target_persona || "General buyers"
  const seoKeywords = description.metadata?.seo_keywords || []

  // Get the text content
  const generatedText =
    description.generated_content?.medium_description ||
    description.generated_content?.standard ||
    description.generated_text ||
    ""

  const wordCount = description.word_count || generatedText.split(" ").length

  const handleEdit = () => {
    setEditedText(generatedText)
    setIsEditing(true)
  }

  const handleSaveEdit = () => {
    if (onEdit) {
      onEdit(description.id, editedText)
    }
    setIsEditing(false)
  }

  const handleApprove = () => {
    if (onApprove) {
      onApprove(description.id)
    }
  }

  const getScoreBadge = () => {
    const scorePercent = themFirstScore * 100

    if (scorePercent >= 85) {
      return (
        <Badge variant="default" className="bg-green-600">
          <CheckCircle2 className="mr-1 h-3 w-3" />
          Excellent: {scorePercent.toFixed(0)}%
        </Badge>
      )
    }

    if (scorePercent >= 70) {
      return (
        <Badge variant="secondary" className="bg-yellow-600 text-white">
          <AlertCircle className="mr-1 h-3 w-3" />
          Good: {scorePercent.toFixed(0)}%
        </Badge>
      )
    }

    return (
      <Badge variant="destructive">
        <AlertCircle className="mr-1 h-3 w-3" />
        Needs Work: {scorePercent.toFixed(0)}%
      </Badge>
    )
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            <CardTitle>AI-Generated Description</CardTitle>
          </div>
          {getScoreBadge()}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Description Text */}
        {isEditing ? (
          <div className="space-y-2">
            <Textarea
              value={editedText}
              onChange={(e) => setEditedText(e.target.value)}
              className="min-h-[200px] font-sans text-sm"
              placeholder="Edit the description..."
            />
            <div className="flex gap-2">
              <Button onClick={handleSaveEdit} size="sm">
                Save Changes
              </Button>
              <Button onClick={() => setIsEditing(false)} size="sm" variant="outline">
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="rounded-lg bg-muted p-4">
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{generatedText}</p>
          </div>
        )}

        {/* Metadata */}
        <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
          <span className="font-medium">{wordCount} words</span>
          <span>•</span>
          <span>Target: {targetPersona}</span>
          {seoKeywords.length > 0 && (
            <>
              <span>•</span>
              <span>{seoKeywords.length} SEO keywords</span>
            </>
          )}
        </div>

        {/* Validation Recommendations */}
        {validation && !validation.passed && validation.recommendations && (
          <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-3">
            <p className="mb-2 text-sm font-medium text-yellow-900">Recommendations:</p>
            <ul className="list-inside list-disc space-y-1 text-sm text-yellow-800">
              {validation.recommendations.map((rec, idx) => (
                <li key={idx}>{rec}</li>
              ))}
            </ul>
          </div>
        )}

        {/* SEO Keywords Preview */}
        {seoKeywords.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">SEO Keywords:</p>
            <div className="flex flex-wrap gap-2">
              {seoKeywords.slice(0, 6).map((keyword, idx) => (
                <Badge key={idx} variant="outline" className="text-xs">
                  {keyword}
                </Badge>
              ))}
              {seoKeywords.length > 6 && (
                <Badge variant="outline" className="text-xs">
                  +{seoKeywords.length - 6} more
                </Badge>
              )}
            </div>
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1 bg-transparent" onClick={handleEdit} disabled={isEditing}>
            <Edit3 className="mr-2 h-4 w-4" />
            Edit
          </Button>
          <Button className="flex-1" onClick={handleApprove} disabled={isEditing}>
            <CheckCircle2 className="mr-2 h-4 w-4" />
            Approve & Publish
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

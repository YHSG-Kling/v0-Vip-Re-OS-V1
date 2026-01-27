"use client"

import type React from "react"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Loader2, CheckCircle } from "lucide-react"

interface ProspectQuestionnaireProps {
  prospectId?: string
  onSave?: (contextId: string) => void
}

export function ProspectQuestionnaire({ prospectId, onSave }: ProspectQuestionnaireProps) {
  const [formData, setFormData] = useState({
    name: "",
    email: "",
    phone: "",
    emotion: "",
    situation: "",
    painPoint: "",
    timeline: "",
    lifeContext: "",
    whatHelps: "",
  })
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    setSuccess(false)

    try {
      // Create or get prospect
      let finalProspectId = prospectId

      if (!finalProspectId) {
        const prospectRes = await fetch("/api/prospects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: formData.name,
            email: formData.email,
            phone: formData.phone,
          }),
        })

        if (!prospectRes.ok) throw new Error("Failed to create prospect")
        const prospectData = await prospectRes.json()
        finalProspectId = prospectData.id
      }

      // Save context
      const contextRes = await fetch(`/api/prospects/${finalProspectId}/context`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          emotion: formData.emotion,
          situation: formData.situation,
          pain_point: formData.painPoint,
          timeline: formData.timeline,
          life_context: formData.lifeContext,
          what_helps: formData.whatHelps,
        }),
      })

      if (!contextRes.ok) throw new Error("Failed to save context")
      const contextData = await contextRes.json()

      setSuccess(true)
      if (onSave) onSave(contextData.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred")
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card className="w-full max-w-2xl">
      <CardHeader>
        <CardTitle>Prospect Understanding Questionnaire</CardTitle>
        <CardDescription>Help us understand your prospect better so we can create THEM-FIRST content</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-6">
          {!prospectId && (
            <div className="space-y-4 pb-4 border-b">
              <div className="space-y-2">
                <Label htmlFor="name">Prospect Name</Label>
                <Input
                  id="name"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="phone">Phone</Label>
                <Input
                  id="phone"
                  value={formData.phone}
                  onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                />
              </div>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="emotion">What emotion are they feeling?</Label>
            <Input
              id="emotion"
              placeholder="e.g., Anxious about finding the right home, Excited but overwhelmed"
              value={formData.emotion}
              onChange={(e) => setFormData({ ...formData, emotion: e.target.value })}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="situation">What's their current situation?</Label>
            <Textarea
              id="situation"
              placeholder="e.g., Growing family, need more space, currently renting"
              value={formData.situation}
              onChange={(e) => setFormData({ ...formData, situation: e.target.value })}
              required
              rows={3}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="painPoint">What's their biggest pain point?</Label>
            <Textarea
              id="painPoint"
              placeholder="e.g., Worried about finding a home in their budget with good schools"
              value={formData.painPoint}
              onChange={(e) => setFormData({ ...formData, painPoint: e.target.value })}
              required
              rows={3}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="timeline">What's their timeline?</Label>
            <Input
              id="timeline"
              placeholder="e.g., Need to move in 3 months, just starting to look"
              value={formData.timeline}
              onChange={(e) => setFormData({ ...formData, timeline: e.target.value })}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="lifeContext">What's happening in their life?</Label>
            <Textarea
              id="lifeContext"
              placeholder="e.g., New baby on the way, kids starting school, job relocation"
              value={formData.lifeContext}
              onChange={(e) => setFormData({ ...formData, lifeContext: e.target.value })}
              rows={3}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="whatHelps">What would help them most right now?</Label>
            <Textarea
              id="whatHelps"
              placeholder="e.g., Understanding the process, seeing options in their price range"
              value={formData.whatHelps}
              onChange={(e) => setFormData({ ...formData, whatHelps: e.target.value })}
              required
              rows={3}
            />
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {success && (
            <Alert>
              <CheckCircle className="h-4 w-4" />
              <AlertDescription>Prospect context saved successfully!</AlertDescription>
            </Alert>
          )}

          <Button type="submit" disabled={loading} className="w-full">
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save Prospect Context
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

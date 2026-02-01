"use client"

import type React from "react"
import { useState } from "react"
import {
  Sparkles,
  Mail,
  Edit3,
  RefreshCw,
  Copy,
  MapPin,
  Tag,
  LinkIcon,
  Loader2,
  AlertCircle,
  CheckCircle2,
  FileText,
  Video,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { VideoGenerationButtons } from "@/components/video/VideoGenerationButtons"
import type { InsiderEditInput, InsiderEditNewsletter, InsiderEditVibe, InsiderEditSection } from "@/types"
import { useAuth } from "@/contexts/AuthContext"

interface SectionEditState {
  sectionType: InsiderEditSection["sectionType"]
  isEditing: boolean
  tempContent: string
}

export const InsiderEditGenerator: React.FC = () => {
  const { user } = useAuth()
  const [formData, setFormData] = useState<InsiderEditInput>({
    zipCode: "",
    city: "",
    vibe: "family",
    listingUrl: "",
    pressureTestHighlights: ["", "", ""],
    agentPastToneContext: "",
  })

  const [newsletter, setNewsletter] = useState<InsiderEditNewsletter | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [sectionEdit, setSectionEdit] = useState<SectionEditState | null>(null)

  const vibeOptions: { value: InsiderEditVibe; label: string; description: string }[] = [
    { value: "family", label: "Family-Focused", description: "Schools, parks, community" },
    { value: "bachelor", label: "Bachelor/Young Professional", description: "Nightlife, walkability, dining" },
    { value: "investment", label: "Investment-Minded", description: "Appreciation potential, cash flow" },
    { value: "luxury", label: "Luxury/Upscale", description: "Amenities, exclusivity, prestige" },
    { value: "first_time", label: "First-Time Buyer", description: "Affordability, starter home vibe" },
  ]

  const handlePressureTestChange = (index: number, value: string) => {
    const updated = [...formData.pressureTestHighlights]
    updated[index] = value
    setFormData({ ...formData, pressureTestHighlights: updated })
  }

  const isFormValid = () => {
    return (
      formData.zipCode && formData.city && formData.listingUrl && formData.pressureTestHighlights.every((h) => h.trim())
    )
  }

  const handleGenerate = async () => {
    setError(null)
    setSuccess(null)
    setIsGenerating(true)

    try {
      const response = await fetch("/api/ai/insider-edit-generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...formData,
          createdByUserId: user?.id || "agent_1",
        }),
      })

      if (!response.ok) throw new Error("Failed to generate newsletter")

      const data = await response.json()
      setNewsletter(data)
      setSuccess("Newsletter generated successfully!")
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred")
    } finally {
      setIsGenerating(false)
    }
  }

  const handleSectionEdit = (sectionType: InsiderEditSection["sectionType"]) => {
    const section = newsletter?.sections.find((s) => s.sectionType === sectionType)
    if (section) {
      setSectionEdit({
        sectionType,
        isEditing: true,
        tempContent: section.editableContent,
      })
    }
  }

  const handleSectionSave = async () => {
    if (!sectionEdit || !newsletter) return

    try {
      setIsGenerating(true)
      const response = await fetch("/api/ai/insider-edit-rewrite-section", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          newsletterId: newsletter.id,
          sectionType: sectionEdit.sectionType,
          newContent: sectionEdit.tempContent,
        }),
      })

      if (!response.ok) throw new Error("Failed to update section")

      const updatedNewsletter = await response.json()
      setNewsletter(updatedNewsletter)
      setSectionEdit(null)
      setSuccess("Section updated!")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save section")
    } finally {
      setIsGenerating(false)
    }
  }

  const handleSave = async () => {
    if (!newsletter) return
    setIsSaving(true)

    try {
      const response = await fetch("/api/ai/insider-edit-save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newsletter),
      })

      if (!response.ok) throw new Error("Failed to save")
      setSuccess("Newsletter saved!")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save")
    } finally {
      setIsSaving(false)
    }
  }

  const handleCopyEmail = () => {
    if (newsletter?.emailHtml) {
      navigator.clipboard.writeText(newsletter.emailHtml)
      setSuccess("Email copied to clipboard!")
    }
  }

  return (
    <div className="h-screen overflow-hidden flex flex-col bg-gradient-to-br from-slate-50 to-slate-100">
      {/* Header */}
      <div className="border-b border-slate-200 bg-white shadow-sm p-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
              <Sparkles className="w-6 h-6 text-amber-600" />
              The Insider Edit
            </h1>
            <p className="text-sm text-slate-500">Curated opportunity newsletter generator</p>
          </div>
          <div className="flex gap-2">
            {newsletter && (
              <>
                <Button onClick={handleSave} disabled={isSaving} className="gap-2 bg-transparent" variant="outline">
                  {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
                  Save Draft
                </Button>
                <Button onClick={handleCopyEmail} className="gap-2 bg-amber-600 hover:bg-amber-700">
                  <Copy className="w-4 h-4" />
                  Copy Email
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Main Content - Split Screen */}
      <div className="flex-1 overflow-hidden flex gap-4 p-4">
        {/* Left Panel - Inputs */}
        <div className="w-1/3 overflow-y-auto space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Deal Setup</CardTitle>
              <CardDescription>Define the property and target audience</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Location */}
              <div className="space-y-2">
                <Label htmlFor="zipCode" className="flex items-center gap-2">
                  <MapPin className="w-4 h-4" /> ZIP Code
                </Label>
                <Input
                  id="zipCode"
                  placeholder="10001"
                  value={formData.zipCode}
                  onChange={(e) => setFormData({ ...formData, zipCode: e.target.value })}
                  disabled={!!newsletter}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="city">City</Label>
                <Input
                  id="city"
                  placeholder="New York"
                  value={formData.city}
                  onChange={(e) => setFormData({ ...formData, city: e.target.value })}
                  disabled={!!newsletter}
                />
              </div>

              {/* Vibe */}
              <div className="space-y-2">
                <Label htmlFor="vibe" className="flex items-center gap-2">
                  <Tag className="w-4 h-4" /> Neighborhood Vibe
                </Label>
                <Select
                  value={formData.vibe}
                  onValueChange={(v) => setFormData({ ...formData, vibe: v as InsiderEditVibe })}
                >
                  <SelectTrigger disabled={!!newsletter}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {vibeOptions.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        <div>
                          <div className="font-medium">{opt.label}</div>
                          <div className="text-xs text-slate-500">{opt.description}</div>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Listing URL */}
              <div className="space-y-2">
                <Label htmlFor="listingUrl" className="flex items-center gap-2">
                  <LinkIcon className="w-4 h-4" /> Listing URL
                </Label>
                <Input
                  id="listingUrl"
                  placeholder="https://www.zillow.com/..."
                  value={formData.listingUrl}
                  onChange={(e) => setFormData({ ...formData, listingUrl: e.target.value })}
                  disabled={!!newsletter}
                  type="url"
                />
              </div>
            </CardContent>
          </Card>

          {/* Pressure Test */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Pressure Test</CardTitle>
              <CardDescription>3 unique non-MLS highlights</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="space-y-1">
                  <Label className="text-sm">Highlight {i + 1} *</Label>
                  <Input
                    placeholder={
                      i === 0
                        ? "e.g., Gated community"
                        : i === 1
                          ? "e.g., Recently updated master bath"
                          : "e.g., Resort-style amenities"
                    }
                    value={formData.pressureTestHighlights[i]}
                    onChange={(e) => handlePressureTestChange(i, e.target.value)}
                    disabled={!!newsletter}
                  />
                </div>
              ))}
            </CardContent>
          </Card>

          {/* Optional Context */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Agent Tone Context (Optional)</CardTitle>
              <CardDescription className="text-xs">Your past emails for tone matching</CardDescription>
            </CardHeader>
            <CardContent>
              <Textarea
                placeholder="Paste an example of your past newsletter or email to match your unique voice..."
                value={formData.agentPastToneContext || ""}
                onChange={(e) => setFormData({ ...formData, agentPastToneContext: e.target.value })}
                disabled={!!newsletter}
                className="h-24 text-sm"
              />
            </CardContent>
          </Card>

          {/* Generate Button */}
          {!newsletter ? (
            <Button
              onClick={handleGenerate}
              disabled={!isFormValid() || isGenerating}
              className="w-full h-10 gap-2 bg-amber-600 hover:bg-amber-700"
            >
              {isGenerating ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Generating...
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  Generate Newsletter
                </>
              )}
            </Button>
          ) : (
            <Button
              onClick={() => {
                setNewsletter(null)
                setFormData({
                  zipCode: "",
                  city: "",
                  vibe: "family",
                  listingUrl: "",
                  pressureTestHighlights: ["", "", ""],
                })
              }}
              variant="outline"
              className="w-full"
            >
              <RefreshCw className="w-4 h-4 mr-2" />
              Start New
            </Button>
          )}

          {/* Messages */}
          {error && (
            <div className="flex gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              {error}
            </div>
          )}
          {success && (
            <div className="flex gap-2 p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm">
              <CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0" />
              {success}
            </div>
          )}
        </div>

        {/* Right Panel - Live Preview */}
        <div className="flex-1 overflow-y-auto">
          {!newsletter ? (
            <Card className="h-full flex items-center justify-center bg-white">
              <CardContent className="text-center space-y-4">
                <div className="w-16 h-16 bg-amber-100 rounded-full flex items-center justify-center mx-auto">
                  <Mail className="w-8 h-8 text-amber-600" />
                </div>
                <div>
                  <p className="text-lg font-semibold text-slate-900">No Newsletter Yet</p>
                  <p className="text-sm text-slate-500">Fill in the details and generate to see the preview</p>
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card className="bg-white h-full flex flex-col">
              <CardHeader className="border-b">
                <CardTitle className="flex items-center justify-between">
                  <span>Newsletter Preview</span>
                  <Badge variant={newsletter.status === "draft" ? "secondary" : "default"}>{newsletter.status}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="flex-1 overflow-y-auto p-6">
                <div className="max-w-2xl mx-auto space-y-6">
                  {/* Email Header */}
                  <div className="border-b pb-4">
                    <h2 className="text-2xl font-serif text-slate-900">{newsletter.title}</h2>
                    <p className="text-sm text-slate-500 mt-1">{newsletter.emailPreviewText}</p>
                  </div>

                  {/* Sections with Edit Buttons */}
                  {newsletter.sections.map((section) => (
                    <div key={section.sectionType} className="space-y-2">
                      <div className="flex items-center justify-between">
                        <h3 className="text-lg font-serif text-slate-900">{section.title}</h3>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleSectionEdit(section.sectionType)}
                          className="gap-1 text-amber-600 hover:text-amber-700 hover:bg-amber-50"
                        >
                          <Edit3 className="w-4 h-4" />
                          Edit
                        </Button>
                      </div>
                      <div className="prose prose-sm max-w-none text-slate-700 whitespace-pre-wrap">
                        {sectionEdit?.sectionType === section.sectionType ? (
                          <div className="space-y-2">
                            <Textarea
                              value={sectionEdit.tempContent}
                              onChange={(e) => setSectionEdit({ ...sectionEdit, tempContent: e.target.value })}
                              className="min-h-[150px]"
                            />
                            <div className="flex gap-2">
                              <Button
                                size="sm"
                                onClick={handleSectionSave}
                                disabled={isGenerating}
                                className="bg-amber-600 hover:bg-amber-700"
                              >
                                {isGenerating ? <Loader2 className="w-4 h-4 animate-spin" /> : "Save"}
                              </Button>
                              <Button size="sm" variant="outline" onClick={() => setSectionEdit(null)}>
                                Cancel
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <p>{section.editableContent}</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
              <div className="mt-6 p-4 bg-muted/30 rounded-lg border">
                <h3 className="text-lg font-semibold mb-3 flex items-center gap-2">
                  <Video className="h-5 w-5 text-primary" />
                  Convert Newsletter to Video
                </h3>
                <VideoGenerationButtons
                  script={newsletter.sections.map((s) => s.content).join("\n\n")}
                  title={`Insider Edit - ${formData.city}`}
                  userId={user?.id}
                />
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}

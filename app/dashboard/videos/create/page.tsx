"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  Video,
  Home,
  User,
  TrendingUp,
  Users,
  FileText,
  Sparkles,
  Wand2,
  Play,
  Loader2,
  ArrowLeft,
  ArrowRight,
  Check,
  RefreshCw,
  Save,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Shield,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { useAuth } from "@/lib/auth/client"
import { createClient } from "@/lib/supabase/client"

// ─── SCRIPT TYPES ────────────────────────────────────────────────────────────

const SCRIPT_TYPES = [
  {
    id: "property_tour",
    label: "Property Tour",
    icon: Home,
    description: "Showcase a listing with engaging narration",
    requiresListing: true,
  },
  {
    id: "buyer_education",
    label: "Buyer Education",
    icon: Users,
    description: "Educational content for home buyers",
    requiresListing: false,
  },
  {
    id: "market_update",
    label: "Market Update",
    icon: TrendingUp,
    description: "Local market analysis and trends",
    requiresListing: false,
  },
  {
    id: "agent_intro",
    label: "Agent Introduction",
    icon: User,
    description: "Personal brand introduction video",
    requiresListing: false,
  },
  {
    id: "listing_presentation",
    label: "Listing Presentation",
    icon: FileText,
    description: "Seller presentation for listing appointments",
    requiresListing: true,
  },
]

const BRAND_VOICE_TONES = [
  { id: "professional", label: "Professional", description: "Authoritative and polished" },
  { id: "friendly", label: "Friendly", description: "Warm and approachable" },
  { id: "energetic", label: "Energetic", description: "Dynamic and enthusiastic" },
  { id: "educational", label: "Educational", description: "Informative and patient" },
  { id: "luxury", label: "Luxury", description: "Sophisticated and exclusive" },
]

const DURATION_OPTIONS = [
  { seconds: 30, label: "30 seconds", words: "~75 words" },
  { seconds: 60, label: "1 minute", words: "~150 words" },
  { seconds: 90, label: "90 seconds", words: "~225 words" },
  { seconds: 120, label: "2 minutes", words: "~300 words" },
  { seconds: 180, label: "3 minutes", words: "~450 words" },
]

// ─── COMPONENT ───────────────────────────────────────────────────────────────

export default function VideoScriptCreatePage() {
  const router = useRouter()
  const { user, brokerage } = useAuth()
  const supabase = createClient()

  // Wizard state
  const [currentStep, setCurrentStep] = useState(1)
  const [isGenerating, setIsGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Form state
  const [scriptType, setScriptType] = useState<string>("")
  const [selectedTemplate, setSelectedTemplate] = useState<string>("")
  const [selectedListing, setSelectedListing] = useState<string>("")
  const [selectedContact, setSelectedContact] = useState<string>("")
  const [brandVoiceTone, setBrandVoiceTone] = useState<string>("professional")
  const [durationTarget, setDurationTarget] = useState<number>(90)
  const [customContext, setCustomContext] = useState<string>("")
  const [title, setTitle] = useState<string>("")

  // Generated script state
  const [generatedScript, setGeneratedScript] = useState<string>("")
  const [complianceIssues, setComplianceIssues] = useState<string[]>([])
  const [approvalStatus, setApprovalStatus] = useState<string>("draft")
  const [savedScriptId, setSavedScriptId] = useState<string | null>(null)

  // Data
  const [templates, setTemplates] = useState<any[]>([])
  const [listings, setListings] = useState<any[]>([])
  const [contacts, setContacts] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  // Word count
  const wordCount = generatedScript.split(/\s+/).filter(Boolean).length
  const estimatedDuration = Math.ceil(wordCount / 2.5)

  // ─── Load Data ─────────────────────────────────────────────────────────────

  useEffect(() => {
    async function loadData() {
      if (!brokerage?.id) return

      try {
        // Load templates
        const { data: templatesData } = await supabase
          .from("video_templates")
          .select("*")
          .eq("is_active", true)
          .order("sort_order")

        setTemplates(templatesData || [])

        // Load listings
        const { data: listingsData } = await supabase
          .from("listings")
          .select("id, address, city, state, list_price")
          .eq("brokerage_id", brokerage.id)
          .in("status", ["active", "coming_soon", "pending"])
          .order("created_at", { ascending: false })
          .limit(50)

        setListings(listingsData || [])

        // Load contacts
        const { data: contactsData } = await supabase
          .from("contacts")
          .select("id, first_name, last_name, contact_type")
          .eq("brokerage_id", brokerage.id)
          .order("created_at", { ascending: false })
          .limit(50)

        setContacts(contactsData || [])
      } catch (err) {
        console.error("Error loading data:", err)
      } finally {
        setLoading(false)
      }
    }

    loadData()
  }, [brokerage?.id, supabase])

  // ─── Filter templates by script type ───────────────────────────────────────

  const filteredTemplates = templates.filter(
    (t) => !scriptType || t.recommended_for?.includes(scriptType)
  )

  // ─── Prefill from template ─────────────────────────────────────────────────

  useEffect(() => {
    if (selectedTemplate) {
      const template = templates.find((t) => t.id === selectedTemplate)
      if (template) {
        if (template.duration_seconds) {
          setDurationTarget(template.duration_seconds)
        }
        if (template.default_script) {
          setCustomContext(template.default_script)
        }
      }
    }
  }, [selectedTemplate, templates])

  // ─── Generate Script ───────────────────────────────────────────────────────

  async function handleGenerateScript() {
    if (!brokerage?.id || !scriptType) return

    setIsGenerating(true)
    setError(null)

    try {
      const response = await fetch("/api/ai/generate-video-script", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          script_type: scriptType,
          listing_id: selectedListing || null,
          contact_id: selectedContact || null,
          template_id: selectedTemplate || null,
          agent_id: user?.id,
          brokerage_id: brokerage.id,
          custom_context: customContext,
          brand_voice_tone: brandVoiceTone,
          duration_target_seconds: durationTarget,
          save_to_library: true,
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || "Failed to generate script")
      }

      setGeneratedScript(data.script)
      setComplianceIssues(data.compliance_issues || [])
      setApprovalStatus(data.approval_status || "draft")
      setSavedScriptId(data.script_id)
      setCurrentStep(3)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setIsGenerating(false)
    }
  }

  // ─── Regenerate Script ─────────────────────────────────────────────────────

  async function handleRegenerateScript() {
    setGeneratedScript("")
    setComplianceIssues([])
    setSavedScriptId(null)
    await handleGenerateScript()
  }

  // ─── Save Edited Script ────────────────────────────────────────────────────

  async function handleSaveScript() {
    if (!savedScriptId) return

    try {
      const response = await fetch("/api/video-scripts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: savedScriptId,
          script_content: generatedScript,
          title: title || `${scriptType.replace(/_/g, " ")} Script`,
        }),
      })

      if (!response.ok) {
        throw new Error("Failed to save script")
      }

      router.push("/dashboard/videos/library")
    } catch (err: any) {
      setError(err.message)
    }
  }

  // ─── Steps ─────────────────────────────────────────────────────────────────

  const steps = [
    { number: 1, label: "Script Type" },
    { number: 2, label: "Configure" },
    { number: 3, label: "Review & Edit" },
  ]

  const canProceed = () => {
    switch (currentStep) {
      case 1:
        return !!scriptType
      case 2:
        const typeConfig = SCRIPT_TYPES.find((t) => t.id === scriptType)
        if (typeConfig?.requiresListing && !selectedListing) return false
        return true
      default:
        return true
    }
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto py-8 px-4 max-w-4xl">
        {/* Header */}
        <div className="mb-8">
          <Button variant="outline" onClick={() => router.back()} className="mb-4">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back
          </Button>
          <h1 className="text-3xl font-bold text-foreground">Create Video Script</h1>
          <p className="text-muted-foreground mt-1">
            Generate AI-powered scripts with kernel compliance governance
          </p>
        </div>

        {/* Progress Steps */}
        <div className="mb-8">
          <div className="flex items-center justify-between">
            {steps.map((step, index) => (
              <div key={step.number} className="flex items-center">
                <div
                  className={cn(
                    "w-10 h-10 rounded-full flex items-center justify-center text-sm font-medium transition-colors",
                    currentStep > step.number
                      ? "bg-green-600 text-white"
                      : currentStep === step.number
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground"
                  )}
                >
                  {currentStep > step.number ? <Check className="h-5 w-5" /> : step.number}
                </div>
                {index < steps.length - 1 && (
                  <div
                    className={cn(
                      "w-24 md:w-40 h-1 mx-2",
                      currentStep > step.number ? "bg-green-600" : "bg-muted"
                    )}
                  />
                )}
              </div>
            ))}
          </div>
          <div className="flex justify-between mt-2 px-1">
            {steps.map((step) => (
              <span
                key={step.number}
                className={cn(
                  "text-xs",
                  currentStep >= step.number ? "text-foreground" : "text-muted-foreground"
                )}
              >
                {step.label}
              </span>
            ))}
          </div>
        </div>

        {/* Error Alert */}
        {error && (
          <Alert variant="destructive" className="mb-6">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Error</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {/* Step Content */}
        <Card className="mb-6">
          <CardContent className="p-6">
            {/* Step 1: Script Type Selection */}
            {currentStep === 1 && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-xl font-semibold mb-2">Select Script Type</h2>
                  <p className="text-muted-foreground">
                    Choose the type of video script you want to generate
                  </p>
                </div>

                <RadioGroup
                  value={scriptType}
                  onValueChange={setScriptType}
                  className="grid grid-cols-1 md:grid-cols-2 gap-4"
                >
                  {SCRIPT_TYPES.map((type) => (
                    <Label
                      key={type.id}
                      htmlFor={type.id}
                      className={cn(
                        "flex items-start gap-4 p-4 rounded-lg border-2 cursor-pointer transition-colors",
                        scriptType === type.id
                          ? "border-primary bg-primary/5"
                          : "border-border hover:border-primary/50"
                      )}
                    >
                      <RadioGroupItem value={type.id} id={type.id} className="mt-1" />
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <type.icon className="h-5 w-5 text-muted-foreground" />
                          <span className="font-medium">{type.label}</span>
                        </div>
                        <p className="text-sm text-muted-foreground mt-1">{type.description}</p>
                        {type.requiresListing && (
                          <Badge variant="secondary" className="mt-2 text-xs">
                            Requires Listing
                          </Badge>
                        )}
                      </div>
                    </Label>
                  ))}
                </RadioGroup>
              </div>
            )}

            {/* Step 2: Configuration */}
            {currentStep === 2 && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-xl font-semibold mb-2">Configure Your Script</h2>
                  <p className="text-muted-foreground">
                    Customize the script generation settings
                  </p>
                </div>

                {/* Template Selection */}
                {filteredTemplates.length > 0 && (
                  <div className="space-y-2">
                    <Label>Template (Optional)</Label>
                    <Select value={selectedTemplate} onValueChange={setSelectedTemplate}>
                      <SelectTrigger>
                        <SelectValue placeholder="Start from scratch or use a template" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="">No template - custom script</SelectItem>
                        {filteredTemplates.map((template) => (
                          <SelectItem key={template.id} value={template.id}>
                            {template.template_name}
                            {template.duration_seconds && (
                              <span className="text-muted-foreground ml-2">
                                ({template.duration_seconds}s)
                              </span>
                            )}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {/* Listing Selection */}
                {SCRIPT_TYPES.find((t) => t.id === scriptType)?.requiresListing && (
                  <div className="space-y-2">
                    <Label>
                      Select Listing <span className="text-red-500">*</span>
                    </Label>
                    <Select value={selectedListing} onValueChange={setSelectedListing}>
                      <SelectTrigger>
                        <SelectValue placeholder="Choose a listing" />
                      </SelectTrigger>
                      <SelectContent>
                        {listings.map((listing) => (
                          <SelectItem key={listing.id} value={listing.id}>
                            {listing.address}, {listing.city} - $
                            {listing.list_price?.toLocaleString()}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {/* Contact Selection (optional) */}
                <div className="space-y-2">
                  <Label>Target Contact (Optional)</Label>
                  <Select value={selectedContact} onValueChange={setSelectedContact}>
                    <SelectTrigger>
                      <SelectValue placeholder="Personalize for a specific contact" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">No specific contact</SelectItem>
                      {contacts.map((contact) => (
                        <SelectItem key={contact.id} value={contact.id}>
                          {contact.first_name} {contact.last_name}
                          {contact.contact_type && (
                            <span className="text-muted-foreground ml-2">
                              ({contact.contact_type})
                            </span>
                          )}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Brand Voice Tone */}
                <div className="space-y-2">
                  <Label>Brand Voice Tone</Label>
                  <Select value={brandVoiceTone} onValueChange={setBrandVoiceTone}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {BRAND_VOICE_TONES.map((tone) => (
                        <SelectItem key={tone.id} value={tone.id}>
                          {tone.label} - {tone.description}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Duration */}
                <div className="space-y-2">
                  <Label>Target Duration</Label>
                  <Select
                    value={durationTarget.toString()}
                    onValueChange={(v) => setDurationTarget(parseInt(v))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DURATION_OPTIONS.map((opt) => (
                        <SelectItem key={opt.seconds} value={opt.seconds.toString()}>
                          {opt.label} ({opt.words})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Custom Context */}
                <div className="space-y-2">
                  <Label>Additional Context (Optional)</Label>
                  <Textarea
                    value={customContext}
                    onChange={(e) => setCustomContext(e.target.value)}
                    placeholder="Add any specific details, talking points, or context you want included..."
                    rows={4}
                  />
                </div>
              </div>
            )}

            {/* Step 3: Review & Edit */}
            {currentStep === 3 && (
              <div className="space-y-6">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-xl font-semibold mb-1">Review Your Script</h2>
                    <p className="text-muted-foreground">
                      Edit as needed before saving to your library
                    </p>
                  </div>
                  <Badge
                    variant={
                      approvalStatus === "approved"
                        ? "default"
                        : approvalStatus === "pending_review"
                          ? "secondary"
                          : "outline"
                    }
                    className={cn(
                      approvalStatus === "approved" && "bg-green-600",
                      approvalStatus === "pending_review" && "bg-amber-500 text-white"
                    )}
                  >
                    {approvalStatus === "approved" && <CheckCircle2 className="h-3 w-3 mr-1" />}
                    {approvalStatus === "pending_review" && <Clock className="h-3 w-3 mr-1" />}
                    {approvalStatus === "draft" && <Shield className="h-3 w-3 mr-1" />}
                    {approvalStatus.replace(/_/g, " ")}
                  </Badge>
                </div>

                {/* Compliance Issues */}
                {complianceIssues.length > 0 && (
                  <Alert variant="destructive">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertTitle>Compliance Review Required</AlertTitle>
                    <AlertDescription>
                      <ul className="list-disc list-inside mt-2 space-y-1">
                        {complianceIssues.map((issue, i) => (
                          <li key={i} className="text-sm">
                            {issue}
                          </li>
                        ))}
                      </ul>
                    </AlertDescription>
                  </Alert>
                )}

                {/* Title */}
                <div className="space-y-2">
                  <Label>Script Title</Label>
                  <Input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Enter a title for this script"
                  />
                </div>

                {/* Script Editor */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>Script Content</Label>
                    <div className="flex items-center gap-4 text-sm text-muted-foreground">
                      <span>{wordCount} words</span>
                      <span>~{estimatedDuration}s</span>
                    </div>
                  </div>
                  <Textarea
                    value={generatedScript}
                    onChange={(e) => setGeneratedScript(e.target.value)}
                    rows={16}
                    className="font-mono text-sm"
                  />
                </div>

                {/* Actions */}
                <div className="flex items-center gap-4">
                  <Button variant="outline" onClick={handleRegenerateScript} disabled={isGenerating}>
                    <RefreshCw className={cn("h-4 w-4 mr-2", isGenerating && "animate-spin")} />
                    Regenerate
                  </Button>
                  <Button onClick={handleSaveScript} disabled={!generatedScript}>
                    <Save className="h-4 w-4 mr-2" />
                    Save to Library
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Navigation */}
        {currentStep < 3 && (
          <div className="flex items-center justify-between">
            <Button
              variant="outline"
              onClick={() => setCurrentStep((s) => Math.max(1, s - 1))}
              disabled={currentStep === 1}
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back
            </Button>

            {currentStep === 2 ? (
              <Button onClick={handleGenerateScript} disabled={!canProceed() || isGenerating}>
                {isGenerating ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Generating...
                  </>
                ) : (
                  <>
                    <Wand2 className="h-4 w-4 mr-2" />
                    Generate Script
                  </>
                )}
              </Button>
            ) : (
              <Button onClick={() => setCurrentStep((s) => s + 1)} disabled={!canProceed()}>
                Next
                <ArrowRight className="h-4 w-4 ml-2" />
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

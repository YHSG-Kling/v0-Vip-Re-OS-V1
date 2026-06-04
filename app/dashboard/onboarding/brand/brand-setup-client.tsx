"use client"

// ============================================================
// SYSTEM: L11-S02 — Brand Setup Wizard Client Component
// VIP Real Estate AI OS — Layer 11
// ============================================================
// 6-step wizard with split-panel layout and live preview

import { useState, useCallback, useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import useSWR, { mutate } from "swr"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Separator } from "@/components/ui/separator"
import { toast } from "sonner"
import {
  Check,
  Upload,
  Palette,
  Type,
  MessageSquare,
  FileText,
  Eye,
  Rocket,
  Loader2,
  X,
  Copy,
  AlertCircle,
  Sparkles,
} from "lucide-react"
import {
  saveBrandColors,
  saveBrandTypography,
  saveBrandVoice,
  saveTemplate,
  publishBrand,
  uploadLogo,
  type BrandSetupStatus,
} from "@/app/actions/onboarding/brand"
import { createClient } from "@/lib/supabase/client"
import confetti from "canvas-confetti"

// ─── TYPES ────────────────────────────────────────────────────────────────────

interface BrandSetupClientProps {
  userId: string
  brokerageId: string
  brokerageName: string
  brokeragePhone: string
  brokerageEmail: string
  agentName: string
  agentEmail: string
  /** Wave 34 — agent's personal real-estate website. Optional. When set,
   *  the platform uses it as the canonical embed/CSP origin for
   *  /embed/blog and as the byline link on hosted /blog/[slug] pages. */
  agentPersonalWebsite?: string
  initialStatus: BrandSetupStatus | null
}

const STEP_LABELS = [
  { label: "Colors + Logo", icon: Palette, step: 1 },
  { label: "Typography", icon: Type, step: 2 },
  { label: "Voice + Tone", icon: MessageSquare, step: 3 },
  { label: "Templates", icon: FileText, step: 4 },
  { label: "Preview", icon: Eye, step: 5 },
  { label: "Publish", icon: Rocket, step: 6 },
]

const FONT_OPTIONS = [
  { value: "Inter", label: "Inter" },
  { value: "Merriweather", label: "Merriweather" },
  { value: "Playfair Display", label: "Playfair Display" },
  { value: "Montserrat", label: "Montserrat" },
  { value: "Lato", label: "Lato" },
  { value: "Open Sans", label: "Open Sans" },
  { value: "Raleway", label: "Raleway" },
]

const TONE_OPTIONS = [
  { value: "professional", label: "Professional" },
  { value: "friendly", label: "Friendly" },
  { value: "authoritative", label: "Authoritative" },
  { value: "conversational", label: "Conversational" },
  { value: "luxury", label: "Luxury" },
]

const FORMALITY_OPTIONS = [
  { value: "formal", label: "Formal", position: 0 },
  { value: "semi-formal", label: "Semi-Formal", position: 50 },
  { value: "casual", label: "Casual", position: 100 },
]

// ─── FETCHER ──────────────────────────────────────────────────────────────────

const fetcher = async (url: string) => {
  const res = await fetch(url)
  if (!res.ok) throw new Error("Failed to fetch")
  return res.json()
}

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────

export function BrandSetupClient({
  userId,
  brokerageId,
  brokerageName,
  brokeragePhone,
  brokerageEmail,
  agentPersonalWebsite = "",
  agentName,
  agentEmail,
  initialStatus,
}: BrandSetupClientProps) {
  const router = useRouter()
  const [activeStep, setActiveStep] = useState(initialStatus?.brandSettings?.wizard_step_reached || 1)
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)

  // Form states
  const [primaryColor, setPrimaryColor] = useState(initialStatus?.globalSettings?.primary_color || "#1e3a5f")
  const [secondaryColor, setSecondaryColor] = useState(initialStatus?.globalSettings?.secondary_color || "#f5f5f5")
  const [accentColor, setAccentColor] = useState(initialStatus?.brandSettings?.accent_color || "#3b82f6")
  const [tagline, setTagline] = useState(initialStatus?.brandSettings?.tagline || "")
  const [logoUrl, setLogoUrl] = useState(initialStatus?.globalSettings?.app_logo_url || "")
  
  const [fontFamily, setFontFamily] = useState(initialStatus?.globalSettings?.font_family || "Inter")
  const [headingSize, setHeadingSize] = useState<"small" | "medium" | "large">(
    (initialStatus?.brandSettings?.heading_size as "small" | "medium" | "large") || "medium"
  )
  const [bodyTextSize, setBodyTextSize] = useState<"small" | "medium">(
    (initialStatus?.brandSettings?.body_text_size as "small" | "medium") || "medium"
  )

  const [tone, setTone] = useState(initialStatus?.brandVoice?.tone || "professional")
  const [formalityLevel, setFormalityLevel] = useState(initialStatus?.brandVoice?.formality_level || "semi-formal")
  const [prohibitedWords, setProhibitedWords] = useState<string[]>(initialStatus?.brandVoice?.prohibited_words || [])
  const [signaturePhrases, setSignaturePhrases] = useState<string[]>(initialStatus?.brandVoice?.preferred_words || [])
  const [prohibitedInput, setProhibitedInput] = useState("")
  const [phraseInput, setPhraseInput] = useState("")
  
  const [generatedSample, setGeneratedSample] = useState("")
  const [isGenerating, setIsGenerating] = useState(false)
  
  const [signatureName, setSignatureName] = useState(agentName)
  const [signaturePhone, setSignaturePhone] = useState(brokeragePhone)
  const [signatureEmail, setSignatureEmail] = useState(agentEmail)
  // Wave 34 — agent personal website captured during onboarding. Optional
  // (many brokerages don't have a site and the agent uses their personal one).
  const [personalWebsite, setPersonalWebsite] = useState(agentPersonalWebsite)
  const [personalWebsiteSaving, setPersonalWebsiteSaving] = useState(false)
  const [personalWebsiteError, setPersonalWebsiteError] = useState<string | null>(null)
  async function savePersonalWebsite() {
    setPersonalWebsiteError(null)
    setPersonalWebsiteSaving(true)
    try {
      const { updateMyProfile } = await import("@/app/actions/user-profile")
      const r = await updateMyProfile({ personalWebsiteUrl: personalWebsite })
      if (!r.success) setPersonalWebsiteError(r.error ?? "Save failed")
    } finally {
      setPersonalWebsiteSaving(false)
    }
  }

  const [isSubmitting, setIsSubmitting] = useState(false)
  const [uploadingLogo, setUploadingLogo] = useState(false)
  const debounceRef = useRef<NodeJS.Timeout | null>(null)

  // Determine completed steps
  const completedSteps = initialStatus?.completedSteps || []

  const handleStepClick = (step: number) => {
    // Cannot advance past step 3 without brand voice
    if (step > 3 && !completedSteps.includes("voice") && !tone) {
      toast.error("Please complete Voice + Tone before continuing")
      return
    }
    // Allow backward navigation to any completed step
    if (step <= activeStep || completedSteps.length >= step - 1) {
      setActiveStep(step)
    }
  }

  // Auto-save with debounce
  const triggerAutoSave = useCallback(() => {
    setHasUnsavedChanges(true)
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
    }
    debounceRef.current = setTimeout(() => {
      setHasUnsavedChanges(false)
    }, 800)
  }, [])

  // Logo upload handler
  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    if (file.size > 5 * 1024 * 1024) {
      toast.error("File size must be less than 5MB")
      return
    }

    const allowedTypes = ["image/png", "image/svg+xml", "image/jpeg"]
    if (!allowedTypes.includes(file.type)) {
      toast.error("File must be PNG, SVG, or JPEG")
      return
    }

    setUploadingLogo(true)
    try {
      const formData = new FormData()
      formData.append("file", file)
      const result = await uploadLogo(formData)
      
      if (result.success && result.logoUrl) {
        setLogoUrl(result.logoUrl)
        toast.success("Logo uploaded successfully")
      } else {
        toast.error(result.error || "Failed to upload logo")
      }
    } catch (error) {
      console.error("Upload error:", error)
      toast.error("Failed to upload logo")
    } finally {
      setUploadingLogo(false)
    }
  }

  // Save colors
  const handleSaveColors = async () => {
    setIsSubmitting(true)
    try {
      const result = await saveBrandColors({
        primaryColor,
        secondaryColor,
        accentColor,
        tagline,
        logoUrl,
      })
      if (result.success) {
        toast.success("Colors saved successfully")
        setActiveStep(2)
      } else {
        toast.error(result.error || "Failed to save colors")
      }
    } catch (error) {
      toast.error("An error occurred")
    } finally {
      setIsSubmitting(false)
    }
  }

  // Save typography
  const handleSaveTypography = async () => {
    setIsSubmitting(true)
    try {
      const result = await saveBrandTypography({
        fontFamily,
        headingSize,
        bodyTextSize,
      })
      if (result.success) {
        toast.success("Typography saved successfully")
        setActiveStep(3)
      } else {
        toast.error(result.error || "Failed to save typography")
      }
    } catch (error) {
      toast.error("An error occurred")
    } finally {
      setIsSubmitting(false)
    }
  }

  // Save voice
  const handleSaveVoice = async () => {
    setIsSubmitting(true)
    try {
      const result = await saveBrandVoice({
        tone,
        formalityLevel,
        prohibitedWords,
        signaturePhrases,
      })
      if (result.success) {
        toast.success("Voice settings saved successfully")
        setActiveStep(4)
      } else {
        toast.error(result.error || "Failed to save voice settings")
      }
    } catch (error) {
      toast.error("An error occurred")
    } finally {
      setIsSubmitting(false)
    }
  }

  // Generate sample email
  const handleGenerateSample = async () => {
    setIsGenerating(true)
    setGeneratedSample("")
    
    try {
      // First save the current voice settings
      await saveBrandVoice({
        tone,
        formalityLevel,
        prohibitedWords,
        signaturePhrases,
      })

      const response = await fetch("/api/onboarding/brand/generate-sample", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })

      if (!response.ok) {
        throw new Error("Failed to generate sample")
      }

      const reader = response.body?.getReader()
      if (!reader) throw new Error("No reader available")

      const decoder = new TextDecoder()
      let text = ""

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        text += decoder.decode(value, { stream: true })
        setGeneratedSample(text)
      }
    } catch (error) {
      console.error("Generation error:", error)
      toast.error("Failed to generate sample email")
    } finally {
      setIsGenerating(false)
    }
  }

  // Save signature template
  const handleSaveSignature = async () => {
    setIsSubmitting(true)
    try {
      const signatureHtml = generateSignatureHtml()
      const result = await saveTemplate({
        templateName: "Default Email Signature",
        templateType: "email_signature",
        contentHtml: signatureHtml,
      })
      if (result.success) {
        toast.success("Email signature saved")
      } else {
        toast.error(result.error || "Failed to save signature")
      }
    } catch (error) {
      toast.error("An error occurred")
    } finally {
      setIsSubmitting(false)
    }
  }

  // Save letterhead template
  const handleSaveLetterhead = async () => {
    setIsSubmitting(true)
    try {
      const letterheadHtml = generateLetterheadHtml()
      const result = await saveTemplate({
        templateName: "Default Letterhead",
        templateType: "letterhead",
        contentHtml: letterheadHtml,
      })
      if (result.success) {
        toast.success("Letterhead saved")
      } else {
        toast.error(result.error || "Failed to save letterhead")
      }
    } catch (error) {
      toast.error("An error occurred")
    } finally {
      setIsSubmitting(false)
    }
  }

  // Publish brand
  const handlePublish = async () => {
    setIsSubmitting(true)
    try {
      const result = await publishBrand(brokerageId)
      if (result.success) {
        // Trigger confetti
        confetti({
          particleCount: 100,
          spread: 70,
          origin: { y: 0.6 },
        })
        toast.success("Brand published successfully!")
        setTimeout(() => {
          router.push("/dashboard/onboarding/tech-stack")
        }, 2000)
      } else {
        toast.error(result.error || "Failed to publish brand")
      }
    } catch (error) {
      toast.error("An error occurred")
    } finally {
      setIsSubmitting(false)
    }
  }

  // Generate signature HTML
  const generateSignatureHtml = () => {
    return `
      <table cellpadding="0" cellspacing="0" style="font-family: ${fontFamily}, sans-serif;">
        <tr>
          <td style="padding-right: 15px; vertical-align: top;">
            ${logoUrl ? `<img src="${logoUrl}" alt="${brokerageName}" style="width: 60px; height: auto;" />` : ""}
          </td>
          <td style="border-left: 2px solid ${primaryColor}; padding-left: 15px;">
            <p style="margin: 0; font-weight: bold; color: ${primaryColor}; font-size: 16px;">${signatureName}</p>
            <p style="margin: 4px 0 0 0; color: #666; font-size: 14px;">${brokerageName}</p>
            <p style="margin: 8px 0 0 0; font-size: 13px; color: #444;">
              ${signaturePhone ? `<span>${signaturePhone}</span>` : ""}
              ${signaturePhone && signatureEmail ? " | " : ""}
              ${signatureEmail ? `<a href="mailto:${signatureEmail}" style="color: ${accentColor};">${signatureEmail}</a>` : ""}
            </p>
            ${tagline ? `<p style="margin: 8px 0 0 0; font-style: italic; color: #888; font-size: 12px;">${tagline}</p>` : ""}
          </td>
        </tr>
      </table>
    `
  }

  // Generate letterhead HTML
  const generateLetterheadHtml = () => {
    return `
      <div style="font-family: ${fontFamily}, sans-serif; padding: 20px; border-bottom: 3px solid ${primaryColor};">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="vertical-align: middle;">
              ${logoUrl ? `<img src="${logoUrl}" alt="${brokerageName}" style="width: 120px; height: auto;" />` : ""}
            </td>
            <td style="text-align: right; vertical-align: middle;">
              <p style="margin: 0; font-weight: bold; color: ${primaryColor}; font-size: 18px;">${brokerageName}</p>
              <p style="margin: 4px 0 0 0; color: #666; font-size: 14px;">
                ${brokeragePhone ? brokeragePhone : ""}
                ${brokeragePhone && brokerageEmail ? " | " : ""}
                ${brokerageEmail ? brokerageEmail : ""}
              </p>
            </td>
          </tr>
        </table>
      </div>
    `
  }

  // Check if can publish
  const canPublish = primaryColor && logoUrl && tone

  // Get heading size class
  const getHeadingSizeClass = () => {
    switch (headingSize) {
      case "small": return "text-lg"
      case "large": return "text-2xl"
      default: return "text-xl"
    }
  }

  // Get body size class
  const getBodySizeClass = () => {
    return bodyTextSize === "small" ? "text-sm" : "text-base"
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-7xl px-4 py-8">
        {/* Header */}
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Brand Setup</h1>
            <p className="mt-2 text-muted-foreground">
              Configure your brand identity, voice, and templates
            </p>
          </div>
          {hasUnsavedChanges && (
            <Badge variant="outline" className="gap-1">
              <span className="h-2 w-2 animate-pulse rounded-full bg-orange-500" />
              Unsaved
            </Badge>
          )}
        </div>

        {/* Stepper */}
        <div className="mb-8 overflow-x-auto">
          <div className="flex items-center justify-between min-w-[700px]">
            {STEP_LABELS.map((step, index) => {
              const isCompleted = activeStep > step.step
              const isActive = activeStep === step.step
              const Icon = step.icon

              return (
                <div key={step.label} className="flex flex-1 items-center">
                  <button
                    onClick={() => handleStepClick(step.step)}
                    className={`flex flex-col items-center gap-2 ${
                      step.step <= activeStep ? "cursor-pointer" : "cursor-not-allowed opacity-50"
                    }`}
                  >
                    <div
                      className={`flex h-10 w-10 items-center justify-center rounded-full border-2 transition-colors ${
                        isCompleted
                          ? "border-primary bg-primary text-primary-foreground"
                          : isActive
                            ? "border-primary bg-background text-primary"
                            : "border-muted-foreground/30 bg-background text-muted-foreground"
                      }`}
                    >
                      {isCompleted ? <Check className="h-5 w-5" /> : <Icon className="h-5 w-5" />}
                    </div>
                    <span className={`text-xs font-medium ${isActive ? "text-foreground" : "text-muted-foreground"}`}>
                      {step.label}
                    </span>
                  </button>

                  {index < STEP_LABELS.length - 1 && (
                    <div className={`mx-2 h-0.5 flex-1 ${activeStep > step.step ? "bg-primary" : "bg-muted"}`} />
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {/* Main Content - Split Panel */}
        <div className="grid gap-6 lg:grid-cols-5">
          {/* Left Panel - Form (60%) */}
          <div className="lg:col-span-3">
            <Card>
              {/* Step 1: Colors + Logo */}
              {activeStep === 1 && (
                <>
                  <CardHeader>
                    <CardTitle>Colors + Logo</CardTitle>
                    <CardDescription>
                      Set your brand colors and upload your logo
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-6">
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div className="space-y-2">
                        <Label>Primary Color</Label>
                        <div className="flex gap-2">
                          <Input
                            type="color"
                            value={primaryColor}
                            onChange={(e) => {
                              setPrimaryColor(e.target.value)
                              triggerAutoSave()
                            }}
                            className="h-10 w-16 cursor-pointer p-1"
                          />
                          <Input
                            value={primaryColor}
                            onChange={(e) => {
                              setPrimaryColor(e.target.value)
                              triggerAutoSave()
                            }}
                            placeholder="#1e3a5f"
                            className="flex-1"
                          />
                        </div>
                      </div>
                      <div className="space-y-2">
                        <Label>Secondary Color</Label>
                        <div className="flex gap-2">
                          <Input
                            type="color"
                            value={secondaryColor}
                            onChange={(e) => {
                              setSecondaryColor(e.target.value)
                              triggerAutoSave()
                            }}
                            className="h-10 w-16 cursor-pointer p-1"
                          />
                          <Input
                            value={secondaryColor}
                            onChange={(e) => {
                              setSecondaryColor(e.target.value)
                              triggerAutoSave()
                            }}
                            placeholder="#f5f5f5"
                            className="flex-1"
                          />
                        </div>
                      </div>
                      <div className="space-y-2">
                        <Label>Accent Color (Optional)</Label>
                        <div className="flex gap-2">
                          <Input
                            type="color"
                            value={accentColor}
                            onChange={(e) => {
                              setAccentColor(e.target.value)
                              triggerAutoSave()
                            }}
                            className="h-10 w-16 cursor-pointer p-1"
                          />
                          <Input
                            value={accentColor}
                            onChange={(e) => {
                              setAccentColor(e.target.value)
                              triggerAutoSave()
                            }}
                            placeholder="#3b82f6"
                            className="flex-1"
                          />
                        </div>
                      </div>
                    </div>

                    <Separator />

                    <div className="space-y-2">
                      <Label>Logo</Label>
                      <div className="flex items-center gap-4">
                        <label
                          htmlFor="logo-upload"
                          className={`flex cursor-pointer items-center justify-center gap-2 rounded-md border-2 border-dashed p-6 transition-colors hover:border-primary ${
                            uploadingLogo ? "pointer-events-none opacity-50" : ""
                          }`}
                        >
                          {uploadingLogo ? (
                            <Loader2 className="h-5 w-5 animate-spin" />
                          ) : (
                            <Upload className="h-5 w-5" />
                          )}
                          <span className="text-sm text-muted-foreground">
                            {logoUrl ? "Replace logo" : "Upload logo (PNG, SVG, JPEG - Max 5MB)"}
                          </span>
                          <input
                            id="logo-upload"
                            type="file"
                            accept="image/png,image/svg+xml,image/jpeg"
                            onChange={handleLogoUpload}
                            className="hidden"
                            disabled={uploadingLogo}
                          />
                        </label>
                        {logoUrl && (
                          <div className="relative">
                            <img src={logoUrl} alt="Logo" className="h-16 w-auto object-contain" />
                            <button
                              onClick={() => setLogoUrl("")}
                              className="absolute -right-2 -top-2 rounded-full bg-destructive p-1 text-destructive-foreground"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label>Tagline</Label>
                        <span className="text-xs text-muted-foreground">{tagline.length}/120</span>
                      </div>
                      <Input
                        value={tagline}
                        onChange={(e) => {
                          if (e.target.value.length <= 120) {
                            setTagline(e.target.value)
                            triggerAutoSave()
                          }
                        }}
                        placeholder="Your trusted partner in real estate"
                      />
                    </div>

                    <Button onClick={handleSaveColors} className="w-full" disabled={isSubmitting}>
                      {isSubmitting ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Saving...
                        </>
                      ) : (
                        "Save & Continue"
                      )}
                    </Button>
                  </CardContent>
                </>
              )}

              {/* Step 2: Typography */}
              {activeStep === 2 && (
                <>
                  <CardHeader>
                    <CardTitle>Typography</CardTitle>
                    <CardDescription>
                      Choose your brand fonts and text sizes
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-6">
                    <div className="space-y-2">
                      <Label>Font Family</Label>
                      <Select value={fontFamily} onValueChange={(v) => { setFontFamily(v); triggerAutoSave() }}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {FONT_OPTIONS.map((font) => (
                            <SelectItem key={font.value} value={font.value}>
                              <span style={{ fontFamily: font.value }}>{font.label}</span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-2">
                      <Label>Heading Size</Label>
                      <div className="flex gap-2">
                        {(["small", "medium", "large"] as const).map((size) => (
                          <Button
                            key={size}
                            variant={headingSize === size ? "default" : "outline"}
                            onClick={() => { setHeadingSize(size); triggerAutoSave() }}
                            className="flex-1 capitalize"
                          >
                            {size}
                          </Button>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-2">
                      <Label>Body Text Size</Label>
                      <div className="flex gap-2">
                        {(["small", "medium"] as const).map((size) => (
                          <Button
                            key={size}
                            variant={bodyTextSize === size ? "default" : "outline"}
                            onClick={() => { setBodyTextSize(size); triggerAutoSave() }}
                            className="flex-1 capitalize"
                          >
                            {size}
                          </Button>
                        ))}
                      </div>
                    </div>

                    <div className="flex gap-2">
                      <Button variant="outline" onClick={() => setActiveStep(1)}>
                        Back
                      </Button>
                      <Button onClick={handleSaveTypography} className="flex-1" disabled={isSubmitting}>
                        {isSubmitting ? (
                          <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            Saving...
                          </>
                        ) : (
                          "Save & Continue"
                        )}
                      </Button>
                    </div>
                  </CardContent>
                </>
              )}

              {/* Step 3: Voice + Tone */}
              {activeStep === 3 && (
                <>
                  <CardHeader>
                    <CardTitle>Voice + Tone</CardTitle>
                    <CardDescription>
                      Define your brand&apos;s communication style
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-6">
                    <div className="space-y-2">
                      <Label>Tone</Label>
                      <Select value={tone} onValueChange={(v) => { setTone(v); triggerAutoSave() }}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {TONE_OPTIONS.map((t) => (
                            <SelectItem key={t.value} value={t.value}>
                              {t.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-3">
                      <Label>Formality Level</Label>
                      <div className="px-2">
                        <Slider
                          value={[FORMALITY_OPTIONS.find(f => f.value === formalityLevel)?.position || 50]}
                          onValueChange={([v]) => {
                            const level = FORMALITY_OPTIONS.reduce((prev, curr) => 
                              Math.abs(curr.position - v) < Math.abs(prev.position - v) ? curr : prev
                            )
                            setFormalityLevel(level.value)
                            triggerAutoSave()
                          }}
                          max={100}
                          step={50}
                          className="w-full"
                        />
                        <div className="mt-2 flex justify-between text-xs text-muted-foreground">
                          <span>Formal</span>
                          <span>Semi-Formal</span>
                          <span>Casual</span>
                        </div>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <Label>Prohibited Words (max 20)</Label>
                      <div className="flex gap-2">
                        <Input
                          value={prohibitedInput}
                          onChange={(e) => setProhibitedInput(e.target.value)}
                          placeholder="Add a word or phrase"
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && prohibitedInput.trim() && prohibitedWords.length < 20) {
                              setProhibitedWords([...prohibitedWords, prohibitedInput.trim()])
                              setProhibitedInput("")
                              triggerAutoSave()
                            }
                          }}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => {
                            if (prohibitedInput.trim() && prohibitedWords.length < 20) {
                              setProhibitedWords([...prohibitedWords, prohibitedInput.trim()])
                              setProhibitedInput("")
                              triggerAutoSave()
                            }
                          }}
                          disabled={!prohibitedInput.trim() || prohibitedWords.length >= 20}
                        >
                          Add
                        </Button>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {prohibitedWords.map((word, i) => (
                          <Badge key={i} variant="secondary" className="gap-1">
                            {word}
                            <button onClick={() => {
                              setProhibitedWords(prohibitedWords.filter((_, idx) => idx !== i))
                              triggerAutoSave()
                            }}>
                              <X className="h-3 w-3" />
                            </button>
                          </Badge>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-2">
                      <Label>Signature Phrases (max 10)</Label>
                      <div className="flex gap-2">
                        <Input
                          value={phraseInput}
                          onChange={(e) => setPhraseInput(e.target.value)}
                          placeholder="Add a signature phrase"
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && phraseInput.trim() && signaturePhrases.length < 10) {
                              setSignaturePhrases([...signaturePhrases, phraseInput.trim()])
                              setPhraseInput("")
                              triggerAutoSave()
                            }
                          }}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => {
                            if (phraseInput.trim() && signaturePhrases.length < 10) {
                              setSignaturePhrases([...signaturePhrases, phraseInput.trim()])
                              setPhraseInput("")
                              triggerAutoSave()
                            }
                          }}
                          disabled={!phraseInput.trim() || signaturePhrases.length >= 10}
                        >
                          Add
                        </Button>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {signaturePhrases.map((phrase, i) => (
                          <Badge key={i} variant="outline" className="gap-1">
                            {phrase}
                            <button onClick={() => {
                              setSignaturePhrases(signaturePhrases.filter((_, idx) => idx !== i))
                              triggerAutoSave()
                            }}>
                              <X className="h-3 w-3" />
                            </button>
                          </Badge>
                        ))}
                      </div>
                    </div>

                    <Separator />

                    <div className="space-y-3">
                      <Button
                        onClick={handleGenerateSample}
                        variant="outline"
                        className="w-full gap-2"
                        disabled={isGenerating}
                      >
                        {isGenerating ? (
                          <>
                            <Loader2 className="h-4 w-4 animate-spin" />
                            Generating...
                          </>
                        ) : (
                          <>
                            <Sparkles className="h-4 w-4" />
                            Generate Sample Email
                          </>
                        )}
                      </Button>
                      {generatedSample && (
                        <div className="rounded-md border bg-muted/50 p-4">
                          <div className="mb-2 flex items-center justify-between">
                            <span className="text-sm font-medium">Sample Email (Draft)</span>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                navigator.clipboard.writeText(generatedSample)
                                toast.success("Copied to clipboard")
                              }}
                            >
                              <Copy className="h-4 w-4" />
                            </Button>
                          </div>
                          <p className="whitespace-pre-wrap text-sm">{generatedSample}</p>
                        </div>
                      )}
                    </div>

                    <div className="flex gap-2">
                      <Button variant="outline" onClick={() => setActiveStep(2)}>
                        Back
                      </Button>
                      <Button onClick={handleSaveVoice} className="flex-1" disabled={isSubmitting}>
                        {isSubmitting ? (
                          <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            Saving...
                          </>
                        ) : (
                          "Save & Continue"
                        )}
                      </Button>
                    </div>
                  </CardContent>
                </>
              )}

              {/* Step 4: Templates */}
              {activeStep === 4 && (
                <>
                  <CardHeader>
                    <CardTitle>Templates</CardTitle>
                    <CardDescription>
                      Create your email signature and letterhead
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-6">
                    {/* Email Signature */}
                    <div className="space-y-4">
                      <h3 className="font-medium">Email Signature</h3>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <div className="space-y-2">
                          <Label>Name</Label>
                          <Input
                            value={signatureName}
                            onChange={(e) => setSignatureName(e.target.value)}
                            placeholder="Your name"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Phone</Label>
                          <Input
                            value={signaturePhone}
                            onChange={(e) => setSignaturePhone(e.target.value)}
                            placeholder="(555) 123-4567"
                          />
                        </div>
                        <div className="space-y-2 sm:col-span-2">
                          <Label>Email</Label>
                          <Input
                            value={signatureEmail}
                            onChange={(e) => setSignatureEmail(e.target.value)}
                            placeholder="you@example.com"
                          />
                        </div>
                        {/* Wave 34 — agent personal website. Optional. Saved
                            separately from the signature so blank/invalid
                            here doesn't block the brand-setup save. */}
                        <div className="space-y-2 sm:col-span-2">
                          <Label>
                            Your personal website <span className="text-xs text-gray-500">(optional — Realtor.com profile, Wix, custom domain)</span>
                          </Label>
                          <div className="flex gap-2">
                            <Input
                              type="url"
                              inputMode="url"
                              value={personalWebsite}
                              onChange={(e) => setPersonalWebsite(e.target.value)}
                              placeholder="https://your-domain.com"
                              disabled={personalWebsiteSaving}
                            />
                            <Button
                              onClick={savePersonalWebsite}
                              variant="outline"
                              size="sm"
                              disabled={personalWebsiteSaving}
                            >
                              {personalWebsiteSaving ? "Saving…" : "Save"}
                            </Button>
                          </div>
                          {personalWebsiteError && (
                            <p className="text-xs text-red-600">{personalWebsiteError}</p>
                          )}
                          <p className="text-xs text-gray-500">
                            Used as the canonical embed origin for blog posts and the byline link on your hosted articles.
                          </p>
                        </div>
                      </div>
                      <Button onClick={handleSaveSignature} variant="outline" disabled={isSubmitting}>
                        {isSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                        Save Signature
                      </Button>
                    </div>

                    <Separator />

                    {/* Letterhead */}
                    <div className="space-y-4">
                      <h3 className="font-medium">Letterhead</h3>
                      <p className="text-sm text-muted-foreground">
                        Your letterhead will include your logo and contact information with a styled header.
                      </p>
                      <Button onClick={handleSaveLetterhead} variant="outline" disabled={isSubmitting}>
                        {isSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                        Save Letterhead
                      </Button>
                    </div>

                    <div className="flex gap-2 pt-4">
                      <Button variant="outline" onClick={() => setActiveStep(3)}>
                        Back
                      </Button>
                      <Button onClick={() => setActiveStep(5)} className="flex-1">
                        Continue to Preview
                      </Button>
                    </div>
                  </CardContent>
                </>
              )}

              {/* Step 5: Preview */}
              {activeStep === 5 && (
                <>
                  <CardHeader>
                    <CardTitle>Preview</CardTitle>
                    <CardDescription>
                      Review your brand identity before publishing
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-6">
                    <p className="text-sm text-muted-foreground">
                      Take a look at the preview panel on the right to see how your brand will appear across different contexts.
                    </p>
                    
                    <div className="rounded-md border bg-muted/30 p-4">
                      <h4 className="font-medium">Brand Summary</h4>
                      <ul className="mt-2 space-y-1 text-sm">
                        <li><span className="text-muted-foreground">Primary Color:</span> {primaryColor}</li>
                        <li><span className="text-muted-foreground">Font Family:</span> {fontFamily}</li>
                        <li><span className="text-muted-foreground">Tone:</span> {tone}</li>
                        <li><span className="text-muted-foreground">Formality:</span> {formalityLevel}</li>
                        {tagline && <li><span className="text-muted-foreground">Tagline:</span> {tagline}</li>}
                      </ul>
                    </div>

                    <div className="flex gap-2">
                      <Button variant="outline" onClick={() => setActiveStep(4)}>
                        Go Back to Edit
                      </Button>
                      <Button onClick={() => setActiveStep(6)} className="flex-1">
                        Looks Great!
                      </Button>
                    </div>
                  </CardContent>
                </>
              )}

              {/* Step 6: Publish */}
              {activeStep === 6 && (
                <>
                  <CardHeader>
                    <CardTitle>Publish</CardTitle>
                    <CardDescription>
                      Finalize your brand setup
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-6">
                    <div className="space-y-3">
                      <h4 className="font-medium">Checklist</h4>
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          {primaryColor ? (
                            <Check className="h-4 w-4 text-green-500" />
                          ) : (
                            <AlertCircle className="h-4 w-4 text-amber-500" />
                          )}
                          <span className={primaryColor ? "" : "text-muted-foreground"}>
                            Colors configured
                          </span>
                          {!primaryColor && (
                            <Button variant="link" size="sm" onClick={() => setActiveStep(1)}>
                              Complete
                            </Button>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          {logoUrl ? (
                            <Check className="h-4 w-4 text-green-500" />
                          ) : (
                            <AlertCircle className="h-4 w-4 text-amber-500" />
                          )}
                          <span className={logoUrl ? "" : "text-muted-foreground"}>
                            Logo uploaded
                          </span>
                          {!logoUrl && (
                            <Button variant="link" size="sm" onClick={() => setActiveStep(1)}>
                              Complete
                            </Button>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          {tone ? (
                            <Check className="h-4 w-4 text-green-500" />
                          ) : (
                            <AlertCircle className="h-4 w-4 text-amber-500" />
                          )}
                          <span className={tone ? "" : "text-muted-foreground"}>
                            Voice + Tone set
                          </span>
                          {!tone && (
                            <Button variant="link" size="sm" onClick={() => setActiveStep(3)}>
                              Complete
                            </Button>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <Check className="h-4 w-4 text-green-500" />
                          <span>Templates saved</span>
                        </div>
                      </div>
                    </div>

                    <div className="flex gap-2">
                      <Button variant="outline" onClick={() => setActiveStep(5)}>
                        Back
                      </Button>
                      <Button
                        onClick={handlePublish}
                        className="flex-1"
                        disabled={!canPublish || isSubmitting}
                      >
                        {isSubmitting ? (
                          <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            Publishing...
                          </>
                        ) : (
                          <>
                            <Rocket className="mr-2 h-4 w-4" />
                            Publish Brand
                          </>
                        )}
                      </Button>
                    </div>
                  </CardContent>
                </>
              )}
            </Card>
          </div>

          {/* Right Panel - Live Preview (40%) */}
          <div className="lg:col-span-2">
            <Card className="sticky top-4">
              <CardHeader>
                <CardTitle className="text-lg">Live Preview</CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                {/* Color Preview */}
                <div className="space-y-2">
                  <span className="text-xs font-medium text-muted-foreground">COLORS</span>
                  <div className="flex gap-2">
                    <div
                      className="h-8 w-8 rounded-full border"
                      style={{ backgroundColor: primaryColor }}
                      title="Primary"
                    />
                    <div
                      className="h-8 w-8 rounded-full border"
                      style={{ backgroundColor: secondaryColor }}
                      title="Secondary"
                    />
                    <div
                      className="h-8 w-8 rounded-full border"
                      style={{ backgroundColor: accentColor }}
                      title="Accent"
                    />
                  </div>
                </div>

                {/* Sample Card Preview */}
                <div className="space-y-2">
                  <span className="text-xs font-medium text-muted-foreground">LISTING CARD</span>
                  <div
                    className="overflow-hidden rounded-lg border"
                    style={{ fontFamily }}
                  >
                    <div
                      className="h-2"
                      style={{ backgroundColor: primaryColor }}
                    />
                    <div className="bg-gray-100 p-2">
                      <div className="aspect-video w-full rounded bg-gray-300" />
                    </div>
                    <div className="p-3">
                      <p
                        className={`font-semibold ${getHeadingSizeClass()}`}
                        style={{ color: primaryColor }}
                      >
                        123 Main Street
                      </p>
                      <p className={`text-muted-foreground ${getBodySizeClass()}`}>
                        Anytown, ST 12345
                      </p>
                      <p
                        className="mt-2 font-bold"
                        style={{ color: accentColor }}
                      >
                        $450,000
                      </p>
                      <div className={`mt-1 flex gap-2 text-muted-foreground ${getBodySizeClass()}`}>
                        <span>3 bed</span>
                        <span>2 bath</span>
                        <span>1,800 sqft</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Email Signature Preview */}
                <div className="space-y-2">
                  <span className="text-xs font-medium text-muted-foreground">EMAIL SIGNATURE</span>
                  <div
                    className="rounded-lg border p-3"
                    style={{ fontFamily }}
                    dangerouslySetInnerHTML={{ __html: generateSignatureHtml() }}
                  />
                </div>

                {/* Business Card Preview */}
                <div className="space-y-2">
                  <span className="text-xs font-medium text-muted-foreground">BUSINESS CARD</span>
                  <div
                    className="overflow-hidden rounded-lg border"
                    style={{ fontFamily }}
                  >
                    <div
                      className="p-4"
                      style={{ backgroundColor: primaryColor }}
                    >
                      {logoUrl ? (
                        <img src={logoUrl} alt="Logo" className="h-8 w-auto object-contain brightness-0 invert" />
                      ) : (
                        <div className="h-8 w-20 rounded bg-white/20" />
                      )}
                    </div>
                    <div className="p-4" style={{ backgroundColor: secondaryColor }}>
                      <p className={`font-semibold ${getHeadingSizeClass()}`} style={{ color: primaryColor }}>
                        {signatureName || "Agent Name"}
                      </p>
                      <p className={`${getBodySizeClass()}`} style={{ color: "#666" }}>
                        {brokerageName || "Brokerage Name"}
                      </p>
                      <p className="mt-2 text-xs" style={{ color: accentColor }}>
                        {signaturePhone || "(555) 123-4567"}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Tone Preview */}
                {tone && (
                  <div className="space-y-2">
                    <span className="text-xs font-medium text-muted-foreground">VOICE</span>
                    <div className="flex flex-wrap gap-2">
                      <Badge variant="outline">{tone}</Badge>
                      <Badge variant="outline">{formalityLevel}</Badge>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}
